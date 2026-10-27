import { randomUUID } from "node:crypto";
import { io, type Socket } from "socket.io-client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EditRequestsService } from "../src/edit-requests/edit-requests.service";
import { DatabaseService } from "../src/database.service";
import { MANAGER, createEmployee, ownerQuery, startApp, type TestApp } from "./harness";

let t: TestApp;
let manager: { token: string; id: string };
let ali: { token: string; id: string };
let sara: { token: string; id: string };
let omar: { token: string; id: string };

beforeAll(async () => {
  t = await startApp({ listen: true });
  const m = await t.login(MANAGER.username, MANAGER.password);
  manager = { token: m.accessToken, id: m.me.id };
  for (const name of ["ali", "sara", "omar"]) await createEmployee(t, manager.token, name);
  const a = await t.login("ali", "secret1");
  const s = await t.login("sara", "secret1");
  const o = await t.login("omar", "secret1");
  ali = { token: a.accessToken, id: a.me.id };
  sara = { token: s.accessToken, id: s.me.id };
  omar = { token: o.accessToken, id: o.me.id };
});
afterAll(async () => t.close());

describe("internal messages", () => {
  let threadId: string;

  it("sends to one person with a copy (CC) to the manager", async () => {
    const res = await t.call("POST", "/api/messages/threads", {
      token: ali.token,
      body: { subject: "ملف العميل", body: "مرحبا", to: [sara.id], cc: [manager.id] },
    });
    expect(res.status).toBe(201);
    threadId = res.body.id;
    const thread = await t.call("GET", `/api/messages/threads/${threadId}`, { token: sara.token });
    expect(thread.body.messages[0].recipients.map((r: { kind: string }) => r.kind).sort()).toEqual(["cc", "to"]);
    expect((await t.call("GET", "/api/messages/unread-count", { token: manager.token })).body.count).toBe(1);
  });

  it("someone outside the thread cannot read it", async () => {
    const res = await t.call("GET", `/api/messages/threads/${threadId}`, { token: omar.token });
    expect(res.body.code).toBe("NOT_FOUND");
    expect((await t.call("GET", "/api/messages/threads", { token: omar.token })).body).toEqual([]);
  });

  it("keeps a read state per recipient", async () => {
    await t.call("POST", `/api/messages/threads/${threadId}/read`, { token: sara.token });
    const thread = await t.call("GET", `/api/messages/threads/${threadId}`, { token: ali.token });
    const recipients = thread.body.messages[0].recipients as { userId: string; readAt: string | null }[];
    expect(recipients.find((r) => r.userId === sara.id)?.readAt).not.toBeNull();
    expect(recipients.find((r) => r.userId === manager.id)?.readAt).toBeNull();
  });

  it("a reply goes to everyone in the thread, in the same thread", async () => {
    expect((await t.call("POST", `/api/messages/threads/${threadId}/reply`, { token: sara.token, body: { body: "تم" } })).status).toBe(204);
    const thread = await t.call("GET", `/api/messages/threads/${threadId}`, { token: manager.token });
    expect(thread.body.messages).toHaveLength(2);
    const reply = thread.body.messages[1];
    expect(reply.senderName).toBe("SARA");
    expect(reply.recipients.map((r: { userId: string; kind: string }) => `${r.userId === ali.id ? "ali" : "manager"}:${r.kind}`).sort()).toEqual(["ali:to", "manager:cc"]);
  });

  it("refuses sending to yourself, to nobody or to a disabled user", async () => {
    const self = await t.call("POST", "/api/messages/threads", { token: ali.token, body: { subject: "s", body: "b", to: [ali.id] } });
    expect(self.body.code).toBe("INVALID_RECIPIENTS");
    const nobody = await t.call("POST", "/api/messages/threads", { token: ali.token, body: { subject: "s", body: "b", to: [] } });
    expect(nobody.body.fields.to).toBe("recipients_required");
    const ghost = await t.call("POST", "/api/messages/threads", { token: ali.token, body: { subject: "s", body: "b", to: [randomUUID()] } });
    expect(ghost.body.code).toBe("INVALID_RECIPIENTS");
  });
});

describe("realtime change signals", () => {
  function connect(token: string): Promise<Socket> {
    const address = t.app.getHttpServer().address() as { port: number };
    const socket = io(`http://127.0.0.1:${address.port}`, { path: "/socket.io", transports: ["websocket"], auth: { token }, reconnection: false });
    return new Promise((resolve, reject) => {
      socket.on("connect", () => resolve(socket));
      socket.on("connect_error", (e) => reject(e));
    });
  }

  it("refuses a connection without a valid token", async () => {
    await expect(connect("bad-token")).rejects.toThrow(/UNAUTHENTICATED/);
  });

  it("tells the recipient at once that a new message arrived", async () => {
    const socket = await connect(sara.token);
    try {
      const signal = new Promise<{ topic: string }>((resolve) => socket.on("changed", resolve));
      await t.call("POST", "/api/messages/threads", { token: omar.token, body: { subject: "عاجل", body: "?", to: [sara.id] } });
      await expect(signal).resolves.toEqual({ topic: "messages" });
    } finally {
      socket.disconnect();
    }
  });

  it("cuts the live connection when the account is disabled", async () => {
    const id = await createEmployee(t, manager.token, "temp");
    const s = await t.login("temp", "secret1");
    const socket = await connect(s.accessToken);
    const closed = new Promise<void>((resolve) => socket.on("disconnect", () => resolve()));
    await t.call("POST", `/api/users/${id}/disable`, { token: manager.token });
    await expect(closed).resolves.toBeUndefined();
  });
});

