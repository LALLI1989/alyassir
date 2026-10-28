import { useQuery } from "@tanstack/react-query";
import { Printer, Trash2 } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  PAYMENT_METHODS,
  type CollectionStatusCode,
  type FinanceSetupInput,
  type InstalmentPreviewDto,
  type PaymentLineInput,
  type PaymentMethodCode,
  type ReceiptDto,
} from "@alyassir/shared";
import { Badge, Button, Dialog, DialogContent, DialogFooter, Input, Label, NativeSelect } from "@alyassir/ui";
import { formatDateTime } from "../lib/format";
import { api } from "../lib/session";
import { Field } from "./common";
import { Code, Money, MoneyInput, formatDay } from "./insurance";

const COLLECTION_VARIANT: Record<CollectionStatusCode, "success" | "warning" | "destructive" | "secondary"> = {
  paid: "success",
  in_collection: "secondary",
  outstanding: "warning",
  payment_rejected: "destructive",
};

export function CollectionBadge({ status }: { status: CollectionStatusCode | null | undefined }) {
  const { t } = useTranslation();
  if (!status) return null;
  return <Badge variant={COLLECTION_VARIANT[status]}>{t(`finance.collection.${status}`)}</Badge>;
}

/** A payment line as typed in a form (amount null while the text is not an amount). */
export interface LineDraft {
  method: PaymentMethodCode;
  amountCents: number | null;
  chequeNumber: string;
  bank: string;
  drawerName: string;
  dueDate: string;
  reference: string;
  transferDate: string;
}

export const emptyLine = (method: PaymentMethodCode = "cash"): LineDraft => ({ method, amountCents: null, chequeNumber: "", bank: "", drawerName: "", dueDate: "", reference: "", transferDate: "" });

export function toLine(d: LineDraft): PaymentLineInput {
  return {
    method: d.method,
    amountCents: d.amountCents ?? 0,
    ...(d.method === "cheque" ? { cheque: { number: d.chequeNumber, bank: d.bank, drawerName: d.drawerName, dueDate: d.dueDate } } : {}),
    ...(d.method === "transfer" ? { transfer: { reference: d.reference, bank: d.bank, transferDate: d.transferDate } } : {}),
  };
}

/** Method, amount and the details each method needs (SPEC 14.1). A card needs no detail. */
export function PaymentLineFields({ id, value, onChange, error }: { id: string; value: LineDraft; onChange: (v: LineDraft) => void; error: (k: string) => string | undefined }) {
  const { t } = useTranslation();
  const set = (patch: Partial<LineDraft>) => onChange({ ...value, ...patch });
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <Field id={`${id}-method`} label={t("finance.method")}>
        <NativeSelect id={`${id}-method`} value={value.method} onChange={(e) => set({ method: e.target.value as PaymentMethodCode })}>
          {PAYMENT_METHODS.map((m) => <option key={m} value={m}>{t(`finance.methods.${m}`)}</option>)}
        </NativeSelect>
      </Field>
      <Field id={`${id}-amount`} label={t("finance.amount")} error={error("amountCents")}>
        <MoneyInput id={`${id}-amount`} cents={value.amountCents} onChange={(c) => set({ amountCents: c })} />
      </Field>
      {value.method === "cheque" && (
        <>
          <Field id={`${id}-chq`} label={t("finance.chequeNumber")} error={error("cheque.number")}>
            <Input id={`${id}-chq`} dir="ltr" value={value.chequeNumber} onChange={(e) => set({ chequeNumber: e.target.value })} />
          </Field>
          <Field id={`${id}-bank`} label={t("finance.bank")} error={error("cheque.bank")}>
            <Input id={`${id}-bank`} dir="ltr" value={value.bank} onChange={(e) => set({ bank: e.target.value })} />
          </Field>
          <Field id={`${id}-drawer`} label={t("finance.drawerName")} error={error("cheque.drawerName")}>
            <Input id={`${id}-drawer`} dir="ltr" value={value.drawerName} onChange={(e) => set({ drawerName: e.target.value })} />
          </Field>
          <Field id={`${id}-due`} label={t("finance.chequeDue")} error={error("cheque.dueDate")}>
            <Input id={`${id}-due`} type="date" dir="ltr" value={value.dueDate} onChange={(e) => set({ dueDate: e.target.value })} />
          </Field>
        </>
      )}
      {value.method === "transfer" && (
        <>
          <Field id={`${id}-ref`} label={t("finance.reference")} error={error("transfer.reference")}>
            <Input id={`${id}-ref`} dir="ltr" value={value.reference} onChange={(e) => set({ reference: e.target.value })} />
          </Field>
          <Field id={`${id}-tbank`} label={t("finance.bank")} error={error("transfer.bank")}>
            <Input id={`${id}-tbank`} dir="ltr" value={value.bank} onChange={(e) => set({ bank: e.target.value })} />
          </Field>
          <Field id={`${id}-tdate`} label={t("finance.transferDate")} error={error("transfer.transferDate")}>
            <Input id={`${id}-tdate`} type="date" dir="ltr" value={value.transferDate} onChange={(e) => set({ transferDate: e.target.value })} />
          </Field>
        </>
      )}
    </div>
  );
}

