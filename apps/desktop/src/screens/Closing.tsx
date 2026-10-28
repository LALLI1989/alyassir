import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import type { ClosingDto, DayDto, DrawerStateDto, Page as PageOf } from "@alyassir/shared";
import {
  Alert,
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Table,
  TBody,
  Td,
  Textarea,
  Th,
  THead,
  Tr,
} from "@alyassir/ui";
import { asClientError } from "../adapters";
import { Field, PageHeader, Pager } from "../components/common";
import { ReceiveDrawerDialog, useDrawer, useHandlesCash } from "../components/drawer";
import { Money, MoneyInput, formatDay } from "../components/insurance";
import { ErrorMessage, fieldsOf, useFieldError } from "../lib/errors";
import { formatDateTime, formatTime } from "../lib/format";
import { api, useSession } from "../lib/session";
import { useListName } from "./Expenses";

const DAY_VARIANT = { open: "secondary", closed: "success", needs_review: "warning" } as const;

/** Daily closing (SPEC 17.3): the shared session, closing it, past closings, the status of each day. */
export function Closing() {
  const { t } = useTranslation();
  const { can, isManager } = useSession();
  const handles = useHandlesCash();
  const drawer = useDrawer();
  const [receiving, setReceiving] = useState(false);
  const [closing, setClosing] = useState(false);
  const st = drawer.data;
  const canClose = st?.session && ((st.holder && can("closing.create")) || (!st.holder && can("sup.close_session_on_behalf")));
  return (
    <div className="grid gap-5">
      <PageHeader title={t("drawer.title")} intro={t("drawer.intro")} />
      {st && (
        <Card data-testid="drawer-session">
          <CardHeader className="flex-row flex-wrap items-center justify-between gap-2 space-y-0">
            <CardTitle>{st.session ? t("drawer.sessionOpen", { name: st.session.openedByName, time: formatTime(st.session.openedAt) }) : t("drawer.noSession")}</CardTitle>
            <div className="flex gap-2">
              {handles && !st.holder && <Button size="sm" variant="outline" onClick={() => setReceiving(true)}>{t("drawer.receive")}</Button>}
              {canClose && <Button size="sm" onClick={() => setClosing(true)}>{st.holder ? t("drawer.close") : t("drawer.closeOnBehalf")}</Button>}
            </div>
          </CardHeader>
          <CardContent className="grid gap-4">
            <div className="flex flex-wrap gap-3">
              <div className="grid gap-0.5 rounded-md border p-3">
                <span className="text-xs text-muted-foreground">{t("drawer.expected")}</span>
                <Money cents={st.balanceCents} className="text-lg font-bold" />
              </div>
              {st.pendingExpensesCents > 0 && (
                <div className="grid gap-0.5 rounded-md border border-warning/40 p-3">
                  <span className="text-xs text-muted-foreground">{t("drawer.pendingExpenses")}</span>
                  <Money cents={st.pendingExpensesCents} className="text-lg font-bold" />
                </div>
              )}
            </div>
            {st.session && (
              <>
                <section className="grid gap-2">
                  <h3 className="text-sm font-semibold">{t("drawer.members")}</h3>
                  <MembersTable members={st.session.members} />
                </section>
                <section className="grid gap-2">
                  <h3 className="text-sm font-semibold">{t("drawer.byUser")}</h3>
                  <p className="text-xs text-muted-foreground">{t("drawer.byUserHint")}</p>
                  <Table data-testid="drawer-by-user">
                    <THead>
                      <Tr>
                        <Th>{t("drawer.person")}</Th>
                        <Th>{t("drawer.in")}</Th>
                        <Th>{t("drawer.out")}</Th>
                      </Tr>
                    </THead>
                    <TBody>
                      {st.session.byUser.length === 0 && (
                        <Tr>
                          <Td colSpan={3} className="text-center text-muted-foreground">{t("common.empty")}</Td>
                        </Tr>
                      )}
                      {st.session.byUser.map((u) => (
                        <Tr key={u.userId ?? "system"}>
                          <Td>{u.name ?? t("messages.system")}</Td>
                          <Td><Money cents={u.inCents} /></Td>
                          <Td><Money cents={u.outCents} /></Td>
                        </Tr>
                      ))}
                    </TBody>
                  </Table>
                </section>
              </>
            )}
            {st.pendingExpenses.length > 0 && <PendingExpenses st={st} />}
          </CardContent>
        </Card>
      )}
      {can("closing.view") && <Days canReview={isManager} />}
      {can("closing.view") && <Closings />}
      {receiving && <ReceiveDrawerDialog open={receiving} onClose={() => setReceiving(false)} />}
      <Dialog open={closing} onOpenChange={setClosing}>
        <DialogContent closeLabel={t("common.close")}>{closing && st?.session && <CloseDialog st={st} onClose={() => setClosing(false)} />}</DialogContent>
      </Dialog>
    </div>
  );
}

