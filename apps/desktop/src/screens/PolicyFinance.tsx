import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Wallet } from "lucide-react";
import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import type { PolicyDto, PolicyFinanceDto } from "@alyassir/shared";
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
  Th,
  THead,
  Tr,
} from "@alyassir/ui";
import { asClientError } from "../adapters";
import { CollectionBadge, PaymentLineFields, ReceiptButton, ReceiptDialog, emptyLine, toLine, type LineDraft } from "../components/finance";
import { Code, Money, formatDay, useOperationKey } from "../components/insurance";
import { ErrorMessage, fieldsOf, useFieldError } from "../lib/errors";
import { formatDateTime } from "../lib/format";
import { api, useSession } from "../lib/session";
import { PaymentStatusBadge } from "./Payments";

export function useFinance(policyId: string, enabled = true) {
  const { can } = useSession();
  return useQuery({
    queryKey: ["finance", policyId],
    queryFn: () => api<PolicyFinanceDto>("GET", `/api/policies/${policyId}/finance`),
    enabled: enabled && can("payments.view"),
  });
}

const INSTALMENT_VARIANT = { pending: "secondary", partial: "warning", paid: "success", converted_to_debt: "destructive", written_off: "outline" } as const;

/** Money of the current period: totals, instalments, payments, debts, receipts (SPEC 14). */
export function PolicyFinanceSection({ policy }: { policy: PolicyDto }) {
  const { t } = useTranslation();
  const { can } = useSession();
  const finance = useFinance(policy.id);
  const [paying, setPaying] = useState(false);
  const [receiptId, setReceiptId] = useState<string | null>(null);
  const f = finance.data;
  if (!can("payments.view")) return null;
  if (finance.error) return <ErrorMessage error={asClientError(finance.error)} />;
  if (!f) return null;
  return (
    <Card data-testid="finance">
      <CardHeader className="flex-row flex-wrap items-center justify-between gap-2 space-y-0">
        <CardTitle className="flex items-center gap-2">
          {t("finance.title")}
          <CollectionBadge status={f.collectionStatus} />
        </CardTitle>
        {can("payments.create") && f.totals.remainingCents > 0 && (
          <Button size="sm" onClick={() => setPaying(true)}>
            <Wallet />
            {t("finance.record")}
          </Button>
        )}
      </CardHeader>
      <CardContent className="grid gap-5">
        <dl className="grid gap-3 sm:grid-cols-4" data-testid="finance-totals">
          <Total label={t("finance.due")} cents={f.totals.dueCents} />
          <Total label={t("finance.paid")} cents={f.totals.paidCents} />
          <Total label={t("finance.inCollection")} cents={f.totals.inCollectionCents} />
          <Total label={t("finance.remaining")} cents={f.totals.remainingCents} strong />
        </dl>
        <p className="text-xs text-muted-foreground">{t(`finance.states.${f.paymentState}`)}</p>
        {f.clientOtherDebtCents > 0 && (
          <Alert variant="warning">
            <span className="inline-flex flex-wrap gap-1">{t("finance.clientOtherDebts")} <Money cents={f.clientOtherDebtCents} /></span>
          </Alert>
        )}

        {f.instalments.length > 0 && (
          <section className="grid gap-2">
            <h3 className="text-sm font-semibold">{t("finance.instalments")}</h3>
            <Table data-testid="instalments">
              <THead>
                <Tr>
                  <Th>#</Th>
                  <Th>{t("finance.dueDate")}</Th>
                  <Th>{t("finance.amount")}</Th>
                  <Th>{t("finance.fee")}</Th>
                  <Th>{t("finance.paid")}</Th>
                  <Th>{t("finance.remaining")}</Th>
                  <Th>{t("common.status")}</Th>
                </Tr>
              </THead>
              <TBody>
                {f.instalments.map((x) => (
                  <Tr key={x.id}>
                    <Td>{x.seq}</Td>
                    <Td>
                      <div className="grid">
                        <span>{formatDay(x.dueDate)}</span>
                        {(x.status === "pending" || x.status === "partial") && <span className="text-xs text-muted-foreground">{t("finance.debtOn", { date: formatDay(x.debtOn) })}</span>}
                      </div>
                    </Td>
                    <Td><Money cents={x.amountCents} /></Td>
                    <Td><Money cents={x.feeCents} /></Td>
                    <Td><Money cents={x.paidCents} /></Td>
                    <Td><Money cents={x.remainingCents} /></Td>
                    <Td><Badge variant={INSTALMENT_VARIANT[x.status]}>{t(`finance.instalmentStatus.${x.status}`)}</Badge></Td>
                  </Tr>
                ))}
              </TBody>
            </Table>
          </section>
        )}

        {f.debts.length > 0 && (
          <section className="grid gap-2">
            <h3 className="text-sm font-semibold">{t("finance.debts")}</h3>
            <Table data-testid="policy-debts">
              <THead>
                <Tr>
                  <Th>{t("common.date")}</Th>
                  <Th>{t("finance.source")}</Th>
                  <Th>{t("finance.amount")}</Th>
                  <Th>{t("finance.remaining")}</Th>
                  <Th>{t("common.status")}</Th>
                </Tr>
              </THead>
              <TBody>
                {f.debts.map((d) => (
                  <Tr key={d.id}>
                    <Td>{formatDay(d.debtDate)}</Td>
                    <Td>{t(`finance.debtSources.${d.source}`)}</Td>
                    <Td><Money cents={d.amountCents} /></Td>
                    <Td><Money cents={d.remainingCents} /></Td>
                    <Td><Badge variant={d.status === "open" ? "warning" : d.status === "paid" ? "success" : "outline"}>{t(`finance.debtStatus.${d.status}`)}</Badge></Td>
                  </Tr>
                ))}
              </TBody>
            </Table>
          </section>
        )}

        <section className="grid gap-2">
          <h3 className="text-sm font-semibold">{t("finance.payments")}</h3>
          {f.payments.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t("finance.noPayments")}</p>
          ) : (
            <Table data-testid="policy-payments">
              <THead>
                <Tr>
                  <Th>{t("common.date")}</Th>
                  <Th>{t("finance.method")}</Th>
                  <Th>{t("finance.amount")}</Th>
                  <Th>{t("common.status")}</Th>
                  <Th>{t("finance.receivedBy")}</Th>
                  <Th />
                </Tr>
              </THead>
              <TBody>
                {f.payments.map((x) => (
                  <Tr key={x.id}>
                    <Td>{formatDay(x.receivedOn)}</Td>
                    <Td>
                      <div className="grid">
                        <span>{t(`finance.methods.${x.method}`)}</span>
                        {x.cheque && <span className="text-xs text-muted-foreground"><Code>{x.cheque.number}</Code> · {formatDay(x.cheque.dueDate)}</span>}
                        {x.rejectReason && <span className="text-xs text-destructive">{x.rejectReason}</span>}
                      </div>
                    </Td>
                    <Td><Money cents={x.amountCents} /></Td>
                    <Td><PaymentStatusBadge status={x.status} /></Td>
                    <Td>{x.receivedByName}</Td>
                    <Td className="text-end"><ReceiptButton receiptId={x.receiptId} /></Td>
                  </Tr>
                ))}
              </TBody>
            </Table>
          )}
        </section>

        {f.receipts.length > 0 && (
          <section className="grid gap-2">
            <h3 className="text-sm font-semibold">{t("receipt.list")}</h3>
            <Table data-testid="receipts">
              <THead>
                <Tr>
                  <Th>{t("receipt.number")}</Th>
                  <Th>{t("common.date")}</Th>
                  <Th>{t("receipt.kind")}</Th>
                  <Th>{t("finance.amount")}</Th>
                  <Th />
                </Tr>
              </THead>
              <TBody>
                {f.receipts.map((r) => (
                  <Tr key={r.id}>
                    <Td><Code>{r.number}</Code></Td>
                    <Td>{formatDateTime(r.issuedAt)}</Td>
                    <Td>
                      <span className="inline-flex gap-1">
                        {t(`receipt.kinds.${r.kind}`)}
                        {r.status === "cancelled" && <Badge variant="destructive">{t("receipt.cancelled")}</Badge>}
                      </span>
                    </Td>
                    <Td><Money cents={r.amountCents} /></Td>
                    <Td className="text-end"><ReceiptButton receiptId={r.id} /></Td>
                  </Tr>
                ))}
              </TBody>
            </Table>
          </section>
        )}
      </CardContent>
      <Dialog open={paying} onOpenChange={setPaying}>
        <DialogContent closeLabel={t("common.close")} wide>
          {paying && <RecordPaymentDialog policy={policy} finance={f} onClose={() => setPaying(false)} onPaid={(id) => { setPaying(false); setReceiptId(id); }} />}
        </DialogContent>
      </Dialog>
      <ReceiptDialog receiptId={receiptId} onClose={() => setReceiptId(null)} />
    </Card>
  );
}

