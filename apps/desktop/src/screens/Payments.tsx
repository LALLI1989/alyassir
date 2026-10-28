import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Wallet } from "lucide-react";
import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import type { DebtDto, Page as PageOf, PaymentDto } from "@alyassir/shared";
import {
  Badge,
  Button,
  Card,
  CardContent,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Label,
  NativeSelect,
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
import { ReceiptButton } from "../components/finance";
import { Code, Money, formatDay } from "../components/insurance";
import { ErrorMessage, fieldsOf, useFieldError } from "../lib/errors";
import { api, useSession } from "../lib/session";
import { RecordPaymentFlow } from "./PolicyFinance";
import type { Page } from "./Shell";

const PAYMENT_VARIANT = { collected: "success", confirmed: "success", in_collection: "secondary", rejected: "destructive" } as const;

export function PaymentStatusBadge({ status }: { status: PaymentDto["status"] }) {
  const { t } = useTranslation();
  return <Badge variant={PAYMENT_VARIANT[status]}>{t(`finance.paymentStatus.${status}`)}</Badge>;
}

/** Cash in the drawer, only for who may see it (SPEC 6: drawer_balance.view). */
export function DrawerBalance() {
  const { t } = useTranslation();
  const { can } = useSession();
  const drawer = useQuery({ queryKey: ["drawer"], queryFn: () => api<{ balanceCents: number }>("GET", "/api/accounts/drawer"), enabled: can("drawer_balance.view") });
  if (!can("drawer_balance.view") || !drawer.data) return null;
  return (
    <div className="grid gap-0.5 rounded-md border px-3 py-2 text-sm" data-testid="drawer-balance">
      <span className="text-xs text-muted-foreground">{t("finance.drawerBalance")}</span>
      <Money cents={drawer.data.balanceCents} className="font-semibold" />
    </div>
  );
}

type StatusFilter = "all" | PaymentDto["status"];

/** All payments; "in collection" ones are confirmed or rejected here (SPEC 14.1). */
export function Payments({ onOpen }: { onOpen: (page: Page) => void }) {
  const { t } = useTranslation();
  const { can } = useSession();
  const [status, setStatus] = useState<StatusFilter>(can("sup.confirm_collection") ? "in_collection" : "all");
  const [page, setPage] = useState(1);
  const [acting, setActing] = useState<{ payment: PaymentDto; action: "confirm" | "reject" } | null>(null);
  const list = useQuery({
    queryKey: ["payments", status, page],
    queryFn: () => api<PageOf<PaymentDto>>("GET", `/api/payments?status=${status}&page=${page}&pageSize=25`),
    placeholderData: keepPreviousData,
  });
  const data = list.data;
  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;
  const canConfirm = can("sup.confirm_collection");
  return (
    <div>
      <PageHeader title={t("finance.paymentsTitle")} intro={t("finance.paymentsIntro")} actions={<DrawerBalance />} />
      <div className="mb-3 grid max-w-xs gap-1">
        <Label htmlFor="paymentStatus">{t("common.status")}</Label>
        <NativeSelect id="paymentStatus" value={status} onChange={(e) => { setStatus(e.target.value as StatusFilter); setPage(1); }}>
          <option value="all">{t("common.all")}</option>
          {(["in_collection", "collected", "confirmed", "rejected"] as const).map((s) => <option key={s} value={s}>{t(`finance.paymentStatus.${s}`)}</option>)}
        </NativeSelect>
      </div>
      <Card>
        <CardContent className="pt-5">
          <Table data-testid="payments">
            <THead>
              <Tr>
                <Th>{t("common.date")}</Th>
                <Th>{t("policies.client")}</Th>
                <Th>{t("policies.number")}</Th>
                <Th>{t("finance.method")}</Th>
                <Th>{t("finance.amount")}</Th>
                <Th>{t("common.status")}</Th>
                <Th />
              </Tr>
            </THead>
            <TBody>
              {data?.items.length === 0 && (
                <Tr>
                  <Td colSpan={7} className="py-8 text-center text-muted-foreground">{t("common.empty")}</Td>
                </Tr>
              )}
              {data?.items.map((x) => (
                <Tr key={x.id}>
                  <Td>{formatDay(x.receivedOn)}</Td>
                  <Td dir="auto">{x.clientName}</Td>
                  <Td>
                    <Button variant="link" className="h-auto p-0" onClick={() => onOpen({ kind: "policy", id: x.policyId })}><Code>{x.policyNumber}</Code></Button>
                  </Td>
                  <Td>
                    <div className="grid">
                      <span>{t(`finance.methods.${x.method}`)}</span>
                      {x.cheque && (
                        <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                          <Code>{x.cheque.number}</Code>
                          <bdi dir="ltr">{x.cheque.bank}</bdi>
                          {t("finance.chequeDueOn", { date: formatDay(x.cheque.dueDate) })}
                        </span>
                      )}
                      {x.transfer && <span className="text-xs text-muted-foreground"><Code>{x.transfer.reference}</Code></span>}
                      {x.dueSoon && x.status === "in_collection" && (
                        <span className="inline-flex items-center gap-1 text-xs font-medium text-warning"><AlertTriangle className="size-3" />{t("finance.dueSoon")}</span>
                      )}
                      {x.rejectReason && <span className="text-xs text-destructive">{x.rejectReason}</span>}
                    </div>
                  </Td>
                  <Td><Money cents={x.amountCents} /></Td>
                  <Td><PaymentStatusBadge status={x.status} /></Td>
                  <Td>
                    <div className="flex justify-end gap-1">
                      <ReceiptButton receiptId={x.receiptId} />
                      {canConfirm && x.status === "in_collection" && <Button size="sm" onClick={() => setActing({ payment: x, action: "confirm" })}>{t("finance.confirm")}</Button>}
                      {canConfirm && x.method !== "cash" && (x.status === "in_collection" || x.status === "confirmed") && (
                        <Button size="sm" variant="destructive" onClick={() => setActing({ payment: x, action: "reject" })}>{x.status === "confirmed" ? t("finance.bounce") : t("finance.reject")}</Button>
                      )}
                    </div>
                  </Td>
                </Tr>
              ))}
            </TBody>
          </Table>
        </CardContent>
      </Card>
      <div className="mt-3">
        <Pager page={page} pages={pages} total={data?.total ?? 0} onPage={setPage} />
      </div>
      <Dialog open={acting !== null} onOpenChange={(o) => !o && setActing(null)}>
        <DialogContent closeLabel={t("common.close")}>
          {acting && <CollectionDialog payment={acting.payment} action={acting.action} onClose={() => setActing(null)} />}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function CollectionDialog({ payment, action, onClose }: { payment: PaymentDto; action: "confirm" | "reject"; onClose: () => void }) {
  const { t } = useTranslation();
  const fieldError = useFieldError();
  const queries = useQueryClient();
  const [reason, setReason] = useState("");
  const run = useMutation({
    mutationFn: () => api<PaymentDto>("POST", `/api/payments/${payment.id}/${action}`, action === "confirm" ? { version: payment.version } : { version: payment.version, reason }),
    onSuccess: async () => {
      await Promise.all(["payments", "finance", "policy", "policies", "debts", "client"].map((k) => queries.invalidateQueries({ queryKey: [k] })));
      onClose();
    },
  });
  const error = run.error ? asClientError(run.error) : null;
  const fields = fieldsOf(error);
  return (
    <form onSubmit={(e: FormEvent) => { e.preventDefault(); run.mutate(); }} className="grid gap-4">
      <DialogHeader>
        <DialogTitle>{action === "confirm" ? t("finance.confirmTitle") : t("finance.rejectTitle")}</DialogTitle>
        <DialogDescription>{action === "confirm" ? t("finance.confirmInfo") : t("finance.rejectInfo")}</DialogDescription>
      </DialogHeader>
      <dl className="grid gap-2 rounded-lg border p-3 text-sm">
        <div className="flex justify-between gap-3"><dt className="text-muted-foreground">{t("policies.client")}</dt><dd dir="auto">{payment.clientName}</dd></div>
        <div className="flex justify-between gap-3"><dt className="text-muted-foreground">{t("policies.number")}</dt><dd><Code>{payment.policyNumber}</Code></dd></div>
        <div className="flex justify-between gap-3"><dt className="text-muted-foreground">{t("finance.method")}</dt><dd>{t(`finance.methods.${payment.method}`)}</dd></div>
        <div className="flex justify-between gap-3"><dt className="text-muted-foreground">{t("finance.amount")}</dt><dd className="font-semibold"><Money cents={payment.amountCents} /></dd></div>
      </dl>
      {action === "reject" && (
        <Field id="rejectReason" label={t("common.reason")} error={fieldError(fields.reason)}>
          <Textarea id="rejectReason" value={reason} onChange={(e) => setReason(e.target.value)} />
        </Field>
      )}
      {error && error.code !== "VALIDATION" && <ErrorMessage error={error} />}
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onClose}>{t("common.cancel")}</Button>
        <Button type="submit" variant={action === "reject" ? "destructive" : "default"} disabled={run.isPending}>{t("common.confirm")}</Button>
      </DialogFooter>
    </form>
  );
}

/** Open debts, by client (SPEC 14.6). */
export function Debts({ onOpen, clientId }: { onOpen: (page: Page) => void; clientId?: string }) {
  const { t } = useTranslation();
  const { can } = useSession();
  const [paying, setPaying] = useState<string | null>(null);
  const canPay = can("payments.create") && can("payments.view");
  const [status, setStatus] = useState<"open" | "all">("open");
  const [page, setPage] = useState(1);
  const list = useQuery({
    queryKey: ["debts", clientId ?? "", status, page],
    queryFn: () => api<PageOf<DebtDto> & { totalRemainingCents: number }>("GET", `/api/debts?status=${status}&page=${page}&pageSize=25${clientId ? `&clientId=${clientId}` : ""}`),
    placeholderData: keepPreviousData,
  });
  const data = list.data;
  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;
  const table = (
    <Table data-testid="debts">
      <THead>
        <Tr>
          <Th>{t("common.date")}</Th>
          {!clientId && <Th>{t("policies.client")}</Th>}
          <Th>{t("policies.number")}</Th>
          <Th>{t("finance.source")}</Th>
          <Th>{t("finance.amount")}</Th>
          <Th>{t("finance.remaining")}</Th>
          <Th>{t("common.status")}</Th>
          {canPay && <Th />}
        </Tr>
      </THead>
      <TBody>
        {data?.items.length === 0 && (
          <Tr>
            <Td colSpan={8} className="py-8 text-center text-muted-foreground">{t("finance.noDebts")}</Td>
          </Tr>
        )}
        {data?.items.map((d) => (
          <Tr key={d.id}>
            <Td>{formatDay(d.debtDate)}</Td>
            {!clientId && (
              <Td>
                <Button variant="link" className="h-auto p-0" onClick={() => onOpen({ kind: "client", id: d.clientId })}><span dir="auto">{d.clientName}</span></Button>
              </Td>
            )}
            <Td>{d.policyId && <Button variant="link" className="h-auto p-0" onClick={() => onOpen({ kind: "policy", id: d.policyId as string })}><Code>{d.policyNumber}</Code></Button>}</Td>
            <Td>{t(`finance.debtSources.${d.source}`)}</Td>
            <Td><Money cents={d.amountCents} /></Td>
            <Td><Money cents={d.remainingCents} /></Td>
            <Td><Badge variant={d.status === "open" ? "warning" : d.status === "paid" ? "success" : "outline"}>{t(`finance.debtStatus.${d.status}`)}</Badge></Td>
            {canPay && (
              <Td className="text-end">
                {d.status === "open" && d.policyId && (
                  <Button size="sm" onClick={() => setPaying(d.policyId)} aria-label={`${t("finance.record")} ${d.clientName}`}>
                    <Wallet />
                    {t("finance.record")}
                  </Button>
                )}
              </Td>
            )}
          </Tr>
        ))}
      </TBody>
    </Table>
  );
  const payFlow = paying && <RecordPaymentFlow key={paying} policyId={paying} onClose={() => setPaying(null)} />;
  if (clientId) {
    return (
      <div className="grid gap-2">
        <p className="inline-flex flex-wrap gap-1 text-sm font-medium" data-testid="client-debt-total">{t("finance.clientTotal")} <Money cents={data?.totalRemainingCents ?? 0} /></p>
        {table}
        {payFlow}
      </div>
    );
  }
  return (
    <div>
      <PageHeader title={t("finance.debtsTitle")} intro={t("finance.debtsIntro")} />
      <div className="mb-3 flex flex-wrap items-end gap-4">
        <div className="grid gap-1">
          <Label htmlFor="debtStatus">{t("common.status")}</Label>
          <NativeSelect id="debtStatus" value={status} onChange={(e) => { setStatus(e.target.value as "open" | "all"); setPage(1); }}>
            <option value="open">{t("finance.debtStatus.open")}</option>
            <option value="all">{t("common.all")}</option>
          </NativeSelect>
        </div>
        <p className="inline-flex gap-1 pb-2 text-sm font-medium">{t("finance.totalOpen")} <Money cents={data?.totalRemainingCents ?? 0} /></p>
      </div>
      <Card>
        <CardContent className="pt-5">{table}</CardContent>
      </Card>
      {payFlow}
      <div className="mt-3">
        <Pager page={page} pages={pages} total={data?.total ?? 0} onPage={setPage} />
      </div>
    </div>
  );
}
