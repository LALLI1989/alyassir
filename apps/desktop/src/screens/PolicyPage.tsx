import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import {
  PLATE_TYPES,
  type AmountsPreviewDto,
  type ClientFileDto,
  type DatesPreviewDto,
  type PlateType,
  type PolicyDto,
} from "@alyassir/shared";
import {
  Alert,
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Checkbox,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
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
import { asClientError, type ClientError, type RequestOptions } from "../adapters";
import { useHistorical } from "../components/historical";
import { Field, PageHeader } from "../components/common";
import { FinanceSetupFields, RefundAccountField, emptyFinance, toFinance, type FinanceDraft } from "../components/finance";
import { Code, Money, MoneyInput, ValidityBadge, formatDay, useCatalog, useLocalName, useOperationKey } from "../components/insurance";
import { ErrorMessage, fieldsOf, useFieldError } from "../lib/errors";
import { formatDateTime } from "../lib/format";
import { api, useSession } from "../lib/session";
import { ClaimsList } from "../components/followup";
import { PolicyFinanceSection, useFinance } from "./PolicyFinance";
import type { Page } from "./Shell";
import { VehicleDialog } from "./Vehicles";

type OperationKind = "renew" | "lateRenew" | "change" | "edit" | "vehicleChange" | "plateChange" | "duplicate" | "fleetAdd" | "fleetRemove" | "annul" | "cancel" | "custom";

interface DialogProps {
  policy: PolicyDto;
  onClose: () => void;
}

/** Shared frame: a form, then (optionally) a confirmation view, then the call (SPEC 15, 16: confirm before saving). */
function OperationFrame({
  title,
  description,
  path,
  body,
  form,
  summary,
  destructive,
  onClose,
  options,
  ready = true,
}: {
  title: string;
  description?: string;
  path: string;
  body: () => Record<string, unknown>;
  form: (fieldError: (k: string) => string | undefined) => ReactNode;
  /** Lines shown before confirming; null = save directly from the form. */
  summary: (() => Promise<[string, ReactNode][]>) | null;
  destructive?: boolean;
  onClose: () => void;
  /** Phase 8B: a late renewal sends its old date and the manager's reason with the request. */
  options?: () => RequestOptions | undefined;
  /** False while something the request needs is missing (the late date or reason). */
  ready?: boolean;
}) {
  const { t } = useTranslation();
  const fieldError = useFieldError();
  const queries = useQueryClient();
  const [lines, setLines] = useState<[string, ReactNode][] | null>(null);
  const [previewError, setPreviewError] = useState<ClientError | null>(null);
  const run = useMutation({
    mutationFn: () => api<PolicyDto>(path.startsWith("PATCH ") ? "PATCH" : "POST", path.replace(/^PATCH /, ""), body(), options?.()),
    onSuccess: async (p) => {
      queries.setQueryData(["policy", p.id], p);
      await queries.invalidateQueries({ queryKey: ["policy"] });
      await queries.invalidateQueries({ queryKey: ["client"] });
      await queries.invalidateQueries({ queryKey: ["policies"] });
      onClose();
    },
    onError: (e) => {
      if (asClientError(e).code === "VALIDATION") setLines(null);
    },
  });
  const error = run.error ? asClientError(run.error) : previewError;
  const fields = fieldsOf(error);
  async function next() {
    setPreviewError(null);
    if (!summary) return run.mutate();
    try {
      setLines(await summary());
    } catch (e) {
      setPreviewError(asClientError(e));
    }
  }
  return (
    <form onSubmit={(e) => { e.preventDefault(); if (lines) run.mutate(); else void next(); }} className="grid gap-4">
      <DialogHeader>
        <DialogTitle>{lines ? t("policies.confirmTitle") : title}</DialogTitle>
        {(lines || description) && <DialogDescription>{lines ? t("policies.confirmIntro") : description}</DialogDescription>}
      </DialogHeader>
      {lines ? (
        <dl className="grid gap-2 rounded-lg border p-3 text-sm" data-testid="confirm-summary">
          {lines.map(([label, value]) => (
            <div key={label} className="flex justify-between gap-3">
              <dt className="text-muted-foreground">{label}</dt>
              <dd className="font-medium">{value}</dd>
            </div>
          ))}
        </dl>
      ) : (
        form((k) => fieldError(fields[k]))
      )}
      {error && error.code !== "VALIDATION" && <ErrorMessage error={error} />}
      <DialogFooter>
        <Button type="button" variant="outline" onClick={lines ? () => setLines(null) : onClose}>{lines ? t("common.back") : t("common.cancel")}</Button>
        <Button type="submit" variant={destructive ? "destructive" : "default"} disabled={run.isPending || !ready}>
          {lines || !summary ? t("common.confirm") : t("common.continue")}
        </Button>
      </DialogFooter>
    </form>
  );
}

function ReasonField({ value, onChange, error }: { value: string; onChange: (v: string) => void; error?: string }) {
  const { t } = useTranslation();
  return (
    <Field id="opReason" label={t("common.reason")} error={error}>
      <Textarea id="opReason" value={value} onChange={(e) => onChange(e.target.value)} />
    </Field>
  );
}

function CertificateFields({ policy, values, onChange, error }: { policy: PolicyDto; values: Record<string, string>; onChange: (v: Record<string, string>) => void; error?: string }) {
  const { t } = useTranslation();
  if (!policy.vehicles.length) return null;
  return (
    <div className="grid gap-2">
      <span className="text-sm font-medium">{t("policies.newCertificates")}</span>
      {policy.vehicles.map((v) => (
        <div key={v.vehicleId} className="grid items-center gap-2 sm:grid-cols-2">
          <Label htmlFor={`cert-${v.vehicleId}`}><Code>{v.plate}</Code></Label>
          <Input id={`cert-${v.vehicleId}`} dir="ltr" value={values[v.vehicleId] ?? ""} onChange={(e) => onChange({ ...values, [v.vehicleId]: e.target.value })} />
        </div>
      ))}
      {error && <p className="text-xs text-destructive">{error}</p>}
      <p className="text-xs text-muted-foreground">{t("policies.certificateHint")}</p>
    </div>
  );
}

function DurationAndEnd({ durationId, setDurationId, start, typedEnd, setTypedEnd, endError }: { durationId: string; setDurationId: (v: string) => void; start: string | null; typedEnd: string | null; setTypedEnd: (v: string | null) => void; endError?: string }) {
  const { t } = useTranslation();
  const durations = (useCatalog().data?.durations ?? []).filter((d) => !d.archived || d.id === durationId);
  const preview = useQuery({
    queryKey: ["datesPreview", durationId, start],
    queryFn: () => api<DatesPreviewDto>("POST", "/api/policies/dates-preview", { coverageDurationId: durationId, startDate: start }),
    enabled: Boolean(durationId),
  });
  return (
    <>
      <Field id="opDuration" label={t("policies.duration")}>
        <NativeSelect id="opDuration" value={durationId} onChange={(e) => setDurationId(e.target.value)}>
          {durations.map((d) => <option key={d.id} value={d.id}>{t("policies.months", { count: d.months })}</option>)}
        </NativeSelect>
      </Field>
      <div className="flex items-center gap-2">
        <Checkbox id="opTypedEnd" checked={typedEnd !== null} onCheckedChange={(v) => setTypedEnd(v === true ? (preview.data?.endDate ?? "") : null)} />
        <Label htmlFor="opTypedEnd">{t("policies.endEdit")}</Label>
      </div>
      {typedEnd === null ? (
        <p className="text-sm">{t("policies.endComputed", { date: formatDay(preview.data?.endDate) })}</p>
      ) : (
        <Field id="opEnd" label={t("policies.end")} error={endError}>
          <Input id="opEnd" type="date" dir="ltr" value={typedEnd} onChange={(e) => setTypedEnd(e.target.value)} />
        </Field>
      )}
    </>
  );
}

function currentDurationId(policy: PolicyDto, durations: { id: string; months: number }[]): string {
  const months = policy.periods[policy.periods.length - 1]?.months;
  return durations.find((d) => d.months === months)?.id ?? durations[0]?.id ?? "";
}

function certificatesBody(policy: PolicyDto, values: Record<string, string>) {
  return policy.vehicles.map((v) => ({ vehicleId: v.vehicleId, certificateNumber: values[v.vehicleId] ?? "" }));
}

/** Pay now in cash, or add it to what the client owes (SPEC 15, 16). */
function SettlementField({ value, onChange }: { value: "pay_now" | "defer"; onChange: (v: "pay_now" | "defer") => void }) {
  const { t } = useTranslation();
  return (
    <div className="grid gap-1.5" role="radiogroup" aria-label={t("finance.settlementTitle")}>
      <span className="text-sm font-medium">{t("finance.settlementTitle")}</span>
      <div className="flex flex-wrap gap-4">
        {(["pay_now", "defer"] as const).map((v) => (
          <label key={v} className="flex items-center gap-2 text-sm">
            <input type="radio" name="settlement" checked={value === v} onChange={() => onChange(v)} />
            {t(`finance.settlement.${v}`)}
          </label>
        ))}
      </div>
      <p className="text-xs text-muted-foreground">{t("finance.settlementHint")}</p>
    </div>
  );
}

/** The manager (or a supervisor with "refunds") may take money given back from another account (SPEC 13.3). */
function useCanChooseRefund(): boolean {
  const { isManager, can } = useSession();
  return isManager || can("sup.refunds");
}

/** Renewal or change creates a new period, paid like an issue (owner decision 28/10/2026). */
function PeriodFinance({ policy, durationId, amount, start, value, onChange, err }: { policy: PolicyDto; durationId: string; amount: number | null; start: string | null; value: FinanceDraft; onChange: (v: FinanceDraft) => void; err: (k: string) => string | undefined }) {
  const { t } = useTranslation();
  const months = useCatalog().data?.durations.find((d) => d.id === durationId)?.months ?? null;
  const owed = useFinance(policy.id).data;
  // Display hint only; the server applies the rule (SPEC 14.4).
  const allowed = policy.requiresVehicle && !policy.fleet && (months === 6 || months === 12);
  const effective = !allowed && value.mode === "instalments" ? { ...value, mode: "pay" as const } : value;
  const otherDebt = owed ? owed.clientOtherDebtCents + owed.totals.remainingCents : 0;
  return (
    <div className="grid gap-3 rounded-md border p-3">
      <span className="text-sm font-semibold">{t("policies.steps.payment")}</span>
      {otherDebt > 0 && (
        <Alert variant="warning">
          <span className="inline-flex flex-wrap gap-1">{t("finance.clientOtherDebts")} <Money cents={otherDebt} /></span>
        </Alert>
      )}
      <FinanceSetupFields value={effective} onChange={onChange} totalCents={amount} instalmentsAllowed={allowed} startDate={start} error={err} />
    </div>
  );
}

// ---------------------------------------------------------------- renewal and policy change (SPEC 12)

function RenewDialog({ policy, onClose, late }: DialogProps & { late?: boolean }) {
  const { t } = useTranslation();
  const key = useOperationKey();
  const historical = useHistorical().data;
  // Phase 8B: a renewal made on paper on an old date, entered late by the manager (owner decision 29/10/2026).
  const [lateDay, setLateDay] = useState("");
  const [lateReason, setLateReason] = useState("");
  const lateReady = !late || (lateDay !== "" && lateReason.trim().length >= 3);
  const durations = useCatalog().data?.durations ?? [];
  const [start, setStart] = useState(policy.actions.nextStartDate);
  const [durationId, setDurationId] = useState(() => currentDurationId(policy, durations));
  const [typedEnd, setTypedEnd] = useState<string | null>(null);
  const [amount, setAmount] = useState<number | null>(policy.totalAmountCents);
  const [certs, setCerts] = useState<Record<string, string>>({});
  const [finance, setFinance] = useState<FinanceDraft>(emptyFinance);
  return (
    <OperationFrame
      title={t(late ? "policies.lateRenewTitle" : "policies.renewTitle", { number: policy.policyNumber })}
      description={late ? t("policies.lateRenewInfo", { start: formatDay(policy.actions.nextStartDate) }) : t("policies.renewInfo", { last: formatDay(policy.actions.renewalLastDay), start: formatDay(policy.actions.nextStartDate) })}
      path={`/api/policies/${policy.id}/renew`}
      options={() => (late ? { asOf: lateDay, lateReason: lateReason.trim() } : undefined)}
      ready={lateReady}
      body={() => ({ idempotencyKey: key, startDate: start, coverageDurationId: durationId, endDate: typedEnd, totalAmountCents: amount, certificates: policy.vehicles.length ? certificatesBody(policy, certs) : undefined, finance: toFinance(finance) })}
      summary={null}
      onClose={onClose}
      form={(err) => (
        <>
          {late && (
            <div className="grid gap-3 rounded-md border border-warning/50 bg-warning/10 p-3 sm:grid-cols-2" data-testid="late-renew">
              <Field id="lateRenewDay" label={t("policies.lateRenewDay")} hint={t("historical.lateHint")}>
                <Input id="lateRenewDay" type="date" dir="ltr" min={policy.endDate} max={historical?.today} value={lateDay} onChange={(e) => setLateDay(e.target.value)} />
              </Field>
              <Field id="lateRenewReason" label={t("historical.lateReason")}>
                <Input id="lateRenewReason" dir="auto" value={lateReason} onChange={(e) => setLateReason(e.target.value)} />
              </Field>
            </div>
          )}
          {late ? (
            <Field id="renewStart" label={t("policies.renewStart")}>
              <Input id="renewStart" dir="ltr" readOnly value={formatDay(policy.actions.nextStartDate)} />
            </Field>
          ) : (
          <Field id="renewStart" label={t("policies.renewStart")} hint={t("policies.renewStartHint", { earliest: formatDay(policy.actions.earliestStartDate) })} error={err("startDate")}>
            <NativeSelect id="renewStart" value={start} onChange={(e) => setStart(e.target.value)}>
              <option value={policy.actions.nextStartDate}>{formatDay(policy.actions.nextStartDate)}</option>
              <option value={policy.actions.earliestStartDate}>{formatDay(policy.actions.earliestStartDate)}</option>
            </NativeSelect>
          </Field>
          )}
          <DurationAndEnd durationId={durationId} setDurationId={setDurationId} start={start} typedEnd={typedEnd} setTypedEnd={setTypedEnd} endError={err("endDate")} />
          <Field id="renewAmount" label={t("policies.amount")} hint={t("policies.amountHint")} error={err("totalAmountCents")}>
            <MoneyInput id="renewAmount" cents={amount} onChange={setAmount} />
          </Field>
          <CertificateFields policy={policy} values={certs} onChange={setCerts} error={err("certificates.0.certificateNumber")} />
          <PeriodFinance policy={policy} durationId={durationId} amount={amount} start={start} value={finance} onChange={setFinance} err={err} />
        </>
      )}
    />
  );
}

function ChangeDialog({ policy, onClose }: DialogProps) {
  const { t } = useTranslation();
  const key = useOperationKey();
  const catalog = useCatalog().data;
  const types = (catalog?.types ?? []).filter((x) => !x.archived && x.requiresVehicle === policy.requiresVehicle && (!policy.fleet || x.supportsFleet));
  const [typeId, setTypeId] = useState(policy.insuranceTypeId);
  const [number, setNumber] = useState("");
  const [durationId, setDurationId] = useState(() => currentDurationId(policy, catalog?.durations ?? []));
  const [typedEnd, setTypedEnd] = useState<string | null>(null);
  const [amount, setAmount] = useState<number | null>(policy.totalAmountCents);
  const [certs, setCerts] = useState<Record<string, string>>({});
  const [finance, setFinance] = useState<FinanceDraft>(emptyFinance);
  return (
    <OperationFrame
      title={t("policies.changeTitle", { number: policy.policyNumber })}
      description={t("policies.changeInfo", { end: formatDay(policy.endDate) })}
      path={`/api/policies/${policy.id}/change`}
      body={() => ({ idempotencyKey: key, insuranceTypeId: typeId, policyNumber: number, coverageDurationId: durationId, endDate: typedEnd, totalAmountCents: amount, certificates: certificatesBody(policy, certs), finance: toFinance(finance) })}
      summary={null}
      onClose={onClose}
      form={(err) => (
        <>
          <Field id="changeType" label={t("policies.type")}>
            <NativeSelect id="changeType" value={typeId} onChange={(e) => setTypeId(e.target.value)}>
              {types.map((x) => <option key={x.id} value={x.id}>{`${x.insurerName} — ${x.name}`}</option>)}
            </NativeSelect>
          </Field>
          <Field id="changeNumber" label={t("policies.number")} hint={t("policies.numberHint")} error={err("policyNumber")}>
            <Input id="changeNumber" dir="ltr" value={number} onChange={(e) => setNumber(e.target.value)} />
          </Field>
          <DurationAndEnd durationId={durationId} setDurationId={setDurationId} start={null} typedEnd={typedEnd} setTypedEnd={setTypedEnd} endError={err("endDate")} />
          <Field id="changeAmount" label={t("policies.amount")} error={err("totalAmountCents")}>
            <MoneyInput id="changeAmount" cents={amount} onChange={setAmount} />
          </Field>
          <CertificateFields policy={policy} values={certs} onChange={setCerts} error={err("certificates.0.certificateNumber")} />
          <PeriodFinance policy={policy} durationId={durationId} amount={amount} start={null} value={finance} onChange={setFinance} err={err} />
        </>
      )}
    />
  );
}

// ---------------------------------------------------------------- edit (SPEC 11.5)

function EditDialog({ policy, onClose }: DialogProps) {
  const { t } = useTranslation();
  const catalog = useCatalog().data;
  const types = (catalog?.types ?? []).filter((x) => x.insurerId === policy.insurerId && x.requiresVehicle === policy.requiresVehicle && (!policy.fleet || x.supportsFleet) && (!x.archived || x.id === policy.insuranceTypeId));
  const last = policy.periods[policy.periods.length - 1];
  const [number, setNumber] = useState(policy.policyNumber);
  const [typeId, setTypeId] = useState(policy.insuranceTypeId);
  const [end, setEnd] = useState(policy.endDate);
  const [amount, setAmount] = useState<number | null>(last?.totalAmountCents ?? null);
  const [reason, setReason] = useState("");
  return (
    <OperationFrame
      title={t("policies.editTitle", { number: policy.policyNumber })}
      path={`PATCH /api/policies/${policy.id}`}
      body={() => ({ version: policy.version, policyNumber: number, insuranceTypeId: typeId, endDate: end, totalAmountCents: amount ?? undefined, reason })}
      summary={null}
      onClose={onClose}
      form={(err) => (
        <>
          <Field id="editNumber" label={t("policies.number")} error={err("policyNumber")}>
            <Input id="editNumber" dir="ltr" value={number} onChange={(e) => setNumber(e.target.value)} />
          </Field>
          <Field id="editType" label={t("policies.type")}>
            <NativeSelect id="editType" value={typeId} onChange={(e) => setTypeId(e.target.value)}>
              {types.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
            </NativeSelect>
          </Field>
          <Field id="editEnd" label={t("policies.end")} error={err("endDate")}>
            <Input id="editEnd" type="date" dir="ltr" value={end} onChange={(e) => setEnd(e.target.value)} />
          </Field>
          <Field
            id="editAmount"
            label={t("policies.amount")}
            hint={policy.actions.amountLocked ? `${t("policies.amountLocked", { time: formatDateTime(policy.actions.amountLockedAt) })} ${t("policies.amountLockedHint")}` : t("policies.amountFreeUntil", { time: formatDateTime(policy.actions.amountLockedAt) })}
            error={err("totalAmountCents")}
          >
            <MoneyInput id="editAmount" cents={amount} onChange={setAmount} />
          </Field>
          <Field id="editReason" label={`${t("policies.editReason")} ${policy.actions.amountLocked ? "" : t("common.optional")}`} error={err("reason")}>
            <Textarea id="editReason" value={reason} onChange={(e) => setReason(e.target.value)} />
          </Field>
        </>
      )}
    />
  );
}

// ---------------------------------------------------------------- vehicle operations (SPEC 15, 16, 16.1, 9.3)

function useClientVehicles(clientId: string) {
  return useQuery({ queryKey: ["client", clientId], queryFn: () => api<ClientFileDto>("GET", `/api/clients/${clientId}`) }).data?.vehicles ?? [];
}

function NetLine({ preview }: { preview: AmountsPreviewDto }) {
  const { t } = useTranslation();
  const abs = Math.abs(preview.netCents);
  // Display only: the sign tells who pays; the number comes from the server.
  return (
    <span className="inline-flex gap-1">
      {preview.netCents >= 0 ? t("policies.clientPays") : t("policies.clientReceives")}
      <Money cents={abs} />
    </span>
  );
}

function VehicleChangeDialog({ policy, onClose }: DialogProps) {
  const { t } = useTranslation();
  const key = useOperationKey();
  const vehicles = useClientVehicles(policy.clientId);
  const candidates = vehicles.filter((v) => !v.archived && !v.activePolicyId);
  const [oldId, setOldId] = useState(policy.vehicles[0]?.vehicleId ?? "");
  const [newId, setNewId] = useState("");
  const [certificate, setCertificate] = useState("");
  const [oldPrice, setOldPrice] = useState<number | null>(policy.isFleet ? null : policy.totalAmountCents);
  const [newPrice, setNewPrice] = useState<number | null>(policy.isFleet ? null : policy.totalAmountCents);
  const [reason, setReason] = useState("");
  const [receipt, setReceipt] = useState("");
  const [adding, setAdding] = useState(false);
  const [settlement, setSettlement] = useState<"pay_now" | "defer">("pay_now");
  const [account, setAccount] = useState<"drawer" | "safe" | "bank">("drawer");
  const canChoose = useCanChooseRefund();
  const plate = (id: string) => vehicles.find((v) => v.id === id)?.plate ?? "";
  return (
    <>
      <OperationFrame
        title={t("policies.vehicleChangeTitle", { number: policy.policyNumber })}
        path={`/api/policies/${policy.id}/vehicle-change`}
        body={() => ({ idempotencyKey: key, oldVehicleId: oldId, newVehicleId: newId, certificateNumber: certificate, oldPriceCents: oldPrice, newPriceCents: newPrice, reason, paperReceiptNo: receipt, settlement, refundAccount: account })}
        summary={async () => {
          const p = await api<AmountsPreviewDto>("POST", "/api/policies/vehicle-change-preview", { oldPriceCents: oldPrice, newPriceCents: newPrice });
          return [
            [t("policies.number"), <Code key="n">{policy.policyNumber}</Code>],
            [t("policies.oldVehicle"), <Code key="o">{plate(oldId)}</Code>],
            [t("policies.newVehicle"), <Code key="v">{plate(newId)}</Code>],
            [t("policies.newCertificate"), <Code key="c">{certificate}</Code>],
            [t("policies.difference"), <Money key="d" cents={p.differenceCents} />],
            [t("policies.fee"), <Money key="f" cents={p.feeCents} />],
            [t("policies.net"), <NetLine key="t" preview={p} />],
            ...(p.netCents > 0 ? [[t("finance.settlementTitle"), t(`finance.settlement.${settlement}`)] as [string, ReactNode]] : []),
            ...(p.netCents < 0 ? [[t("finance.refundTitle"), t("finance.refundAgainstDues", { account: t(`finance.accounts.${account}`) })] as [string, ReactNode]] : []),
          ];
        }}
        onClose={onClose}
        form={(err) => (
          <>
            <Field id="vcOld" label={t("policies.oldVehicle")}>
              <NativeSelect id="vcOld" value={oldId} onChange={(e) => setOldId(e.target.value)}>
                {policy.vehicles.map((v) => <option key={v.vehicleId} value={v.vehicleId}>{v.plate}</option>)}
              </NativeSelect>
            </Field>
            <Field id="vcNew" label={t("policies.newVehicle")}>
              <div className="flex gap-2">
                <NativeSelect id="vcNew" value={newId} onChange={(e) => setNewId(e.target.value)}>
                  <option value="" />
                  {candidates.map((v) => <option key={v.id} value={v.id}>{`${v.plate} — ${v.brand}`}</option>)}
                </NativeSelect>
                <Button type="button" variant="outline" onClick={() => setAdding(true)}>{t("common.add")}</Button>
              </div>
            </Field>
            <Field id="vcCert" label={t("policies.newCertificate")} hint={t("policies.certificateHint")} error={err("certificateNumber")}>
              <Input id="vcCert" dir="ltr" value={certificate} onChange={(e) => setCertificate(e.target.value)} />
            </Field>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field id="vcOldPrice" label={t("policies.oldPrice")} error={err("oldPriceCents")}>
                <MoneyInput id="vcOldPrice" cents={oldPrice} onChange={setOldPrice} />
              </Field>
              <Field id="vcNewPrice" label={t("policies.newPrice")} error={err("newPriceCents")}>
                <MoneyInput id="vcNewPrice" cents={newPrice} onChange={setNewPrice} />
              </Field>
            </div>
            <SettlementField value={settlement} onChange={setSettlement} />
            {canChoose && <RefundAccountField value={account} onChange={setAccount} />}
            <ReasonField value={reason} onChange={setReason} error={err("reason")} />
            <Field id="vcReceipt" label={`${t("policies.paperReceipt")} ${t("common.optional")}`}>
              <Input id="vcReceipt" dir="ltr" value={receipt} onChange={(e) => setReceipt(e.target.value)} />
            </Field>
          </>
        )}
      />
      <Dialog open={adding} onOpenChange={setAdding}>
        <DialogContent closeLabel={t("common.close")}>
          {adding && <VehicleDialog clientId={policy.clientId} onCancel={() => setAdding(false)} onDone={(v) => { setAdding(false); setNewId(v.id); }} />}
        </DialogContent>
      </Dialog>
    </>
  );
}

function FeeSummary({ fee }: { fee: number }) {
  return <Money cents={fee} />;
}

function PlateChangeDialog({ policy, onClose }: DialogProps) {
  const { t } = useTranslation();
  const key = useOperationKey();
  const fee = useCatalog().data?.certificateFeeCents ?? 0;
  const [vehicleId, setVehicleId] = useState(policy.vehicles[0]?.vehicleId ?? "");
  const [plateType, setPlateType] = useState<PlateType>("ma");
  const [plate, setPlate] = useState("");
  const [certificate, setCertificate] = useState("");
  const [reason, setReason] = useState("");
  const [settlement, setSettlement] = useState<"pay_now" | "defer">("pay_now");
  const current = policy.vehicles.find((v) => v.vehicleId === vehicleId);
  return (
    <OperationFrame
      title={t("policies.plateChangeTitle", { number: policy.policyNumber })}
      path={`/api/policies/${policy.id}/plate-change`}
      body={() => ({ idempotencyKey: key, vehicleId, plateType, plate, certificateNumber: certificate, reason, settlement })}
      summary={async () => [
        [t("policies.number"), <Code key="n">{policy.policyNumber}</Code>],
        [t("vehicles.oldPlate"), <Code key="o">{current?.plate}</Code>],
        [t("vehicles.newPlate"), <Code key="p">{plate}</Code>],
        [t("policies.oldCertificate"), <Code key="oc">{current?.certificateNumber}</Code>],
        [t("policies.newCertificate"), <Code key="c">{certificate}</Code>],
        [t("policies.fee"), <FeeSummary key="f" fee={fee} />],
        [t("finance.settlementTitle"), t(`finance.settlement.${settlement}`)],
      ]}
      onClose={onClose}
      form={(err) => (
        <>
          <Field id="pcVehicle" label={t("policies.vehicle")}>
            <NativeSelect id="pcVehicle" value={vehicleId} onChange={(e) => setVehicleId(e.target.value)}>
              {policy.vehicles.map((v) => <option key={v.vehicleId} value={v.vehicleId}>{v.plate}</option>)}
            </NativeSelect>
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field id="pcType" label={t("vehicles.plateType")}>
              <NativeSelect id="pcType" value={plateType} onChange={(e) => setPlateType(e.target.value as PlateType)}>
                {PLATE_TYPES.map((p) => <option key={p} value={p}>{t(`vehicles.plateTypes.${p}`)}</option>)}
              </NativeSelect>
            </Field>
            <Field id="pcPlate" label={t("vehicles.newPlate")} hint={t(`vehicles.plateHints.${plateType}`)} error={err("plate")}>
              <Input id="pcPlate" dir="ltr" value={plate} onChange={(e) => setPlate(e.target.value)} />
            </Field>
          </div>
          <Field id="pcCert" label={t("policies.newCertificate")} error={err("certificateNumber")}>
            <Input id="pcCert" dir="ltr" value={certificate} onChange={(e) => setCertificate(e.target.value)} />
          </Field>
          <SettlementField value={settlement} onChange={setSettlement} />
          <ReasonField value={reason} onChange={setReason} error={err("reason")} />
        </>
      )}
    />
  );
}

function DuplicateDialog({ policy, onClose }: DialogProps) {
  const { t } = useTranslation();
  const key = useOperationKey();
  const fee = useCatalog().data?.certificateFeeCents ?? 0;
  const [vehicleId, setVehicleId] = useState(policy.vehicles[0]?.vehicleId ?? "");
  const [certificate, setCertificate] = useState("");
  const [reason, setReason] = useState("");
  const [settlement, setSettlement] = useState<"pay_now" | "defer">("pay_now");
  const current = policy.vehicles.find((v) => v.vehicleId === vehicleId);
  return (
    <OperationFrame
      title={t("policies.duplicateTitle", { number: policy.policyNumber })}
      description={t("policies.duplicateHint")}
      path={`/api/policies/${policy.id}/duplicate`}
      body={() => ({ idempotencyKey: key, vehicleId, certificateNumber: certificate, reason, settlement })}
      summary={async () => [
        [t("policies.number"), <Code key="n">{policy.policyNumber}</Code>],
        [t("policies.vehicle"), <Code key="v">{current?.plate}</Code>],
        [t("policies.oldCertificate"), <Code key="o">{current?.certificateNumber}</Code>],
        [t("policies.newCertificate"), <Code key="c">{certificate}</Code>],
        [t("policies.fee"), <FeeSummary key="f" fee={fee} />],
        [t("finance.settlementTitle"), t(`finance.settlement.${settlement}`)],
      ]}
      onClose={onClose}
      form={(err) => (
        <>
          <Field id="dupVehicle" label={t("policies.vehicle")}>
            <NativeSelect id="dupVehicle" value={vehicleId} onChange={(e) => setVehicleId(e.target.value)}>
              {policy.vehicles.map((v) => <option key={v.vehicleId} value={v.vehicleId}>{`${v.plate} — ${v.certificateNumber}`}</option>)}
            </NativeSelect>
          </Field>
          <Field id="dupCert" label={t("policies.newCertificate")} error={err("certificateNumber")}>
            <Input id="dupCert" dir="ltr" value={certificate} onChange={(e) => setCertificate(e.target.value)} />
          </Field>
          <SettlementField value={settlement} onChange={setSettlement} />
          <ReasonField value={reason} onChange={setReason} error={err("reason")} />
        </>
      )}
    />
  );
}

function FleetAddDialog({ policy, onClose }: DialogProps) {
  const { t } = useTranslation();
  const key = useOperationKey();
  const vehicles = useClientVehicles(policy.clientId).filter((v) => !v.archived && !v.activePolicyId);
  const [vehicleId, setVehicleId] = useState("");
  const [certificate, setCertificate] = useState("");
  const [reason, setReason] = useState("");
  const [amount, setAmount] = useState<number | null>(null);
  const [settlement, setSettlement] = useState<"pay_now" | "defer">("pay_now");
  return (
    <OperationFrame
      title={t("policies.fleetAdd")}
      description={t("finance.fleetAddNote")}
      path={`/api/policies/${policy.id}/fleet/add`}
      body={() => ({ idempotencyKey: key, vehicleId, certificateNumber: certificate, reason, amountCents: amount ?? 0, settlement })}
      summary={null}
      onClose={onClose}
      form={(err) => (
        <>
          <Field id="faVehicle" label={t("policies.vehicle")}>
            <NativeSelect id="faVehicle" value={vehicleId} onChange={(e) => setVehicleId(e.target.value)}>
              <option value="" />
              {vehicles.map((v) => <option key={v.id} value={v.id}>{`${v.plate} — ${v.brand}`}</option>)}
            </NativeSelect>
          </Field>
          <Field id="faCert" label={t("policies.certificate")} error={err("certificateNumber")}>
            <Input id="faCert" dir="ltr" value={certificate} onChange={(e) => setCertificate(e.target.value)} />
          </Field>
          <Field id="faAmount" label={t("finance.fleetAddAmount")} error={err("amountCents")}>
            <MoneyInput id="faAmount" cents={amount} onChange={setAmount} />
          </Field>
          <SettlementField value={settlement} onChange={setSettlement} />
          <ReasonField value={reason} onChange={setReason} error={err("reason")} />
        </>
      )}
    />
  );
}

function FleetRemoveDialog({ policy, onClose }: DialogProps) {
  const { t } = useTranslation();
  const key = useOperationKey();
  const [vehicleId, setVehicleId] = useState(policy.vehicles[0]?.vehicleId ?? "");
  const [reason, setReason] = useState("");
  const [refund, setRefund] = useState<number | null>(null);
  const [account, setAccount] = useState<"drawer" | "safe" | "bank">("drawer");
  const canChoose = useCanChooseRefund();
  return (
    <OperationFrame
      title={t("policies.fleetRemove")}
      description={t("finance.fleetRemoveNote")}
      path={`/api/policies/${policy.id}/fleet/remove`}
      body={() => ({ idempotencyKey: key, vehicleId, reason, refundCents: refund ?? 0, refundAccount: account })}
      summary={async () => [
        [t("policies.vehicle"), <Code key="v">{policy.vehicles.find((v) => v.vehicleId === vehicleId)?.plate}</Code>],
        [t("finance.fleetRemoveAmount"), <Money key="r" cents={refund ?? 0} />],
      ]}
      destructive
      onClose={onClose}
      form={(err) => (
        <>
          <Field id="frVehicle" label={t("policies.vehicle")}>
            <NativeSelect id="frVehicle" value={vehicleId} onChange={(e) => setVehicleId(e.target.value)}>
              {policy.vehicles.map((v) => <option key={v.vehicleId} value={v.vehicleId}>{v.plate}</option>)}
            </NativeSelect>
          </Field>
          <Field id="frAmount" label={t("finance.fleetRemoveAmount")} hint={t("finance.refundAgainstDuesHint")} error={err("refundCents")}>
            <MoneyInput id="frAmount" cents={refund} onChange={setRefund} />
          </Field>
          {canChoose && <RefundAccountField value={account} onChange={setAccount} />}
          <ReasonField value={reason} onChange={setReason} error={err("reason")} />
        </>
      )}
    />
  );
}

// ---------------------------------------------------------------- annulment, cancellation, other (SPEC 13, 11.4)

function annulMoneyLines(money: { refundCents: number; writeOffCents: number } | undefined, refundLabel: string, writeOffLabel: string): [string, ReactNode][] {
  if (!money) return [];
  const refund: [string, ReactNode] = [refundLabel, <Money key="m" cents={money.refundCents} />];
  const writeOff: [string, ReactNode] = [writeOffLabel, <Money key="w" cents={money.writeOffCents} />];
  return [refund, writeOff];
}

function AnnulDialog({ policy, onClose }: DialogProps) {
  const { t } = useTranslation();
  const key = useOperationKey();
  const [reason, setReason] = useState("");
  const [account, setAccount] = useState<"drawer" | "safe" | "bank">("drawer");
  const canChoose = useCanChooseRefund();
  const finance = useFinance(policy.id).data;
  const money = finance?.annulment;
  return (
    <OperationFrame
      title={t("policies.annulTitle", { number: policy.policyNumber })}
      description={policy.actions.annulUntil ? t("policies.annulInfo", { date: formatDay(policy.actions.annulUntil) }) : t("finance.annulInstalmentsInfo")}
      path={`/api/policies/${policy.id}/annul`}
      body={() => ({ idempotencyKey: key, reason, refundAccount: account })}
      summary={async () => [
        [t("policies.number"), <Code key="n">{policy.policyNumber}</Code>],
        [t("policies.client"), <span key="c" dir="auto">{policy.clientName}</span>],
        ...annulMoneyLines(money, t("finance.annulRefund"), t("finance.annulWriteOff")),
        [t("common.reason"), <span key="r">{reason}</span>],
      ]}
      destructive
      onClose={onClose}
      form={(err) => (
        <>
          {money && (!money.allowed || money.reason) && <Alert variant={money.allowed ? "warning" : "error"}>{t(`errors.api.${money.reason ?? "ANNULMENT_NOT_ALLOWED"}`, { defaultValue: t("finance.annulNotAllowed") })}</Alert>}
          {money && money.allowed && (
            <dl className="grid gap-2 rounded-md border p-3 text-sm" data-testid="annul-money">
              <div className="flex justify-between gap-3"><dt className="text-muted-foreground">{t("finance.annulRefund")}</dt><dd><Money cents={money.refundCents} /></dd></div>
              <div className="flex justify-between gap-3"><dt className="text-muted-foreground">{t("finance.annulWriteOff")}</dt><dd><Money cents={money.writeOffCents} /></dd></div>
            </dl>
          )}
          {canChoose && money && money.refundCents > 0 && <RefundAccountField value={account} onChange={setAccount} />}
          <ReasonField value={reason} onChange={setReason} error={err("reason")} />
        </>
      )}
    />
  );
}

function CancelDialog({ policy, onClose }: DialogProps) {
  const { t } = useTranslation();
  const key = useOperationKey();
  const [reason, setReason] = useState("");
  const [refund, setRefund] = useState<number | null>(null);
  const [payOut, setPayOut] = useState(false);
  const [account, setAccount] = useState<"drawer" | "safe" | "bank">("drawer");
  const finance = useFinance(policy.id).data;
  const hasDebt = (finance?.debts ?? []).some((d) => d.status === "open");
  return (
    <OperationFrame
      title={t("policies.cancelTitle", { number: policy.policyNumber })}
      description={t("policies.cancelInfo")}
      path={`/api/policies/${policy.id}/cancel`}
      body={() => ({ idempotencyKey: key, reason, refundCents: refund, payOut: hasDebt ? payOut : true, refundAccount: account })}
      summary={async () => [
        [t("policies.number"), <Code key="n">{policy.policyNumber}</Code>],
        [t("policies.refund"), <Money key="r" cents={refund} />],
        [t("finance.refundTitle"), hasDebt && !payOut ? t("finance.cancelAgainstDebt") : t("finance.cancelPayOut", { account: t(`finance.accounts.${account}`) })],
        [t("common.reason"), <span key="x">{reason}</span>],
      ]}
      destructive
      onClose={onClose}
      form={(err) => (
        <>
          <Field id="refund" label={t("policies.refund")} error={err("refundCents")}>
            <MoneyInput id="refund" cents={refund} onChange={setRefund} />
          </Field>
          {finance && !finance.cancellationAllowed && <Alert variant="error">{t("errors.api.CANCELLATION_INSTALMENTS_OPEN")}</Alert>}
          {hasDebt && (
            <div className="flex items-start gap-2">
              <Checkbox id="payOut" checked={payOut} onCheckedChange={(v) => setPayOut(v === true)} />
              <div className="grid gap-1">
                <Label htmlFor="payOut">{t("finance.cancelPayOutChoice")}</Label>
                <span className="text-xs text-muted-foreground">{t("finance.cancelPayOutHint")}</span>
              </div>
            </div>
          )}
          {(!hasDebt || payOut) && <RefundAccountField value={account} onChange={setAccount} />}
          <ReasonField value={reason} onChange={setReason} error={err("reason")} />
        </>
      )}
    />
  );
}

function CustomDialog({ policy, onClose }: DialogProps) {
  const { t } = useTranslation();
  const key = useOperationKey();
  const name = useLocalName();
  const types = (useCatalog().data?.operationTypes ?? []).filter((o) => !o.isSystem && !o.archived);
  const [type, setType] = useState(types[0]?.code ?? "");
  const [reason, setReason] = useState("");
  return (
    <OperationFrame
      title={t("policies.otherOperationTitle", { number: policy.policyNumber })}
      path={`/api/policies/${policy.id}/operations`}
      body={() => ({ idempotencyKey: key, operationType: type, reason })}
      summary={null}
      onClose={onClose}
      form={(err) => (
        <>
          <Field id="customType" label={t("editRequests.operation")}>
            <NativeSelect id="customType" value={type} onChange={(e) => setType(e.target.value)}>
              {types.map((o) => <option key={o.code} value={o.code}>{name(o)}</option>)}
            </NativeSelect>
          </Field>
          <ReasonField value={reason} onChange={setReason} error={err("reason")} />
        </>
      )}
    />
  );
}

// ---------------------------------------------------------------- the page

function Info({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid gap-0.5">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span>{children}</span>
    </div>
  );
}

export function PolicyPage({ id, onOpen }: { id: string; onOpen: (page: Page) => void }) {
  const { t } = useTranslation();
  const { isManager, can } = useSession();
  const name = useLocalName();
  const catalog = useCatalog().data;
  const historical = useHistorical().data;
  const lateRenewAllowed = isManager && historical?.mode === "locked";
  const [open, setOpen] = useState<OperationKind | null>(null);
  const query = useQuery({ queryKey: ["policy", id], queryFn: () => api<PolicyDto>("GET", `/api/policies/${id}`) });
  const finance = useFinance(id).data;
  if (query.error) return <ErrorMessage error={asClientError(query.error)} />;
  const p = query.data;
  if (!p) return null;
  const a = p.actions;
  const active = p.validity === "active";
  const vehicleOps = p.requiresVehicle && a.activeToday;
  const customTypes = (catalog?.operationTypes ?? []).filter((o) => !o.isSystem && !o.archived);
  const close = () => setOpen(null);
  const dialogs: Record<OperationKind, ReactNode> = {
    renew: <RenewDialog policy={p} onClose={close} />,
    lateRenew: <RenewDialog policy={p} onClose={close} late />,
    change: <ChangeDialog policy={p} onClose={close} />,
    edit: <EditDialog policy={p} onClose={close} />,
    vehicleChange: <VehicleChangeDialog policy={p} onClose={close} />,
    plateChange: <PlateChangeDialog policy={p} onClose={close} />,
    duplicate: <DuplicateDialog policy={p} onClose={close} />,
    fleetAdd: <FleetAddDialog policy={p} onClose={close} />,
    fleetRemove: <FleetRemoveDialog policy={p} onClose={close} />,
    annul: <AnnulDialog policy={p} onClose={close} />,
    cancel: <CancelDialog policy={p} onClose={close} />,
    custom: <CustomDialog policy={p} onClose={close} />,
  };
  const button = (kind: OperationKind, label: string, variant: "default" | "outline" | "destructive" = "outline") => (
    <Button key={kind} size="sm" variant={variant} onClick={() => setOpen(kind)}>{label}</Button>
  );

  return (
    <div className="grid gap-5">
      <PageHeader
        title={`${t("policies.number")} ${p.policyNumber}`}
        intro={`${p.insurerName} — ${p.typeName}`}
        actions={<Button variant="ghost" onClick={() => onOpen({ kind: "policies" })}>{t("policies.back")}</Button>}
      />

      <Card>
        <CardContent className="grid gap-4 pt-5 sm:grid-cols-2 lg:grid-cols-4">
          <Info label={t("policies.validity")}><ValidityBadge validity={p.validity} /></Info>
          <Info label={t("policies.client")}>
            <Button variant="link" className="h-auto p-0" onClick={() => onOpen({ kind: "client", id: p.clientId })}><span dir="auto">{p.clientName}</span></Button>
          </Info>
          <Info label={t("policies.start")}>{formatDay(p.startDate)}</Info>
          <Info label={t("policies.end")}>{formatDay(p.endDate)}</Info>
          <Info label={t("policies.amount")}><Money cents={p.totalAmountCents} /></Info>
          {p.fleet && <Info label={t("policies.fleet")}><span dir="auto">{p.fleet.name || t("policies.fleet")}</span></Info>}
          <Info label={t("common.date")}>{t("policies.today", { date: formatDay(p.today) })}</Info>
        </CardContent>
      </Card>

      <PolicyFinanceSection policy={p} />

      {p.replaces && (
        <Alert>
          <Button variant="link" className="h-auto p-0" onClick={() => onOpen({ kind: "policy", id: p.replaces?.id as string })}>{t("policies.replaces", { number: p.replaces.policyNumber })}</Button>
        </Alert>
      )}
      {p.replacedBy && (
        <Alert variant="warning">
          <Button variant="link" className="h-auto p-0" onClick={() => onOpen({ kind: "policy", id: p.replacedBy?.id as string })}>{t("policies.replacedBy", { number: p.replacedBy.policyNumber })}</Button>
        </Alert>
      )}
      {a.renewalMode === "renewal" && !a.alreadyReplaced && <Alert>{t("policies.renewInfo", { last: formatDay(a.renewalLastDay), start: formatDay(a.nextStartDate) })}</Alert>}
      {a.renewalMode === "policy_change" && <Alert variant="warning">{t("policies.changeInfo", { end: formatDay(p.endDate) })}</Alert>}
      {a.renewalMode === "none" && !a.alreadyReplaced && <Alert variant="warning">{t("policies.closedInfo")}</Alert>}
      {a.hasFuturePeriod && <Alert>{t("policies.futurePeriod", { date: formatDay(p.periods[p.periods.length - 1]?.startDate) })}</Alert>}
      {p.requiresVehicle && active && !a.activeToday && !a.hasFuturePeriod && <Alert>{t("policies.notActiveToday")}</Alert>}

      <div className="flex flex-wrap gap-2" role="toolbar" aria-label={t("common.actions")}>
        {a.renewalMode === "renewal" && button("renew", t("policies.renew"), "default")}
        {a.renewalMode === "policy_change" && button("change", t("policies.change"), "default")}
        {/* Phase 8B: renewed on paper in time, entered late: the manager only, after going live. */}
        {lateRenewAllowed && a.renewalMode === "policy_change" && button("lateRenew", t("policies.lateRenew"))}
        {a.renewalMode !== "none" && button("edit", t("policies.edit"))}
        {vehicleOps && !a.hasFuturePeriod && button("vehicleChange", t("policies.vehicleChange"))}
        {vehicleOps && !a.hasFuturePeriod && button("plateChange", t("policies.plateChange"))}
        {vehicleOps && button("duplicate", t("policies.duplicate"))}
        {vehicleOps && p.fleet && !a.hasFuturePeriod && button("fleetAdd", t("policies.fleetAdd"))}
        {vehicleOps && p.fleet && !a.hasFuturePeriod && button("fleetRemove", t("policies.fleetRemove"))}
        {/* Unpaid instalments: annulment stays possible after 15 days (SPEC 13.1); the server decides. */}
        {(a.annulUntil || (active && finance?.paymentState === "instalments_open")) && button("annul", t("policies.annul"), "destructive")}
        {isManager && active && button("cancel", t("policies.cancel"), "destructive")}
        {customTypes.length > 0 && button("custom", t("policies.otherOperation"))}
      </div>

      {p.requiresVehicle && (
        <Card>
          <CardHeader>
            <CardTitle>{t("policies.vehicles")}</CardTitle>
          </CardHeader>
          <CardContent>
            <Table>
              <THead>
                <Tr>
                  <Th>{t("vehicles.plate")}</Th>
                  <Th>{t("vehicles.brand")}</Th>
                  <Th>{t("policies.certificate")}</Th>
                  <Th>{t("common.from")}</Th>
                </Tr>
              </THead>
              <TBody>
                {p.vehicles.map((v) => (
                  <Tr key={v.vehicleId}>
                    <Td><Code>{v.plate}</Code></Td>
                    <Td dir="auto">{v.brand}</Td>
                    <Td><Code>{v.certificateNumber}</Code></Td>
                    <Td>{formatDay(v.fromDate)}</Td>
                  </Tr>
                ))}
              </TBody>
            </Table>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>{t("policies.periods")}</CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <THead>
              <Tr>
                <Th>{t("policies.period", { seq: "" })}</Th>
                <Th>{t("policies.start")}</Th>
                <Th>{t("policies.end")}</Th>
                <Th>{t("policies.amount")}</Th>
                <Th>{t("policies.validity")}</Th>
                <Th>{t("policies.by")}</Th>
              </Tr>
            </THead>
            <TBody>
              {p.periods.map((x) => (
                <Tr key={x.id}>
                  <Td>{`${x.seq} · ${t(`policies.periodOps.${x.operation}`)}`}</Td>
                  <Td>{formatDay(x.startDate)}</Td>
                  <Td>{formatDay(x.endDate)}</Td>
                  <Td><Money cents={x.totalAmountCents} /></Td>
                  <Td><ValidityBadge validity={x.validity} /></Td>
                  <Td>{x.createdByName}</Td>
                </Tr>
              ))}
            </TBody>
          </Table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t("policies.operations")}</CardTitle>
        </CardHeader>
        <CardContent>
          {p.operations.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t("policies.noOperations")}</p>
          ) : (
            <Table data-testid="operations">
              <THead>
                <Tr>
                  <Th>{t("common.date")}</Th>
                  <Th>{t("editRequests.operation")}</Th>
                  <Th>{t("policies.by")}</Th>
                  <Th>{t("common.reason")}</Th>
                  <Th>{t("policies.net")}</Th>
                </Tr>
              </THead>
              <TBody>
                {p.operations.map((o) => (
                  <Tr key={o.id}>
                    <Td>{formatDateTime(o.createdAt)}</Td>
                    <Td>{name(o)}</Td>
                    <Td>{o.userName}</Td>
                    <Td dir="auto">{o.reason}</Td>
                    <Td>
                      {o.netCents !== null && (
                        <div className="grid gap-1">
                          <Money cents={o.netCents} />
                          {o.settlementStatus === "pending" && <Badge variant="warning">{t("policies.settlement.pending")}</Badge>}
                        </div>
                      )}
                    </Td>
                  </Tr>
                ))}
              </TBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {can("claims.view") && (
        <Card>
          <CardHeader>
            <CardTitle>{t("followup.claimsTitle")}</CardTitle>
          </CardHeader>
          <CardContent>
            <ClaimsList policyId={p.id} />
          </CardContent>
        </Card>
      )}

      <Dialog open={open !== null} onOpenChange={(o) => !o && setOpen(null)}>
        <DialogContent closeLabel={t("common.close")} wide>
          {open && dialogs[open]}
        </DialogContent>
      </Dialog>
    </div>
  );
}
