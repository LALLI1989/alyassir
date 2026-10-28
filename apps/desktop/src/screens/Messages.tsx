import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, CheckCheck, PenSquare } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { createThreadSchema, formatCents, type DirectoryUserDto, type ThreadDto, type ThreadSummaryDto } from "@alyassir/shared";
import {
  Badge,
  Button,
  Card,
  Checkbox,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Textarea,
  cn,
} from "@alyassir/ui";
import { asClientError } from "../adapters";
import { Field, PageHeader } from "../components/common";
import { formatDay } from "../components/insurance";
import { ErrorMessage, fieldsOf, useFieldError } from "../lib/errors";
import { formatDateTime } from "../lib/format";
import { api, useSession } from "../lib/session";

/** Edit-request threads carry a code as subject; show it in the user's language. */
function useSubject(): (subject: string, kind: string) => string {
  const { t } = useTranslation();
  return (subject, kind) => {
    const m = /^edit_request:([a-z_]+):/.exec(subject);
    if (m) return t("editRequests.threadSubject", { entity: t(`editRequests.entities.${m[1]}`, { defaultValue: m[1] }) });
    const sys = /^system:([a-z_]+)$/.exec(subject);
    if (sys) return t(`messages.events.${sys[1]}.subject`, { defaultValue: t("messages.system") });
    return kind === "system" && !subject ? t("messages.system") : subject;
  };
}

