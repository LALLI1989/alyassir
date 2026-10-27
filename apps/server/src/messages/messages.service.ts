import { Inject, Injectable } from "@nestjs/common";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { schema } from "@alyassir/db";
import type { CreateThreadInput, MessageDto, ThreadDto, ThreadSummaryDto } from "@alyassir/shared";
import type { AuthUser } from "../common/context";
import { ApiException } from "../common/errors";
import { DatabaseService, type DbOrTx } from "../database.service";
import { RealtimeService } from "../realtime/realtime.service";

interface Recipient {
  userId: string;
  kind: "to" | "cc";
}

/** Internal mail (SPEC 8): To / CC, threads, per-recipient read state. No broadcast. */
@Injectable()
export class MessagesService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(RealtimeService) private readonly realtime: RealtimeService,
  ) {}

  private async assertActiveUsers(db: DbOrTx, ids: string[]): Promise<void> {
    if (!ids.length) return;
    const rows = await db
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(and(inArray(schema.users.id, ids), eq(schema.users.isActive, true)));
    if (rows.length !== new Set(ids).size) throw new ApiException("INVALID_RECIPIENTS");
  }

  /** Inserts one message with its recipients (shared by user and system messages). */
  async insertMessage(tx: DbOrTx, threadId: string, senderId: string | null, body: string, recipients: Recipient[]): Promise<string> {
    const [m] = await tx.insert(schema.messages).values({ threadId, senderId, body }).returning({ id: schema.messages.id });
    if (!m) throw new ApiException("INTERNAL");
    if (recipients.length) {
      await tx.insert(schema.messageRecipients).values(recipients.map((r) => ({ messageId: m.id, userId: r.userId, kind: r.kind })));
    }
    await tx.update(schema.messageThreads).set({ lastMessageAt: new Date() }).where(eq(schema.messageThreads.id, threadId));
    return m.id;
  }

  async createThread(
    tx: DbOrTx,
    sender: { id: string } | null,
    subject: string,
    body: string,
    recipients: Recipient[],
    options: { kind?: "user" | "system"; editRequestId?: string } = {},
  ): Promise<string> {
    const [t] = await tx
      .insert(schema.messageThreads)
      .values({
        subject,
        kind: options.kind ?? "user",
        editRequestId: options.editRequestId ?? null,
        createdBy: sender?.id ?? null,
      })
      .returning({ id: schema.messageThreads.id });
    if (!t) throw new ApiException("INTERNAL");
    await this.insertMessage(tx, t.id, sender?.id ?? null, body, recipients);
    return t.id;
  }

  /** Automatic message from the system (debt alerts, returned cheques… in later phases). */
  async sendSystem(tx: DbOrTx, toUserIds: string[], subject: string, body: string): Promise<string> {
    const id = await this.createThread(tx, null, subject, body, toUserIds.map((userId) => ({ userId, kind: "to" as const })), { kind: "system" });
    return id;
  }

  /** Notifies after commit. */
  notify(userIds: string[]): void {
    this.realtime.notifyUsers(userIds, "messages");
  }

  async send(user: AuthUser, input: CreateThreadInput): Promise<string> {
    const all = [...input.to, ...input.cc];
    if (all.includes(user.id)) throw new ApiException("INVALID_RECIPIENTS");
    const id = await this.database.db.transaction(async (tx) => {
      await this.assertActiveUsers(tx, all);
      return this.createThread(tx, user, input.subject, input.body, [
        ...input.to.map((userId) => ({ userId, kind: "to" as const })),
        ...input.cc.map((userId) => ({ userId, kind: "cc" as const })),
      ]);
    });
    this.notify(all);
    return id;
  }

  /** Everyone who wrote or received a message in the thread. */
  async participants(db: DbOrTx, threadId: string): Promise<Map<string, "to" | "cc">> {
    const res = await db.execute<{ user_id: string; kind: "to" | "cc" }>(sql`
      SELECT m.sender_id AS user_id, 'to' AS kind FROM messages m WHERE m.thread_id = ${threadId} AND m.sender_id IS NOT NULL
      UNION ALL
      SELECT r.user_id, r.kind FROM message_recipients r JOIN messages m ON m.id = r.message_id WHERE m.thread_id = ${threadId}`);
    const map = new Map<string, "to" | "cc">();
    for (const row of res.rows) {
      // "to" wins over "cc": someone who was ever a main recipient or sender stays one.
      if (row.kind === "to" || !map.has(row.user_id)) map.set(row.user_id, row.kind);
    }
    return map;
  }

  async reply(user: AuthUser, threadId: string, body: string): Promise<void> {
    const recipients = await this.database.db.transaction(async (tx) => {
      const [thread] = await tx.select().from(schema.messageThreads).where(eq(schema.messageThreads.id, threadId)).for("update");
      if (!thread) throw new ApiException("NOT_FOUND");
      const people = await this.participants(tx, threadId);
      if (!people.has(user.id)) throw new ApiException("NOT_FOUND");
      people.delete(user.id);
      const active = await tx
        .select({ id: schema.users.id })
        .from(schema.users)
        .where(and(inArray(schema.users.id, [...people.keys(), user.id]), eq(schema.users.isActive, true)));
      const activeIds = new Set(active.map((a) => a.id));
      const list = [...people].filter(([id]) => activeIds.has(id)).map(([userId, kind]) => ({ userId, kind }));
      if (!list.length) throw new ApiException("INVALID_RECIPIENTS");
      await this.insertMessage(tx, threadId, user.id, body, list);
      return list.map((r) => r.userId);
    });
    this.notify(recipients);
  }

  async listThreads(user: AuthUser): Promise<ThreadSummaryDto[]> {
    const res = await this.database.db.execute<{
      id: string;
      subject: string;
      kind: "user" | "system";
      edit_request_id: string | null;
      last_message_at: Date;
      unread: string;
      last_sender_name: string | null;
      participants: string[] | null;
    }>(sql`
      WITH mine AS (
        SELECT DISTINCT m.thread_id FROM messages m WHERE m.sender_id = ${user.id}
        UNION
        SELECT DISTINCT m.thread_id FROM message_recipients r JOIN messages m ON m.id = r.message_id WHERE r.user_id = ${user.id}
      )
      SELECT t.id, t.subject, t.kind, t.edit_request_id, t.last_message_at,
        (SELECT count(*) FROM message_recipients r JOIN messages m ON m.id = r.message_id
          WHERE m.thread_id = t.id AND r.user_id = ${user.id} AND r.read_at IS NULL) AS unread,
        (SELECT u.display_name FROM messages m LEFT JOIN users u ON u.id = m.sender_id
          WHERE m.thread_id = t.id ORDER BY m.created_at DESC LIMIT 1) AS last_sender_name,
        (SELECT array_agg(DISTINCT u.display_name) FROM users u WHERE u.id IN (
          SELECT m.sender_id FROM messages m WHERE m.thread_id = t.id
          UNION SELECT r.user_id FROM message_recipients r JOIN messages m ON m.id = r.message_id WHERE m.thread_id = t.id
        )) AS participants
      FROM message_threads t JOIN mine ON mine.thread_id = t.id
      ORDER BY t.last_message_at DESC
      LIMIT 300`);
    return res.rows.map((r) => ({
      id: r.id,
      subject: r.subject,
      kind: r.kind,
      editRequestId: r.edit_request_id,
      lastMessageAt: new Date(r.last_message_at).toISOString(),
      lastSenderName: r.last_sender_name,
      unread: Number(r.unread),
      participants: r.participants ?? [],
    }));
  }

  async getThread(user: AuthUser, threadId: string): Promise<ThreadDto> {
    const db = this.database.db;
    const [thread] = await db.select().from(schema.messageThreads).where(eq(schema.messageThreads.id, threadId));
    if (!thread) throw new ApiException("NOT_FOUND");
    const people = await this.participants(db, threadId);
    // Not a participant: the thread does not exist for this user.
    if (!people.has(user.id)) throw new ApiException("NOT_FOUND");
    const rows = await db.execute<{
      id: string;
      sender_id: string | null;
      sender_name: string | null;
      body: string;
      created_at: Date;
      recipients: { userId: string; displayName: string; kind: "to" | "cc"; readAt: string | null }[] | null;
    }>(sql`
      SELECT m.id, m.sender_id, s.display_name AS sender_name, m.body, m.created_at,
        (SELECT json_agg(json_build_object('userId', r.user_id, 'displayName', u.display_name, 'kind', r.kind, 'readAt', r.read_at) ORDER BY r.kind DESC, u.display_name)
           FROM message_recipients r JOIN users u ON u.id = r.user_id WHERE r.message_id = m.id) AS recipients
      FROM messages m LEFT JOIN users s ON s.id = m.sender_id
      WHERE m.thread_id = ${threadId}
      ORDER BY m.created_at, m.id`);
    const messages: MessageDto[] = rows.rows.map((m) => ({
      id: m.id,
      senderId: m.sender_id,
      senderName: m.sender_name,
      body: m.body,
      createdAt: new Date(m.created_at).toISOString(),
      recipients: (m.recipients ?? []).map((r) => ({ ...r, readAt: r.readAt ? new Date(r.readAt).toISOString() : null })),
    }));
    return { id: thread.id, subject: thread.subject, kind: thread.kind, editRequestId: thread.editRequestId, messages };
  }

  async markRead(user: AuthUser, threadId: string): Promise<void> {
    await this.database.db.execute(sql`
      UPDATE message_recipients r SET read_at = now()
      FROM messages m
      WHERE m.id = r.message_id AND m.thread_id = ${threadId} AND r.user_id = ${user.id} AND r.read_at IS NULL`);
    // The sender sees "read" appear.
    const people = await this.participants(this.database.db, threadId);
    this.notify([...people.keys()]);
  }

  async unreadCount(user: AuthUser): Promise<number> {
    const [row] = await this.database.db
      .select({ n: sql<number>`count(*)::int` })
      .from(schema.messageRecipients)
      .where(and(eq(schema.messageRecipients.userId, user.id), isNull(schema.messageRecipients.readAt)));
    return row?.n ?? 0;
  }
}