function MembersTable({ members }: { members: ClosingDto["members"] }) {
  const { t } = useTranslation();
  return (
    <Table>
      <THead>
        <Tr>
          <Th>{t("drawer.person")}</Th>
          <Th>{t("drawer.receivedAt")}</Th>
          <Th>{t("drawer.expected")}</Th>
          <Th>{t("drawer.counted")}</Th>
          <Th>{t("drawer.difference")}</Th>
          <Th>{t("drawer.reason")}</Th>
        </Tr>
      </THead>
      <TBody>
        {members.map((m) => (
          <Tr key={m.userId}>
            <Td>{m.name}</Td>
            <Td>{formatTime(m.joinedAt)}</Td>
            <Td><Money cents={m.shownCents} /></Td>
            <Td><Money cents={m.countedCents} /></Td>
            <Td className={m.differenceCents !== 0 ? "font-semibold text-destructive" : ""}><Money cents={m.differenceCents} /></Td>
            <Td dir="auto">{m.reason}</Td>
          </Tr>
        ))}
      </TBody>
    </Table>
  );
}

function PendingExpenses({ st }: { st: DrawerStateDto }) {
  const { t } = useTranslation();
  const listName = useListName("categories");
  return (
    <section className="grid gap-2">
      <h3 className="text-sm font-semibold">{t("drawer.pendingExpenses")}</h3>
      <p className="text-xs text-muted-foreground">{t("drawer.pendingExpensesHint")}</p>
      <Table data-testid="drawer-pending-expenses">
        <TBody>
          {st.pendingExpenses.map((e) => (
            <Tr key={e.id}>
              <Td>{listName(e.category)}</Td>
              <Td>{e.createdByName}</Td>
              <Td><Money cents={e.amountCents} /></Td>
            </Tr>
          ))}
        </TBody>
      </Table>
    </section>
  );
}

function CloseDialog({ st, onClose }: { st: DrawerStateDto; onClose: () => void }) {
  const { t } = useTranslation();
  const fieldError = useFieldError();
  const queries = useQueryClient();
  const [counted, setCounted] = useState<number | null>(null);
  const [reason, setReason] = useState("");
  const [result, setResult] = useState<ClosingDto | null>(null);
  const close = useMutation({
    mutationFn: () => api<ClosingDto>("POST", "/api/drawer/close", { sessionVersion: st.session?.version, countedCents: counted, reason }),
    onSuccess: async (c) => {
      setResult(c);
      await Promise.all(["drawer", "closings", "days"].map((k) => queries.invalidateQueries({ queryKey: [k] })));
    },
  });
  const error = close.error ? asClientError(close.error) : null;
  const fields = fieldsOf(error);
  if (result) {
    return (
      <div className="grid gap-4" data-testid="closing-result">
        <DialogHeader>
          <DialogTitle>{t("drawer.closedTitle")}</DialogTitle>
        </DialogHeader>
        <dl className="grid gap-2 rounded-md border p-3 text-sm">
          <Line label={t("drawer.expected")} cents={result.expectedCents} />
          <Line label={t("drawer.counted")} cents={result.countedCents} />
          <Line label={t("drawer.difference")} cents={result.differenceCents} strong={result.differenceCents !== 0} />
        </dl>
        {result.reason && <p className="text-sm" dir="auto">{result.reason}</p>}
        <DialogFooter>
          <Button onClick={onClose}>{t("common.close")}</Button>
        </DialogFooter>
      </div>
    );
  }
  return (
    <form onSubmit={(e: FormEvent) => { e.preventDefault(); close.mutate(); }} className="grid gap-4">
      <DialogHeader>
        <DialogTitle>{st.holder ? t("drawer.close") : t("drawer.closeOnBehalf")}</DialogTitle>
        <DialogDescription>{st.holder ? t("drawer.closeInfo") : t("drawer.closeOnBehalfInfo")}</DialogDescription>
      </DialogHeader>
      <div className="flex items-center justify-between rounded-md border p-3">
        <span className="text-sm text-muted-foreground">{t("drawer.expected")}</span>
        <Money cents={st.balanceCents} className="text-lg font-bold" />
      </div>
      {st.pendingExpensesCents > 0 && (
        <Alert variant="warning">
          <span className="inline-flex flex-wrap gap-1">{t("drawer.pendingExpenses")}: <Money cents={st.pendingExpensesCents} /></span>
        </Alert>
      )}
      <Field id="closeCounted" label={t("drawer.counted")} hint={t("drawer.countedHint")} error={fieldError(fields.countedCents)}>
        <MoneyInput id="closeCounted" cents={counted} onChange={setCounted} />
      </Field>
      <Field id="closeReason" label={`${t("drawer.reason")} ${st.holder ? t("common.optional") : ""}`} hint={t("drawer.reasonHint")}>
        <Textarea id="closeReason" value={reason} onChange={(e) => setReason(e.target.value)} />
      </Field>
      {error && error.code !== "VALIDATION" && <ErrorMessage error={error} />}
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onClose}>{t("common.cancel")}</Button>
        <Button type="submit" disabled={close.isPending || counted === null}>{t("common.confirm")}</Button>
      </DialogFooter>
    </form>
  );
}

