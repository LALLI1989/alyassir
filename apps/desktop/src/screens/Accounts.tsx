import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { ACCOUNT_CODES, type AccountCodeDto, type AccountDto, type ListItemDto, type MovementDto, type Page as PageOf } from "@alyassir/shared";
import {
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
  Input,
  Label,
  NativeSelect,
  Switch,
  Table,
  TBody,
  Td,
  Textarea,
  Th,
  THead,
  Tr,
  cn,
} from "@alyassir/ui";
import { asClientError } from "../adapters";
import { Field, PageHeader, Pager } from "../components/common";
import { Money, MoneyInput, formatDay, useCatalog, useOperationKey } from "../components/insurance";
import { ErrorMessage, fieldsOf, useFieldError } from "../lib/errors";
import { formatTime } from "../lib/format";
import { api, useSession } from "../lib/session";
import { ListSettings, useListName } from "./Expenses";

type Action = "transfer" | "insurer" | "withdrawal" | { reverse: MovementDto };

/** Drawer, safe and bank for the manager (and a supervisor with the power): SPEC 17.1, 17.4. */
export function Accounts() {
  const { t } = useTranslation();
  const { can, isManager } = useSession();
  const queries = useQueryClient();
  const accounts = useQuery({ queryKey: ["accounts"], queryFn: () => api<AccountDto[]>("GET", "/api/accounts") });
  const [account, setAccount] = useState<AccountCodeDto>("drawer");
  const [action, setAction] = useState<Action | null>(null);
  const negative = useMutation({
    mutationFn: (allow: boolean) => api<AccountDto[]>("PUT", "/api/accounts/bank-negative", { allow }),
    onSuccess: (list) => queries.setQueryData(["accounts"], list),
  });
  const bank = accounts.data?.find((a) => a.code === "bank");
  return (
    <div className="grid gap-5">
      <PageHeader
        title={t("cash.accountsTitle")}
        intro={t("cash.accountsIntro")}
        actions={
          <div className="flex flex-wrap gap-2">
            {can("sup.transfers") && <Button onClick={() => setAction("transfer")}>{t("cash.transfer")}</Button>}
            {can("sup.insurer_payments_withdrawals") && <Button variant="outline" onClick={() => setAction("insurer")}>{t("cash.payInsurer")}</Button>}
            {can("sup.insurer_payments_withdrawals") && <Button variant="outline" onClick={() => setAction("withdrawal")}>{t("cash.withdraw")}</Button>}
          </div>
        }
      />
      <div className="grid gap-3 sm:grid-cols-3" data-testid="balances">
        {(accounts.data ?? []).map((a) => (
          <button
            key={a.code}
            type="button"
            onClick={() => setAccount(a.code)}
            aria-pressed={account === a.code}
            className={cn("grid gap-1 rounded-lg border bg-card p-4 text-start transition-colors", account === a.code && "border-primary ring-1 ring-primary")}
          >
            <span className="text-sm text-muted-foreground">{t(`finance.accounts.${a.code}`)}</span>
            <Money cents={a.balanceCents} className={cn("text-xl font-bold", a.balanceCents < 0 && "text-destructive")} />
          </button>
        ))}
      </div>
      {isManager && bank && (
        <div className="flex items-center gap-2">
          <Switch id="bankNegative" checked={bank.allowNegative} onCheckedChange={(v) => negative.mutate(v)} />
          <Label htmlFor="bankNegative">{t("cash.bankNegative")}</Label>
          {negative.error && <ErrorMessage error={asClientError(negative.error)} />}
        </div>
      )}
      <Movements account={account} onReverse={(m) => setAction({ reverse: m })} />
      {isManager && <ListSettings kind="reasons" />}
      <Dialog open={action !== null} onOpenChange={(o) => !o && setAction(null)}>
        <DialogContent closeLabel={t("common.close")}>{action && <ActionDialog action={action} onClose={() => setAction(null)} />}</DialogContent>
      </Dialog>
    </div>
  );
}

