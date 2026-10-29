import { useQuery } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { formatCents, type DashboardDto, type EditRequestDto } from "@alyassir/shared";
import { Card, CardContent, CardHeader, CardTitle, NativeSelect, Table, TBody, Td, Th, THead, Tr } from "@alyassir/ui";
import { Money, formatDay } from "../components/insurance";
import { formatDateTime } from "../lib/format";
import { api, useSession } from "../lib/session";
import type { Page } from "./Shell";

type PeriodKind = DashboardDto["period"]["kind"];

function Tile({ value, label, hint, onClick, testId }: { value: ReactNode; label: string; hint?: string; onClick?: () => void; testId?: string }) {
  const body = (
    <Card className={onClick ? "h-full transition-colors hover:bg-accent" : "h-full"} data-testid={testId}>
      <CardHeader>
        <CardTitle className="text-2xl">{value}</CardTitle>
        <p className="text-sm text-muted-foreground">{label}</p>
        {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
      </CardHeader>
    </Card>
  );
  return onClick ? (
    <button type="button" className="text-start" onClick={onClick}>
      {body}
    </button>
  ) : (
    body
  );
}

const axisTick = { fill: "var(--muted-foreground)", fontSize: 11 };
const tooltipStyle = { background: "var(--card)", border: "1px solid var(--border)", borderRadius: 6, color: "var(--foreground)" };

/** Home = dashboard (SPEC 19): every number comes from the server, each card only for who may see it. */
export function Home({ onOpen }: { onOpen: (page: Page) => void }) {
  const { t, i18n } = useTranslation();
  const { me, isManager } = useSession();
  const [period, setPeriod] = useState<PeriodKind>("month");
  const dash = useQuery({ queryKey: ["dashboard", period], queryFn: () => api<DashboardDto>("GET", `/api/dashboard?period=${period}`) }).data;
  const unread = useQuery({ queryKey: ["unread"], queryFn: () => api<{ count: number }>("GET", "/api/messages/unread-count") }).data?.count ?? 0;
  const requests = useQuery({ queryKey: ["editRequests"], queryFn: () => api<EditRequestDto[]>("GET", "/api/edit-requests"), enabled: isManager }).data ?? [];
  const pending = requests.filter((r) => r.status === "pending").length;
  const rtl = i18n.dir() === "rtl";
  const month = (m: string) => `${m.slice(5, 7)}/${m.slice(2, 4)}`;

  return (
    <div className="grid gap-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold">{t("home.welcome", { name: me?.displayName ?? "" })}</h1>
          {dash && <p className="text-sm text-muted-foreground">{t("dashboard.periodLine", { from: formatDay(dash.period.from), to: formatDay(dash.period.to) })}</p>}
        </div>
        <div className="grid gap-1">
          <label htmlFor="dashPeriod" className="text-sm font-medium">{t("dashboard.period")}</label>
          <NativeSelect id="dashPeriod" value={period} onChange={(e) => setPeriod(e.target.value as PeriodKind)}>
            <option value="today">{t("dashboard.periods.today")}</option>
            <option value="month">{t("dashboard.periods.month")}</option>
            <option value="year">{t("dashboard.periods.year")}</option>
          </NativeSelect>
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Tile value={dash?.reminders ?? 0} label={t("dashboard.reminders")} onClick={() => onOpen({ kind: "reminders" })} testId="dash-reminders" />
        <Tile value={unread} label={t("home.unreadMessages")} onClick={() => onOpen({ kind: "messages" })} />
        {isManager && <Tile value={pending} label={t("home.pendingRequests")} onClick={() => onOpen({ kind: "editRequests" })} />}
        {dash?.clients !== null && dash?.clients !== undefined && <Tile value={dash.clients} label={t("dashboard.clients")} onClick={() => onOpen({ kind: "clients" })} testId="dash-clients" />}
        {dash?.policies && (
          <>
            <Tile value={dash.policies.active} label={t("dashboard.activePolicies")} onClick={() => onOpen({ kind: "policies" })} testId="dash-active" />
            <Tile value={dash.policies.endingSoon} label={t("dashboard.endingSoon")} onClick={() => onOpen({ kind: "reminders" })} testId="dash-ending" />
            <Tile value={dash.policies.expired} label={t("dashboard.expiredPolicies")} onClick={() => onOpen({ kind: "policies" })} />
          </>
        )}
        {dash?.money && (
          <>
            <Tile value={<Money cents={dash.money.paymentsCents} />} label={t("dashboard.payments")} hint={t("dashboard.paymentsCount", { count: dash.money.paymentsCount })} testId="dash-payments" />
            <Tile value={<Money cents={dash.money.remainingCents} />} label={t("dashboard.remaining")} onClick={() => onOpen({ kind: "debts" })} testId="dash-remaining" />
            <Tile value={<Money cents={dash.money.expensesCents} />} label={t("dashboard.expenses")} testId="dash-expenses" />
            <Tile value={<Money cents={dash.money.inCollectionCents} />} label={t("dashboard.inCollection")} hint={t("dashboard.paymentsCount", { count: dash.money.inCollectionCount })} />
          </>
        )}
        {dash?.balances?.drawer !== null && dash?.balances?.drawer !== undefined && <Tile value={<Money cents={dash.balances.drawer} />} label={t("finance.accounts.drawer")} testId="dash-drawer" />}
        {dash?.balances?.safe !== null && dash?.balances?.safe !== undefined && <Tile value={<Money cents={dash.balances.safe} />} label={t("finance.accounts.safe")} onClick={() => onOpen({ kind: "accounts" })} />}
        {dash?.balances?.bank !== null && dash?.balances?.bank !== undefined && <Tile value={<Money cents={dash.balances.bank} />} label={t("finance.accounts.bank")} onClick={() => onOpen({ kind: "accounts" })} />}
        {dash?.openClaims !== null && dash?.openClaims !== undefined && <Tile value={dash.openClaims} label={t("dashboard.openClaims")} onClick={() => onOpen({ kind: "claims" })} />}
        {dash?.backup?.enabled && (
          <Tile
            value={<span className={dash.backup.late ? "text-destructive" : undefined}>{dash.backup.lastOkAt ? formatDateTime(dash.backup.lastOkAt) : t("dashboard.backupNever")}</span>}
            label={t("dashboard.backup")}
            hint={dash.backup.late ? t("dashboard.backupLate") : undefined}
            onClick={() => onOpen({ kind: "backups" })}
            testId="dash-backup"
          />
        )}
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        {dash?.charts.paymentsByDay && (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">{t("dashboard.chartPayments")}</CardTitle>
            </CardHeader>
            <CardContent className="h-64" dir="ltr" data-testid="chart-payments">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={dash.charts.paymentsByDay} margin={{ top: 4, right: 8, left: 8, bottom: 0 }}>
                  <CartesianGrid vertical={false} stroke="var(--border)" />
                  <XAxis dataKey="day" tickFormatter={(d: string) => d.slice(8, 10)} tick={axisTick} reversed={rtl} tickLine={false} axisLine={false} />
                  <YAxis tickFormatter={(c: number) => formatCents(c).split(",")[0] ?? ""} tick={axisTick} orientation={rtl ? "right" : "left"} width={70} tickLine={false} axisLine={false} />
                  <Tooltip
                    cursor={{ fill: "var(--accent)" }}
                    contentStyle={tooltipStyle}
                    labelFormatter={(d) => formatDay(String(d))}
                    formatter={(c) => [`${formatCents(Number(c))} ${t("money.mad")}`, t("dashboard.payments")]}
                  />
                  <Bar dataKey="cents" fill="var(--chart-1)" radius={[4, 4, 0, 0]} maxBarSize={28} isAnimationActive={false} />
                </BarChart>
              </ResponsiveContainer>
            </CardContent>
          </Card>
        )}
        {dash?.charts.policiesByMonth && (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">{t("dashboard.chartPolicies")}</CardTitle>
            </CardHeader>
            <CardContent className="h-64" dir="ltr" data-testid="chart-policies">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={dash.charts.policiesByMonth} margin={{ top: 4, right: 8, left: 8, bottom: 0 }} barGap={2}>
                  <CartesianGrid vertical={false} stroke="var(--border)" />
                  <XAxis dataKey="month" tickFormatter={month} tick={axisTick} reversed={rtl} tickLine={false} axisLine={false} />
                  <YAxis allowDecimals={false} tick={axisTick} orientation={rtl ? "right" : "left"} width={40} tickLine={false} axisLine={false} />
                  <Tooltip cursor={{ fill: "var(--accent)" }} contentStyle={tooltipStyle} labelFormatter={(m) => month(String(m))} />
                  <Legend wrapperStyle={{ fontSize: 12, color: "var(--foreground)" }} />
                  <Bar dataKey="newIssues" name={t("policies.periodOps.new_issue")} fill="var(--chart-1)" radius={[4, 4, 0, 0]} maxBarSize={18} isAnimationActive={false} />
                  <Bar dataKey="renewals" name={t("policies.periodOps.renewal")} fill="var(--chart-2)" radius={[4, 4, 0, 0]} maxBarSize={18} isAnimationActive={false} />
                </BarChart>
              </ResponsiveContainer>
            </CardContent>
          </Card>
        )}
      </div>

      {dash?.activity && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{t("dashboard.activity")}</CardTitle>
          </CardHeader>
          <CardContent>
            <Table>
              <THead>
                <Tr>
                  <Th>{t("reports.columns.user")}</Th>
                  <Th>{t("dashboard.actionsToday")}</Th>
                  <Th>{t("reports.columns.lastAt")}</Th>
                </Tr>
              </THead>
              <TBody>
                {dash.activity.map((a) => (
                  <Tr key={a.userId}>
                    <Td>{a.name}</Td>
                    <Td>{a.actions}</Td>
                    <Td>{formatDateTime(a.lastAt)}</Td>
                  </Tr>
                ))}
              </TBody>
            </Table>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