function Line({ label, cents, strong }: { label: string; cents: number; strong?: boolean }) {
  return (
    <div className="flex justify-between gap-3">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className={strong ? "font-bold text-destructive" : "font-medium"}><Money cents={cents} /></dd>
    </div>
  );
}

function Days({ canReview }: { canReview: boolean }) {
  const { t } = useTranslation();
  const days = useQuery({ queryKey: ["days"], queryFn: () => api<DayDto[]>("GET", "/api/drawer/days") });
  const [reviewing, setReviewing] = useState<{ day: DayDto; action: "approve" | "reopen" } | null>(null);
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("drawer.days")}</CardTitle>
      </CardHeader>
      <CardContent>
        <Table data-testid="days">
          <THead>
            <Tr>
              <Th>{t("common.date")}</Th>
              <Th>{t("common.status")}</Th>
              <Th>{t("drawer.closingsCount")}</Th>
              <Th>{t("drawer.lastClosed")}</Th>
              <Th />
            </Tr>
          </THead>
          <TBody>
            {days.data?.length === 0 && (
              <Tr>
                <Td colSpan={5} className="text-center text-muted-foreground">{t("common.empty")}</Td>
              </Tr>
            )}
            {days.data?.map((d) => (
              <Tr key={d.date}>
                <Td>{formatDay(d.date)}</Td>
                <Td><Badge variant={DAY_VARIANT[d.status]}>{t(`drawer.dayStatus.${d.status}`)}</Badge></Td>
                <Td>{d.closings}</Td>
                <Td>{d.lastClosedAt ? formatTime(d.lastClosedAt) : ""}</Td>
                <Td>
                  {canReview && (
                    <div className="flex justify-end gap-1">
                      {d.status === "needs_review" && <Button size="sm" onClick={() => setReviewing({ day: d, action: "approve" })}>{t("drawer.approveDay")}</Button>}
                      {d.status !== "open" && <Button size="sm" variant="outline" onClick={() => setReviewing({ day: d, action: "reopen" })}>{t("drawer.reopenDay")}</Button>}
                    </div>
                  )}
                </Td>
              </Tr>
            ))}
          </TBody>
        </Table>
      </CardContent>
      <Dialog open={reviewing !== null} onOpenChange={(o) => !o && setReviewing(null)}>
        <DialogContent closeLabel={t("common.close")}>{reviewing && <ReviewDialog day={reviewing.day} action={reviewing.action} onClose={() => setReviewing(null)} />}</DialogContent>
      </Dialog>
    </Card>
  );
}