function Total({ label, cents, strong }: { label: string; cents: number; strong?: boolean }) {
  return (
    <div className="grid gap-0.5 rounded-md border p-3">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className={strong ? "text-lg font-bold" : "font-medium"}><Money cents={cents} /></dd>
    </div>
  );
}

/** Pay an instalment or a debt (SPEC 14.5): oldest first, never more than what is left. */
function RecordPaymentDialog({ policy, finance, onClose, onPaid }: { policy: PolicyDto; finance: PolicyFinanceDto; onClose: () => void; onPaid: (receiptId: string | null) => void }) {
  const { t } = useTranslation();
  const fieldError = useFieldError();
  const queries = useQueryClient();
  const key = useOperationKey();
  const [line, setLine] = useState<LineDraft>(emptyLine(policy.isFleet ? "cheque" : "cash"));
  const pay = useMutation({
    mutationFn: () => api<PolicyFinanceDto>("POST", `/api/policies/${policy.id}/payments`, { idempotencyKey: key, ...toLine(line) }),
    onSuccess: async (f) => {
      queries.setQueryData(["finance", policy.id], f);
      await Promise.all(["policy", "policies", "client", "payments", "debts", "drawer"].map((k) => queries.invalidateQueries({ queryKey: [k] })));
      // The receipt of this payment is the newest one.
      const latest = [...f.receipts].sort((a, b) => b.issuedAt.localeCompare(a.issuedAt) || b.number.localeCompare(a.number))[0];
      onPaid(latest?.id ?? null);
    },
  });
  const error = pay.error ? asClientError(pay.error) : null;
  const fields = fieldsOf(error);
  return (
    <form onSubmit={(e: FormEvent) => { e.preventDefault(); pay.mutate(); }} className="grid gap-4">
      <DialogHeader>
        <DialogTitle>{t("finance.recordTitle", { number: policy.policyNumber })}</DialogTitle>
        <DialogDescription>
          <span className="inline-flex flex-wrap gap-1">{t("finance.remaining")}: <Money cents={finance.totals.remainingCents} /></span>
        </DialogDescription>
      </DialogHeader>
      {policy.isFleet && <p className="text-xs text-muted-foreground">{t("finance.fleetRule")}</p>}
      <PaymentLineFields id="pay" value={line} onChange={setLine} error={(k) => fieldError(fields[k])} />
      <p className="text-xs text-muted-foreground">{t("finance.oldestFirst")}</p>
      {error && error.code !== "VALIDATION" && <ErrorMessage error={error} />}
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onClose}>{t("common.cancel")}</Button>
        <Button type="submit" disabled={pay.isPending}>{t("common.confirm")}</Button>
      </DialogFooter>
    </form>
  );
}