function useMovementLabel(): (m: MovementDto) => string {
  const { t } = useTranslation();
  const category = useListName("categories");
  const reason = useListName("reasons");
  return (m) => {
    const r = m.ref;
    switch (r.type) {
      case "payment":
        return [r.policyNumber, r.clientName].filter(Boolean).join(" · ");
      case "refund":
        return r.policyNumber ?? "";
      case "expense":
        return category(r.category);
      case "transfer":
        return `${t(`finance.accounts.${r.from}`)} → ${t(`finance.accounts.${r.to}`)}${r.reference ? ` · ${r.reference}` : ""}`;
      case "insurer_payment":
        return [r.insurer, r.reference].filter(Boolean).join(" · ");
      case "withdrawal":
        return `${reason(r.reason)} · ${r.explanation}`;
      default:
        return "";
    }
  };
}

function Movements({ account, onReverse }: { account: AccountCodeDto; onReverse: (m: MovementDto) => void }) {
  const { t } = useTranslation();
  const { can } = useSession();
  const label = useMovementLabel();
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [page, setPage] = useState(1);
  const list = useQuery({
    queryKey: ["movements", account, from, to, page],
    queryFn: () =>
      api<PageOf<MovementDto> & { balanceCents: number }>(
        "GET",
        `/api/accounts/movements?account=${account}&page=${page}&pageSize=25${from ? `&from=${from}` : ""}${to ? `&to=${to}` : ""}`,
      ),
    placeholderData: keepPreviousData,
  });
  const data = list.data;
  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;
  const canReverse = (m: MovementDto): boolean => {
    const r = m.ref;
    if (r.type === "transfer") return !r.reversed && !r.isReversal && can("sup.transfers") && m.amountCents < 0;
    if (r.type === "insurer_payment" || r.type === "withdrawal") return !r.reversed && !r.isReversal && can("sup.insurer_payments_withdrawals");
    return false;
  };
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("cash.movementsOf", { account: t(`finance.accounts.${account}`) })}</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-3">
        <div className="flex flex-wrap items-end gap-3">
          <Field id="movFrom" label={t("common.from")}>
            <Input id="movFrom" type="date" dir="ltr" value={from} onChange={(e) => { setFrom(e.target.value); setPage(1); }} />
          </Field>
          <Field id="movTo" label={t("common.to")}>
            <Input id="movTo" type="date" dir="ltr" value={to} onChange={(e) => { setTo(e.target.value); setPage(1); }} />
          </Field>
        </div>
        <Table data-testid="movements">
          <THead>
            <Tr>
              <Th>{t("common.date")}</Th>
              <Th>{t("cash.kind")}</Th>
              <Th>{t("common.details")}</Th>
              <Th>{t("cash.by")}</Th>
              <Th>{t("finance.amount")}</Th>
              <Th />
            </Tr>
          </THead>
          <TBody>
            {data?.items.length === 0 && (
              <Tr>
                <Td colSpan={6} className="py-8 text-center text-muted-foreground">{t("common.empty")}</Td>
              </Tr>
            )}
            {data?.items.map((m) => (
              <Tr key={m.id}>
                <Td>
                  <div className="grid">
                    <span>{formatDay(m.businessDate)}</span>
                    <span className="text-xs text-muted-foreground">{formatTime(m.createdAt)}</span>
                  </div>
                </Td>
                <Td>
                  <span className="inline-flex flex-wrap items-center gap-1">
                    {t(`cash.kinds.${m.kind}`, { defaultValue: m.kind })}
                    {"reversed" in m.ref && m.ref.reversed && <Badge variant="outline">{t("cash.reversed")}</Badge>}
                  </span>
                </Td>
                <Td dir="auto">{label(m)}</Td>
                <Td>{m.userName ?? t("messages.system")}</Td>
                <Td className={m.amountCents < 0 ? "text-destructive" : "text-success"}><Money cents={m.amountCents} /></Td>
                <Td className="text-end">{canReverse(m) && <Button size="sm" variant="outline" onClick={() => onReverse(m)}>{t("cash.reverse")}</Button>}</Td>
              </Tr>
            ))}
          </TBody>
        </Table>
        <Pager page={page} pages={pages} total={data?.total ?? 0} onPage={setPage} />
      </CardContent>
    </Card>
  );
}