function ReviewDialog({ day, action, onClose }: { day: DayDto; action: "approve" | "reopen"; onClose: () => void }) {
  const { t } = useTranslation();
  const fieldError = useFieldError();
  const queries = useQueryClient();
  const [reason, setReason] = useState("");
  const run = useMutation({
    mutationFn: () => api<DayDto[]>("POST", "/api/drawer/days/review", { date: day.date, action, reason }),
    onSuccess: (d) => {
      queries.setQueryData(["days"], d);
      onClose();
    },
  });
  const error = run.error ? asClientError(run.error) : null;
  const fields = fieldsOf(error);
  return (
    <form onSubmit={(e: FormEvent) => { e.preventDefault(); run.mutate(); }} className="grid gap-4">
      <DialogHeader>
        <DialogTitle>{action === "approve" ? t("drawer.approveDay") : t("drawer.reopenDay")}</DialogTitle>
        <DialogDescription>{t(action === "approve" ? "drawer.approveInfo" : "drawer.reopenInfo", { date: formatDay(day.date) })}</DialogDescription>
      </DialogHeader>
      <Field id="reviewReason" label={`${t("common.reason")} ${action === "approve" ? t("common.optional") : ""}`} error={fieldError(fields.reason)}>
        <Textarea id="reviewReason" value={reason} onChange={(e) => setReason(e.target.value)} />
      </Field>
      {error && error.code !== "VALIDATION" && <ErrorMessage error={error} />}
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onClose}>{t("common.cancel")}</Button>
        <Button type="submit" disabled={run.isPending}>{t("common.confirm")}</Button>
      </DialogFooter>
    </form>
  );
}

function Closings() {
  const { t } = useTranslation();
  const [page, setPage] = useState(1);
  const list = useQuery({
    queryKey: ["closings", page],
    queryFn: () => api<PageOf<ClosingDto>>("GET", `/api/drawer/closings?page=${page}&pageSize=10`),
    placeholderData: keepPreviousData,
  });
  const [open, setOpen] = useState<ClosingDto | null>(null);
  const data = list.data;
  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("drawer.closings")}</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-3">
        <Table data-testid="closings">
          <THead>
            <Tr>
              <Th>{t("drawer.closedAt")}</Th>
              <Th>{t("drawer.closedBy")}</Th>
              <Th>{t("drawer.expected")}</Th>
              <Th>{t("drawer.counted")}</Th>
              <Th>{t("drawer.difference")}</Th>
              <Th />
            </Tr>
          </THead>
          <TBody>
            {data?.items.length === 0 && (
              <Tr>
                <Td colSpan={6} className="text-center text-muted-foreground">{t("common.empty")}</Td>
              </Tr>
            )}
            {data?.items.map((c) => (
              <Tr key={c.id}>
                <Td>{formatDateTime(c.closedAt)}</Td>
                <Td>
                  <span className="inline-flex flex-wrap items-center gap-1">
                    {c.closedByName}
                    {c.closedOnBehalf && <Badge variant="warning">{t("drawer.onBehalf")}</Badge>}
                  </span>
                </Td>
                <Td><Money cents={c.expectedCents} /></Td>
                <Td><Money cents={c.countedCents} /></Td>
                <Td className={c.differenceCents !== 0 ? "font-semibold text-destructive" : ""}><Money cents={c.differenceCents} /></Td>
                <Td className="text-end"><Button size="sm" variant="outline" onClick={() => setOpen(c)}>{t("common.details")}</Button></Td>
              </Tr>
            ))}
          </TBody>
        </Table>
        <Pager page={page} pages={pages} total={data?.total ?? 0} onPage={setPage} />
      </CardContent>
      <Dialog open={open !== null} onOpenChange={(o) => !o && setOpen(null)}>
        <DialogContent closeLabel={t("common.close")} wide>
          {open && (
            <div className="grid gap-3">
              <DialogHeader>
                <DialogTitle>{t("drawer.closingOf", { time: formatDateTime(open.closedAt) })}</DialogTitle>
                <DialogDescription>{t("drawer.sessionOpen", { name: open.openedByName, time: formatDateTime(open.openedAt) })}</DialogDescription>
              </DialogHeader>
              <MembersTable members={open.members} />
              {open.reason && <p className="text-sm" dir="auto">{t("drawer.closeReason", { reason: open.reason })}</p>}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </Card>
  );
}
