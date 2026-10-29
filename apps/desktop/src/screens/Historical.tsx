import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import type { FinishHistoricalDto, HistoricalChecklistDto, HistoricalStateDto } from "@alyassir/shared";
import { Alert, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Input, Table, TBody, Td, Th, THead, Tr } from "@alyassir/ui";
import { asClientError } from "../adapters";
import { Field, PageHeader } from "../components/common";
import { useHistorical } from "../components/historical";
import { Money, MoneyInput, formatDay } from "../components/insurance";
import { ErrorMessage } from "../lib/errors";
import { formatDateTime } from "../lib/format";
import { api } from "../lib/session";

type Account = "drawer" | "safe" | "bank";
const ACCOUNTS: Account[] = ["drawer", "safe", "bank"];

function Opening({ state }: { state: HistoricalStateDto }) {
  const { t } = useTranslation();
  const client = useQueryClient();
  const o = state.opening ?? { drawerCents: 0, safeCents: 0, bankCents: 0 };
  const [values, setValues] = useState<Record<Account, number | null>>({ drawer: o.drawerCents, safe: o.safeCents, bank: o.bankCents });
  const save = useMutation({
    mutationFn: () => api<HistoricalStateDto>("PUT", "/api/historical/opening", { drawerCents: values.drawer ?? 0, safeCents: values.safe ?? 0, bankCents: values.bank ?? 0 }),
    onSuccess: (s) => {
      client.setQueryData(["historical"], s);
      void client.invalidateQueries({ queryKey: ["historicalChecklist"] });
    },
  });
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("historical.opening", { date: formatDay(state.firstDay) })}</CardTitle>
        <CardDescription>{t("historical.openingHint")}</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3">
        <div className="grid gap-3 sm:grid-cols-3">
          {ACCOUNTS.map((a) => (
            <Field key={a} id={`opening-${a}`} label={t(`finance.accounts.${a}`)}>
              <MoneyInput id={`opening-${a}`} cents={values[a]} onChange={(c) => setValues((v) => ({ ...v, [a]: c }))} />
            </Field>
          ))}
        </div>
        {save.isSuccess && <Alert variant="success">{t("common.saved")}</Alert>}
        {save.error && <ErrorMessage error={asClientError(save.error)} />}
        <div>
          <Button onClick={() => save.mutate()} disabled={save.isPending}>{t("common.save")}</Button>
        </div>
      </CardContent>
    </Card>
  );
}

function Correction({ account, cents }: { account: Account; cents: number }) {
  const { t } = useTranslation();
  const client = useQueryClient();
  const [actual, setActual] = useState<number | null>(cents);
  const [reason, setReason] = useState("");
  useEffect(() => setActual(cents), [cents]);
  const save = useMutation({
    mutationFn: () => api<HistoricalChecklistDto>("POST", "/api/historical/corrections", { account, actualCents: actual ?? 0, reason }),
    onSuccess: (list) => {
      client.setQueryData(["historicalChecklist"], list);
      setReason("");
    },
  });
  return (
    <Tr>
      <Td>{t(`finance.accounts.${account}`)}</Td>
      <Td><Money cents={cents} /></Td>
      <Td><MoneyInput id={`actual-${account}`} cents={actual} onChange={setActual} /></Td>
      <Td><Input aria-label={t("historical.correctionReason")} value={reason} onChange={(e) => setReason(e.target.value)} /></Td>
      <Td>
        <Button size="sm" variant="outline" disabled={save.isPending || actual === null || actual === cents || reason.trim().length < 3} onClick={() => save.mutate()}>
          {t("historical.correct")}
        </Button>
        {save.error && <ErrorMessage error={asClientError(save.error)} />}
      </Td>
    </Tr>
  );
}