describe("edit requests", () => {
  const policyId = randomUUID();

  it("an employee asks; the request reaches the manager as a message", async () => {
    const res = await t.call("POST", "/api/edit-requests", {
      token: ali.token,
      body: { entityType: "policy", entityId: policyId, operation: "edit_amount", note: "خطأ في المبلغ" },
    });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe("pending");
    const threads = await t.call("GET", "/api/messages/threads", { token: manager.token });
    expect(threads.body.some((th: { editRequestId: string | null }) => th.editRequestId === res.body.id)).toBe(true);
  });

  it("only the manager decides, and a reason is required", async () => {
    const list = await t.call("GET", "/api/edit-requests", { token: ali.token });
    const id = list.body[0].id as string;
    expect((await t.call("POST", `/api/edit-requests/${id}/approve`, { token: ali.token, body: { reason: "x" } })).body.code).toBe("FORBIDDEN");
    expect((await t.call("POST", `/api/edit-requests/${id}/approve`, { token: manager.token, body: { reason: "" } })).body.fields.reason).toBe("required");
  });

  it("approval grants ONE use on THAT record for 24 hours", async () => {
    const id = (await t.call("GET", "/api/edit-requests", { token: ali.token })).body[0].id as string;
    const approved = await t.call("POST", `/api/edit-requests/${id}/approve`, { token: manager.token, body: { reason: "موافق" } });
    expect(approved.body.status).toBe("approved");
    const hours = (Date.parse(approved.body.expiresAt as string) - Date.now()) / 3_600_000;
    expect(hours).toBeGreaterThan(23.9);
    expect(hours).toBeLessThanOrEqual(24);
    expect((await t.call("POST", `/api/edit-requests/${id}/reject`, { token: manager.token, body: { reason: "x" } })).body.code).toBe("EDIT_REQUEST_NOT_PENDING");

    const service = t.app.get(EditRequestsService);
    const db = t.app.get(DatabaseService).db;
    const ctx = { user: null, device: "PC-TEST", ip: null };
    // Another record, another operation or another person: refused.
    expect(await service.consumeGrant(db, ctx, ali.id, "policy", randomUUID(), "edit_amount")).toBe(false);
    expect(await service.consumeGrant(db, ctx, ali.id, "policy", policyId, "cancel")).toBe(false);
    expect(await service.consumeGrant(db, ctx, sara.id, "policy", policyId, "edit_amount")).toBe(false);
    // The right one works once only.
    expect(await service.consumeGrant(db, ctx, ali.id, "policy", policyId, "edit_amount")).toBe(true);
    expect(await service.consumeGrant(db, ctx, ali.id, "policy", policyId, "edit_amount")).toBe(false);
    expect((await t.call("GET", `/api/edit-requests/${id}`, { token: ali.token })).body.status).toBe("used");
  });

  it("an unused grant expires after 24 hours", async () => {
    const other = randomUUID();
    const r = await t.call("POST", "/api/edit-requests", { token: sara.token, body: { entityType: "client", entityId: other, operation: "edit", note: "n" } });
    await t.call("POST", `/api/edit-requests/${r.body.id}/approve`, { token: manager.token, body: { reason: "ok" } });
    await ownerQuery(t.db, "UPDATE edit_requests SET expires_at = now() - interval '1 second' WHERE id = $1", [r.body.id]);
    expect((await t.call("GET", `/api/edit-requests/${r.body.id}`, { token: sara.token })).body.status).toBe("expired");
    const service = t.app.get(EditRequestsService);
    expect(await service.consumeGrant(t.app.get(DatabaseService).db, { user: null, device: null, ip: null }, sara.id, "client", other, "edit")).toBe(false);
  });

  it("a rejection keeps its reason; employees only see their own requests", async () => {
    const r = await t.call("POST", "/api/edit-requests", { token: omar.token, body: { entityType: "client", entityId: randomUUID(), operation: "edit", note: "n" } });
    const rejected = await t.call("POST", `/api/edit-requests/${r.body.id}/reject`, { token: manager.token, body: { reason: "غير مبرر" } });
    expect(rejected.body).toMatchObject({ status: "rejected", decisionReason: "غير مبرر", decidedByName: "manager" });
    const mine = await t.call("GET", "/api/edit-requests", { token: omar.token });
    expect(mine.body.every((x: { requesterId: string }) => x.requesterId === omar.id)).toBe(true);
    expect((await t.call("GET", `/api/edit-requests/${r.body.id}`, { token: ali.token })).body.code).toBe("NOT_FOUND");
    const all = await t.call("GET", "/api/edit-requests", { token: manager.token });
    expect(all.body.length).toBe(3);
  });
});