export interface FinanceDraft {
  mode: "pay" | "instalments";
  count: 2 | 3 | 4;
  dates: string[];
  lines: LineDraft[];
}

export const emptyFinance = (): FinanceDraft => ({ mode: "pay", count: 2, dates: [], lines: [] });

export function toFinance(d: FinanceDraft): FinanceSetupInput {
  return {
    instalments: d.mode === "instalments" ? { count: d.count, dates: d.dates.slice(0, d.count).map((x) => x || null) } : null,
    payments: d.lines.map(toLine),
  };
}

/**
 * How a new period is paid (SPEC 14.4): pay now (one or more payments, the rest becomes a direct
 * debt), or instalments (2, 3 or 4, computed by the server, dates changeable only now).
 */
export function FinanceSetupFields({ value, onChange, totalCents, instalmentsAllowed, startDate, error }: {
  value: FinanceDraft;
  onChange: (v: FinanceDraft) => void;
  totalCents: number | null;
  instalmentsAllowed: boolean;
  startDate: string | null;
  error: (k: string) => string | undefined;
}) {
  const { t } = useTranslation();
  const set = (patch: Partial<FinanceDraft>) => onChange({ ...value, ...patch });
  const preview = useQuery({
    queryKey: ["instalmentsPreview", totalCents, value.count, startDate, value.dates.join(",")],
    queryFn: () => api<InstalmentPreviewDto>("POST", "/api/policies/instalments-preview", { totalAmountCents: totalCents, count: value.count, startDate, dates: value.dates.map((x) => x || null) }),
    enabled: value.mode === "instalments" && !!totalCents && totalCents > 0,
  });
  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap gap-4" role="radiogroup" aria-label={t("finance.how")}>
        {(["pay", "instalments"] as const).map((m) => (
          <label key={m} className="flex items-center gap-2 text-sm">
            <input type="radio" name="financeMode" checked={value.mode === m} disabled={m === "instalments" && !instalmentsAllowed} onChange={() => set({ mode: m })} />
            {t(`finance.modes.${m}`)}
          </label>
        ))}
      </div>
      {!instalmentsAllowed && <p className="text-xs text-muted-foreground">{t("finance.instalmentsRule")}</p>}
      {value.mode === "instalments" && (
        <div className="grid gap-3">
          <Field id="instalmentCount" label={t("finance.instalmentCount")}>
            <NativeSelect id="instalmentCount" className="max-w-40" value={value.count} onChange={(e) => set({ count: Number(e.target.value) as 2 | 3 | 4 })}>
              {[2, 3, 4].map((n) => <option key={n} value={n}>{n}</option>)}
            </NativeSelect>
          </Field>
          {preview.data && (
            <div className="grid gap-2 rounded-md border p-3 text-sm" data-testid="instalments-preview">
              {preview.data.instalments.map((x, i) => (
                <div key={x.seq} className="grid items-center gap-2 sm:grid-cols-3">
                  <span>{t("finance.instalmentN", { n: x.seq })}</span>
                  <Money cents={x.amountCents} />
                  <Input
                    type="date"
                    dir="ltr"
                    aria-label={t("finance.dueDateN", { n: x.seq })}
                    value={value.dates[i] || x.dueDate}
                    onChange={(e) => {
                      const dates = [...value.dates];
                      dates[i] = e.target.value;
                      set({ dates });
                    }}
                  />
                </div>
              ))}
              <div className="flex justify-between border-t pt-2 font-medium">
                <span>{t("finance.totalWithFees")}</span>
                <Money cents={preview.data.totalCents} />
              </div>
              <p className="text-xs text-muted-foreground">{t("finance.feeNote")}</p>
            </div>
          )}
          {error("finance") && <p className="text-xs text-destructive">{error("finance")}</p>}
        </div>
      )}
      <div className="grid gap-3">
        <div className="flex items-center justify-between">
          <span className="text-sm font-medium">{value.mode === "instalments" ? t("finance.paidNowInstalments") : t("finance.paidNow")}</span>
          <Button type="button" size="sm" variant="outline" onClick={() => set({ lines: [...value.lines, emptyLine()] })}>{t("finance.addPayment")}</Button>
        </div>
        {value.lines.map((line, i) => (
          <div key={i} className="grid gap-2 rounded-md border p-3">
            <PaymentLineFields id={`line${i}`} value={line} onChange={(l) => set({ lines: value.lines.map((x, j) => (j === i ? l : x)) })} error={(k) => error(`finance.payments.${i}.${k}`)} />
            <Button type="button" size="sm" variant="ghost" className="justify-self-end" onClick={() => set({ lines: value.lines.filter((_, j) => j !== i) })}>
              <Trash2 />
              {t("finance.removePayment")}
            </Button>
          </div>
        ))}
        {value.mode === "pay" && <p className="text-xs text-muted-foreground">{t("finance.restIsDebt")}</p>}
      </div>
    </div>
  );
}