function Finish({ list }: { list: HistoricalChecklistDto }) {
  const { t } = useTranslation();
  const client = useQueryClient();
  const [password, setPassword] = useState("");
  const [phrase, setPhrase] = useState("");
  const finish = useMutation({
    mutationFn: () => api<FinishHistoricalDto>("POST", "/api/historical/finish", { password, phrase }),
    onSuccess: () => void client.invalidateQueries(),
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    finish.mutate();
  };
  if (finish.data) {
    return <Alert variant="success">{t("historical.finished", { debts: finish.data.debtsCreated })}</Alert>;
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("historical.finishTitle")}</CardTitle>
        <CardDescription>{t("historical.finishHint")}</CardDescription>
      </CardHeader>
      <CardContent>
        <form className="grid gap-3 sm:max-w-lg" onSubmit={submit} data-testid="finish-form">
          {!list.canFinish && <Alert variant="error">{t("historical.negativeBlocks")}</Alert>}
          <Field id="finishPassword" label={t("historical.password")}>
            <Input id="finishPassword" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
          </Field>
          <Field id="finishPhrase" label={t("historical.phraseLabel", { phrase: t("historical.phrase") })}>
            <Input id="finishPhrase" dir="auto" value={phrase} onChange={(e) => setPhrase(e.target.value)} />
          </Field>
          {finish.error && <ErrorMessage error={asClientError(finish.error)} />}
          <div>
            <Button type="submit" variant="destructive" disabled={!list.canFinish || finish.isPending || !password || !phrase.trim()}>{t("historical.finishButton")}</Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

/** Historical entry (SPEC 22): opening balances, the checklist, the corrections, "all old entries are done". */
export function Historical() {
  const { t } = useTranslation();
  const state = useHistorical().data;
  const open = state?.mode === "open";
  const list = useQuery({ queryKey: ["historicalChecklist"], queryFn: () => api<HistoricalChecklistDto>("GET", "/api/historical/checklist"), enabled: open });
  const l = list.data;
  if (!state) return null;
  if (state.mode === "locked") {
    return (
      <div className="grid gap-5">
        <PageHeader title={t("historical.title")} />
        <Alert variant="success">{t("historical.live", { time: formatDateTime(state.goLiveAt) })}</Alert>
        <Card>
          <CardHeader>
            <CardTitle>{t("historical.helpTitle")}</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-2 text-sm">
            <p>{t("historical.helpLate")}</p>
            <p>{t("historical.helpCorrect")}</p>
            <p>{t("historical.helpRestore")}</p>
          </CardContent>
        </Card>
      </div>
    );
  }
  return (
    <div className="grid gap-5">
      <PageHeader title={t("historical.title")} intro={t("historical.intro")} />
      {open && <Opening state={state} />}
      {l && (
        <Card>
          <CardHeader>
            <CardTitle>{t("historical.checklist")}</CardTitle>
            <CardDescription>{t("historical.entered", { policies: l.entered.policies, payments: l.entered.payments, expenses: l.entered.expenses })}</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4">
            <Table data-testid="balances">
              <THead>
                <Tr>
                  <Th>{t("reports.columns.account")}</Th>
                  <Th>{t("historical.inProgram")}</Th>
                  <Th>{t("historical.actual")}</Th>
                  <Th>{t("historical.correctionReason")}</Th>
                  <Th>{t("common.actions")}</Th>
                </Tr>
              </THead>
              <TBody>
                {l.balances.map((b) => <Correction key={b.account} account={b.account} cents={b.cents} />)}
              </TBody>
            </Table>
            {l.negativeDays.length > 0 ? (
              <Alert variant="error" data-testid="negative-days">
                <p>{t("historical.negativeDays")}</p>
                <ul className="mt-1 list-inside list-disc">
                  {l.negativeDays.slice(0, 20).map((d) => (
                    <li key={`${d.account}-${d.day}`}>
                      {formatDay(d.day)} — {t(`finance.accounts.${d.account}`)}: <Money cents={d.cents} />
                    </li>
                  ))}
                </ul>
              </Alert>
            ) : (
              <Alert variant="success">{t("historical.noNegative")}</Alert>
            )}
            <ul className="grid gap-1 text-sm">
              <li>{t("historical.overdue", { count: l.overdueInstalments.count })} <Money cents={l.overdueInstalments.cents} /></li>
              <li>{t("historical.cheques", { count: l.chequesInCollection.count })} <Money cents={l.chequesInCollection.cents} /></li>
              <li>{t("historical.expired", { count: l.expiredPolicies })}</li>
            </ul>
          </CardContent>
        </Card>
      )}
      {l && <Finish list={l} />}
    </div>
  );
}