/** Automatic messages carry {event, params}; they are written out in the reader's language. */
function MessageBody({ body, system }: { body: string; system: boolean }) {
  const { t } = useTranslation();
  let parsed: { event: string; params: Record<string, unknown> } | null = null;
  if (system) {
    try {
      const v = JSON.parse(body) as unknown;
      if (v && typeof v === "object" && "event" in v && "params" in v) parsed = v as { event: string; params: Record<string, unknown> };
    } catch {
      parsed = null;
    }
  }
  if (!parsed) return <p dir="auto" className="whitespace-pre-wrap text-start text-sm">{body}</p>;
  const p = parsed.params;
  const money = (v: unknown) => (typeof v === "number" ? `${formatCents(v)} ${t("money.mad")}` : "—");
  const day = (v: unknown) => (typeof v === "string" ? (v.length > 10 ? formatDateTime(v) : formatDay(v)) : "—");
  const text = (v: unknown) => (v === null || v === undefined || v === "" ? "—" : String(v));
  let lines: [string, string][] = [];
  if (parsed.event === "payment_rejected") {
    lines = [
      [t("policies.client"), text(p.client)],
      [t("policies.number"), text(p.policyNumber)],
      [t("finance.method"), t(`finance.methods.${text(p.method)}`, { defaultValue: text(p.method) })],
      [t("finance.chequeNumber"), text(p.chequeNumber)],
      [t("finance.bank"), text(p.bank)],
      [t("finance.amount"), money(p.amountCents)],
      [t("messages.events.payment_rejected.confirmedAt"), day(p.confirmedAt)],
      [t("messages.events.payment_rejected.rejectedAt"), day(p.rejectedAt)],
      [t("messages.events.payment_rejected.bankBalance"), money(p.bankBalanceCents)],
      [t("common.reason"), text(p.reason)],
    ];
  } else if (parsed.event === "refund_needs_manager") {
    lines = [
      [t("policies.number"), text(p.policyNumber)],
      [t("finance.amount"), money(p.amountCents)],
      [t("messages.events.refund_needs_manager.employee"), text(p.employee)],
    ];
  } else if (parsed.event === "drawer_receive_difference") {
    lines = [
      [t("messages.events.common.employee"), text(p.employee)],
      [t("drawer.expected"), money(p.shownCents)],
      [t("drawer.counted"), money(p.countedCents)],
      [t("drawer.difference"), money(p.differenceCents)],
      [t("common.reason"), text(p.reason)],
    ];
  } else if (parsed.event === "drawer_close_difference" || parsed.event === "drawer_closed_on_behalf") {
    lines = [
      [t("messages.events.common.employee"), text(p.employee)],
      [t("drawer.expected"), money(p.expectedCents)],
      [t("drawer.counted"), money(p.countedCents)],
      [t("drawer.difference"), money(p.differenceCents)],
      [t("common.reason"), text(p.reason)],
    ];
  } else if (parsed.event === "expense_pending") {
    const cat = text(p.category);
    lines = [
      [t("messages.events.common.employee"), text(p.employee)],
      [t("cash.category"), t(`cash.categories.${cat}`, { defaultValue: cat })],
      [t("finance.amount"), money(p.amountCents)],
      [t("cash.note"), text(p.note)],
    ];
  } else if (parsed.event === "instalments_to_debt") {
    const items = Array.isArray(p.items) ? (p.items as Record<string, unknown>[]) : [];
    lines = items.map((x) => [`${text(x.client)} · ${text(x.policyNumber)}`, t("messages.events.instalments_to_debt.line", { seq: text(x.seq), date: day(x.dueDate), amount: money(x.amountCents) })]);
  }
  return (
    <div className="grid gap-2 text-sm">
      <p>{t(`messages.events.${parsed.event}.intro`, { defaultValue: t("messages.system") })}</p>
      <dl className="grid gap-1 rounded-md border p-3">
        {lines.map(([label, value], i) => (
          <div key={i} className="flex flex-wrap justify-between gap-3">
            <dt className="text-muted-foreground"><bdi dir="auto">{label}</bdi></dt>
            <dd><bdi dir="auto">{value}</bdi></dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function RecipientPicker({ users, selected, onChange, exclude, label }: { users: DirectoryUserDto[]; selected: string[]; onChange: (ids: string[]) => void; exclude: string[]; label: string }) {
  return (
    <fieldset className="grid gap-1.5">
      <legend className="mb-1 text-sm font-medium">{label}</legend>
      <div className="flex flex-wrap gap-3 rounded-md border p-2">
        {users.filter((u) => !exclude.includes(u.id)).map((u) => (
          <label key={u.id} className="flex items-center gap-1.5 text-sm">
            <Checkbox
              checked={selected.includes(u.id)}
              onCheckedChange={(v) => onChange(v === true ? [...selected, u.id] : selected.filter((x) => x !== u.id))}
            />
            {u.displayName}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

function Compose({ onSent, onClose }: { onSent: (id: string) => void; onClose: () => void }) {
  const { t } = useTranslation();
  const { me } = useSession();
  const fieldError = useFieldError();
  const client = useQueryClient();
  const users = (useQuery({ queryKey: ["directory"], queryFn: () => api<DirectoryUserDto[]>("GET", "/api/users/directory") }).data ?? []).filter((u) => u.id !== me?.id);
  const [to, setTo] = useState<string[]>([]);
  const [cc, setCc] = useState<string[]>([]);
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [local, setLocal] = useState<Record<string, string>>({});
  const send = useMutation({
    mutationFn: () => api<{ id: string }>("POST", "/api/messages/threads", { subject, body, to, cc }),
    onSuccess: async (r) => {
      await client.invalidateQueries({ queryKey: ["threads"] });
      onSent(r.id);
    },
  });
  function submit(e: FormEvent) {
    e.preventDefault();
    const parsed = createThreadSchema.safeParse({ subject, body, to, cc });
    const errors: Record<string, string> = {};
    if (!parsed.success) for (const i of parsed.error.issues) errors[i.path.join(".")] ??= i.message;
    setLocal(errors);
    if (!Object.keys(errors).length) send.mutate();
  }
  const server = fieldsOf(send.error ? asClientError(send.error) : null);
  const err = (k: string) => fieldError(local[k] ?? server[k]);
  return (
    <form onSubmit={submit} className="grid gap-4">
      <DialogHeader>
        <DialogTitle>{t("messages.newTitle")}</DialogTitle>
      </DialogHeader>
      <RecipientPicker users={users} selected={to} onChange={setTo} exclude={cc} label={t("messages.to")} />
      {err("to") && <p className="text-xs text-destructive">{err("to")}</p>}
      <RecipientPicker users={users} selected={cc} onChange={setCc} exclude={to} label={t("messages.cc")} />
      <Field id="subject" label={t("messages.subject")} error={err("subject")}>
        <Input id="subject" value={subject} onChange={(e) => setSubject(e.target.value)} />
      </Field>
      <Field id="body" label={t("messages.body")} error={err("body")}>
        <Textarea id="body" rows={6} value={body} onChange={(e) => setBody(e.target.value)} />
      </Field>
      {send.error && asClientError(send.error).code !== "VALIDATION" && <ErrorMessage error={asClientError(send.error)} />}
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onClose}>{t("common.cancel")}</Button>
        <Button type="submit" disabled={send.isPending}>{t("messages.send")}</Button>
      </DialogFooter>
    </form>
  );
}

function ThreadView({ id }: { id: string }) {
  const { t } = useTranslation();
  const { me } = useSession();
  const subjectOf = useSubject();
  const client = useQueryClient();
  const thread = useQuery({ queryKey: ["thread", id], queryFn: () => api<ThreadDto>("GET", `/api/messages/threads/${id}`) });
  const [reply, setReply] = useState("");
  const send = useMutation({
    mutationFn: () => api<void>("POST", `/api/messages/threads/${id}/reply`, { body: reply }),
    onSuccess: async () => {
      setReply("");
      await client.invalidateQueries({ queryKey: ["thread", id] });
      await client.invalidateQueries({ queryKey: ["threads"] });
    },
  });

  // Opening a thread marks it read for me.
  const unreadForMe = thread.data?.messages.some((m) => m.recipients.some((r) => r.userId === me?.id && !r.readAt));
  useEffect(() => {
    if (!unreadForMe) return;
    void api<void>("POST", `/api/messages/threads/${id}/read`).then(() => {
      void client.invalidateQueries({ queryKey: ["unread"] });
      void client.invalidateQueries({ queryKey: ["threads"] });
      void client.invalidateQueries({ queryKey: ["thread", id] });
    });
  }, [id, unreadForMe, client]);

  if (!thread.data) return <ErrorMessage error={thread.error ? asClientError(thread.error) : null} />;
  return (
    <div className="grid gap-3">
      <h2 className="text-lg font-semibold"><bdi>{subjectOf(thread.data.subject, thread.data.kind)}</bdi></h2>
      {thread.data.messages.map((m) => (
        <Card key={m.id} className="p-4">
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2 text-sm">
            <span className="font-semibold">{m.senderName ?? t("messages.system")}</span>
            <span className="text-muted-foreground">{formatDateTime(m.createdAt)}</span>
          </div>
          <MessageBody body={m.body} system={thread.data.kind === "system"} />
          <div className="mt-3 flex flex-wrap gap-2 text-xs text-muted-foreground">
            {m.recipients.map((r) => (
              <span key={r.userId} className="inline-flex items-center gap-1" title={r.readAt ? formatDateTime(r.readAt) : t("messages.notRead")}>
                {r.kind === "cc" ? `${t("messages.cc")}:` : `${t("messages.to")}:`} {r.displayName}
                {r.readAt ? <CheckCheck className="size-3.5 text-success" aria-label={t("messages.read")} /> : <Check className="size-3.5" aria-label={t("messages.notRead")} />}
              </span>
            ))}
          </div>
        </Card>
      ))}
      <form onSubmit={(e) => { e.preventDefault(); if (reply.trim()) send.mutate(); }} className="grid gap-2">
        <Textarea aria-label={t("messages.reply")} placeholder={t("messages.replyPlaceholder")} rows={3} value={reply} onChange={(e) => setReply(e.target.value)} />
        <ErrorMessage error={send.error ? asClientError(send.error) : null} />
        <div>
          <Button type="submit" disabled={send.isPending || !reply.trim()}>{t("messages.reply")}</Button>
        </div>
      </form>
    </div>
  );
}

export function Messages({ initialThreadId }: { initialThreadId?: string }) {
  const { t, i18n } = useTranslation();
  const listSeparator = i18n.language === "ar" ? "، " : ", ";
  const subjectOf = useSubject();
  const [selected, setSelected] = useState<string | undefined>(initialThreadId);
  const [composing, setComposing] = useState(false);
  const threads = useQuery({ queryKey: ["threads"], queryFn: () => api<ThreadSummaryDto[]>("GET", "/api/messages/threads") });
  useEffect(() => setSelected(initialThreadId), [initialThreadId]);

  return (
    <div>
      <PageHeader title={t("messages.title")} actions={<Button onClick={() => setComposing(true)}><PenSquare />{t("messages.new")}</Button>} />
      <div className="grid gap-4 lg:grid-cols-[22rem_1fr]">
        <Card className="max-h-[70vh] overflow-auto p-1">
          {(threads.data ?? []).length === 0 && <p className="p-4 text-sm text-muted-foreground">{t("messages.noThreads")}</p>}
          {(threads.data ?? []).map((th) => (
            <button
              key={th.id}
              type="button"
              onClick={() => setSelected(th.id)}
              className={cn("grid w-full gap-0.5 rounded-md px-3 py-2 text-start text-sm hover:bg-accent", selected === th.id && "bg-accent")}
            >
              <span className="flex items-center justify-between gap-2">
                <span className={cn("truncate", th.unread > 0 && "font-bold")}><bdi>{subjectOf(th.subject, th.kind)}</bdi></span>
                {th.unread > 0 && <Badge>{th.unread}</Badge>}
              </span>
              <span className="flex justify-between gap-2 text-xs text-muted-foreground">
                <span className="truncate">{th.participants.join(listSeparator)}</span>
                <span className="shrink-0">{formatDateTime(th.lastMessageAt)}</span>
              </span>
            </button>
          ))}
        </Card>
        <div>{selected ? <ThreadView id={selected} /> : <p className="text-sm text-muted-foreground">{t("messages.chooseThread")}</p>}</div>
      </div>
      <Dialog open={composing} onOpenChange={setComposing}>
        <DialogContent closeLabel={t("common.close")}>
          {composing && <Compose onClose={() => setComposing(false)} onSent={(id) => { setComposing(false); setSelected(id); }} />}
        </DialogContent>
      </Dialog>
    </div>
  );
}