/** Receipt A5, printable (SPEC 14.8). Shows the frozen copy kept by the server. */
export function ReceiptDialog({ receiptId, onClose }: { receiptId: string | null; onClose: () => void }) {
  const { t, i18n } = useTranslation();
  const receipt = useQuery({ queryKey: ["receipt", receiptId], queryFn: () => api<ReceiptDto>("GET", `/api/receipts/${receiptId}`), enabled: Boolean(receiptId) });
  const logo = useQuery({
    queryKey: ["settings", "logo", "receipt"],
    queryFn: () => api<{ type: string; dataBase64: string }>("GET", "/api/settings/agency/logo"),
    enabled: Boolean(receipt.data?.snapshot.agency.hasLogo),
  });
  const r = receipt.data;
  const s = r?.snapshot;
  return (
    <Dialog open={receiptId !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent closeLabel={t("common.close")} wide>
        {r && s && (
          <div className="grid gap-4">
            <div className="print-area relative grid gap-3 rounded-md border bg-white p-6 text-sm text-black" data-testid="receipt">
              {r.status === "cancelled" && (
                <span className="absolute end-6 top-6 rotate-12 rounded border-2 border-red-600 px-2 text-lg font-bold text-red-600">{t("receipt.cancelled")}</span>
              )}
              <div className="flex items-start justify-between gap-4 border-b pb-3">
                <div className="grid gap-0.5">
                  <span className="text-base font-bold">{i18n.language === "fr" ? s.agency.nameFr : s.agency.nameAr}</span>
                  {s.agency.address && <span>{s.agency.address}</span>}
                  {s.agency.phone && <bdi dir="ltr">{s.agency.phone}</bdi>}
                  {s.agency.licenseNumber && <span>{t("receipt.license", { number: s.agency.licenseNumber })}</span>}
                </div>
                {logo.data && <img src={`data:${logo.data.type};base64,${logo.data.dataBase64}`} alt="" className="max-h-16" />}
              </div>
              <div className="flex justify-between">
                <span className="text-base font-semibold">{t(`receipt.titles.${s.title}`, { defaultValue: t("receipt.titles.payment") })}</span>
                <span className="grid text-end">
                  <Code>{r.number}</Code>
                  <span>{formatDateTime(r.issuedAt)}</span>
                </span>
              </div>
              <dl className="grid grid-cols-2 gap-x-4 gap-y-1">
                <dt className="text-gray-600">{t("receipt.client")}</dt>
                <dd dir="ltr" className="text-start">{s.client.name}</dd>
                <dt className="text-gray-600">{t("receipt.identity")}</dt>
                <dd><Code>{s.client.idNumber}</Code></dd>
                {s.policy && (
                  <>
                    <dt className="text-gray-600">{t("receipt.policy")}</dt>
                    <dd><Code>{s.policy.number}</Code></dd>
                    <dt className="text-gray-600">{t("receipt.insurer")}</dt>
                    <dd dir="ltr" className="text-start">{`${s.policy.insurer} — ${s.policy.type}`}</dd>
                  </>
                )}
                {s.method && (
                  <>
                    <dt className="text-gray-600">{t("receipt.method")}</dt>
                    <dd>{t(`finance.methods.${s.method}`)}</dd>
                  </>
                )}
                {s.lines.map((l, i) => (
                  <ReceiptLineRow key={i} label={l.label} value={l.value} cents={l.cents} />
                ))}
                {s.paidCents !== null && (
                  <>
                    <dt className="font-semibold">{t("receipt.paid")}</dt>
                    <dd className="font-semibold"><Money cents={s.paidCents} /></dd>
                  </>
                )}
                {s.remainingCents !== null && (
                  <>
                    <dt className="text-gray-600">{t("receipt.remaining")}</dt>
                    <dd><Money cents={s.remainingCents} /></dd>
                  </>
                )}
                {s.paidCents === null && (
                  <>
                    <dt className="font-semibold">{t("receipt.amount")}</dt>
                    <dd className="font-semibold"><Money cents={r.amountCents} /></dd>
                  </>
                )}
              </dl>
              <div className="flex justify-between border-t pt-3 text-xs">
                <span>{t("receipt.user", { name: s.userName })}</span>
                {r.status === "cancelled" && r.cancelReason && <span>{t("receipt.cancelReason", { reason: r.cancelReason })}</span>}
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={onClose}>{t("common.close")}</Button>
              <Button onClick={() => window.print()}>
                <Printer />
                {t("receipt.print")}
              </Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function ReceiptLineRow({ label, value, cents }: { label: string; value: string; cents?: number }) {
  const { t } = useTranslation();
  const isDate = /^\d{4}-\d{2}-\d{2}$/.test(value);
  const translated = ["pay_now", "defer", "refund"].includes(value) ? t(`receipt.settlement.${value}`) : isDate ? formatDay(value) : value;
  return (
    <>
      <dt className="text-gray-600">{t(`receipt.lines.${label}`, { defaultValue: label })}</dt>
      <dd>{cents !== undefined ? <Money cents={cents} /> : <bdi dir="auto">{translated}</bdi>}</dd>
    </>
  );
}

/** Small "receipt" button that opens the printable receipt. */
export function ReceiptButton({ receiptId }: { receiptId: string | null }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState<string | null>(null);
  if (!receiptId) return null;
  return (
    <>
      <Button size="sm" variant="outline" onClick={() => setOpen(receiptId)}>
        <Printer />
        {t("receipt.open")}
      </Button>
      <ReceiptDialog receiptId={open} onClose={() => setOpen(null)} />
    </>
  );
}

export function RefundAccountField({ value, onChange }: { value: "drawer" | "safe" | "bank"; onChange: (v: "drawer" | "safe" | "bank") => void }) {
  const { t } = useTranslation();
  return (
    <div className="grid gap-1.5">
      <Label htmlFor="refundAccount">{t("finance.refundAccount")}</Label>
      <NativeSelect id="refundAccount" value={value} onChange={(e) => onChange(e.target.value as "drawer" | "safe" | "bank")}>
        {(["drawer", "safe", "bank"] as const).map((a) => <option key={a} value={a}>{t(`finance.accounts.${a}`)}</option>)}
      </NativeSelect>
    </div>
  );
}