function ActionDialog({ action, onClose }: { action: Action; onClose: () => void }) {
  const { t } = useTranslation();
  const fieldError = useFieldError();
  const queries = useQueryClient();
  const { isManager } = useSession();
  const key = useOperationKey();
  const reasonName = useListName("reasons");
  const insurers = (useCatalog().data?.insurers ?? []).filter((i) => !i.archived);
  const reasons = useQuery({ queryKey: ["withdrawalReasons"], queryFn: () => api<ListItemDto[]>("GET", "/api/accounts/withdrawal-reasons"), enabled: action === "withdrawal" });
  const [from, setFrom] = useState<AccountCodeDto>("drawer");
  const [to, setTo] = useState<AccountCodeDto>("safe");
  const [amount, setAmount] = useState<number | null>(null);
  const [reference, setReference] = useState("");
  const [note, setNote] = useState("");
  const [insurerId, setInsurerId] = useState("");
  const [account, setAccount] = useState<AccountCodeDto>("bank");
  const [reasonId, setReasonId] = useState("");
  const [explanation, setExplanation] = useState("");
  const [reason, setReason] = useState("");
  const run = useMutation({
    mutationFn: () => {
      if (action === "transfer") return api<AccountDto[]>("POST", "/api/accounts/transfers", { idempotencyKey: key, from, to, amountCents: amount, reference });
      if (action === "insurer") return api<AccountDto[]>("POST", "/api/accounts/insurer-payments", { idempotencyKey: key, insurerId, account, amountCents: amount, reference, note });
      if (action === "withdrawal") return api<AccountDto[]>("POST", "/api/accounts/withdrawals", { idempotencyKey: key, reasonId, amountCents: amount, explanation, reference });
      const r = action.reverse.ref;
      const kind = r.type === "transfer" ? "transfer" : r.type === "insurer_payment" ? "insurer_payment" : "withdrawal";
      return api<AccountDto[]>("POST", "/api/accounts/reverse", { idempotencyKey: key, kind, id: "id" in r ? r.id : "", reason });
    },
    onSuccess: async (list) => {
      queries.setQueryData(["accounts"], list);
      await Promise.all(["movements", "drawer"].map((k) => queries.invalidateQueries({ queryKey: [k] })));
      onClose();
    },
  });
  const error = run.error ? asClientError(run.error) : null;
  const fields = fieldsOf(error);
  const title = typeof action === "string" ? t(`cash.actions.${action}`) : t("cash.reverseTitle");
  return (
    <form onSubmit={(e: FormEvent) => { e.preventDefault(); run.mutate(); }} className="grid gap-4">
      <DialogHeader>
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription>{typeof action === "string" ? t(`cash.actionsInfo.${action}`) : t("cash.reverseInfo")}</DialogDescription>
      </DialogHeader>
      {action === "transfer" && (
        <div className="grid gap-4 sm:grid-cols-2">
          <Field id="trFrom" label={t("cash.from")}>
            <NativeSelect id="trFrom" value={from} onChange={(e) => setFrom(e.target.value as AccountCodeDto)}>
              {ACCOUNT_CODES.map((a) => <option key={a} value={a}>{t(`finance.accounts.${a}`)}</option>)}
            </NativeSelect>
          </Field>
          <Field id="trTo" label={t("cash.to")} error={fieldError(fields.to)}>
            <NativeSelect id="trTo" value={to} onChange={(e) => setTo(e.target.value as AccountCodeDto)}>
              {ACCOUNT_CODES.map((a) => <option key={a} value={a}>{t(`finance.accounts.${a}`)}</option>)}
            </NativeSelect>
          </Field>
        </div>
      )}
      {action === "insurer" && (
        <>
          <Field id="ipInsurer" label={t("policies.insurer")} error={fieldError(fields.insurerId)}>
            <NativeSelect id="ipInsurer" value={insurerId} onChange={(e) => setInsurerId(e.target.value)}>
              <option value="" />
              {insurers.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}
            </NativeSelect>
          </Field>
          {isManager && (
            <Field id="ipAccount" label={t("cash.payFrom")}>
              <NativeSelect id="ipAccount" value={account} onChange={(e) => setAccount(e.target.value as AccountCodeDto)}>
                {(["bank", "safe", "drawer"] as const).map((a) => <option key={a} value={a}>{t(`finance.accounts.${a}`)}</option>)}
              </NativeSelect>
            </Field>
          )}
        </>
      )}
      {action === "withdrawal" && (
        <Field id="wdReason" label={t("cash.withdrawalReason")} error={fieldError(fields.reasonId)}>
          <NativeSelect id="wdReason" value={reasonId} onChange={(e) => setReasonId(e.target.value)}>
            <option value="" />
            {(reasons.data ?? []).filter((r) => !r.archived).map((r) => <option key={r.id} value={r.id}>{reasonName(r)}</option>)}
          </NativeSelect>
        </Field>
      )}
      {typeof action === "string" && (
        <Field id="acAmount" label={t("finance.amount")} error={fieldError(fields.amountCents)}>
          <MoneyInput id="acAmount" cents={amount} onChange={setAmount} />
        </Field>
      )}
      {action === "withdrawal" && (
        <Field id="wdExplanation" label={t("cash.explanation")} error={fieldError(fields.explanation)}>
          <Textarea id="wdExplanation" value={explanation} onChange={(e) => setExplanation(e.target.value)} />
        </Field>
      )}
      {typeof action === "string" && (
        <Field id="acReference" label={`${action === "insurer" ? t("cash.insurerReference") : t("cash.reference")} ${t("common.optional")}`}>
          <Input id="acReference" dir="ltr" value={reference} onChange={(e) => setReference(e.target.value)} />
        </Field>
      )}
      {action === "insurer" && (
        <Field id="ipNote" label={`${t("cash.note")} ${t("common.optional")}`}>
          <Input id="ipNote" dir="auto" value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>
      )}
      {typeof action !== "string" && (
        <>
          <dl className="grid gap-2 rounded-md border p-3 text-sm">
            <div className="flex justify-between gap-3"><dt className="text-muted-foreground">{t("cash.kind")}</dt><dd>{t(`cash.kinds.${action.reverse.kind}`, { defaultValue: action.reverse.kind })}</dd></div>
            <div className="flex justify-between gap-3"><dt className="text-muted-foreground">{t("finance.amount")}</dt><dd><Money cents={Math.abs(action.reverse.amountCents)} /></dd></div>
            <div className="flex justify-between gap-3"><dt className="text-muted-foreground">{t("common.date")}</dt><dd>{formatDay(action.reverse.businessDate)}</dd></div>
          </dl>
          <Field id="revReason" label={t("common.reason")} error={fieldError(fields.reason)}>
            <Textarea id="revReason" value={reason} onChange={(e) => setReason(e.target.value)} />
          </Field>
        </>
      )}
      {error && error.code !== "VALIDATION" && <ErrorMessage error={error} />}
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onClose}>{t("common.cancel")}</Button>
        <Button type="submit" variant={typeof action === "string" ? "default" : "destructive"} disabled={run.isPending}>{t("common.confirm")}</Button>
      </DialogFooter>
    </form>
  );
}

