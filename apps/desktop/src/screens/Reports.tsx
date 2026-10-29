import { useMutation, useQuery } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import type { AgencySettingsDto, ExcelFileDto, ReportCode, ReportColumn, ReportDto, ReportInfoDto, ReportRequest, ReportsIndexDto } from "@alyassir/shared";
import { Alert, Button, Card, CardContent, Input, Label, NativeSelect, Table, TBody, Td, Th, THead, Tr } from "@alyassir/ui";
import { adapter, asClientError } from "../adapters";
import { PageHeader } from "../components/common";
import { Code, Money, formatDay } from "../components/insurance";
import { ErrorMessage } from "../lib/errors";
import { formatDateTime } from "../lib/format";
import { api } from "../lib/session";

type Filters = Omit<ReportRequest, "language">;

/** "2026-10-27 09:05" (Casablanca, from the server) -> "27/10/2026 09:05". */
function formatLocal(v: string): string {
  const [d, time] = v.split(" ");
  return `${formatDay(d)}${time ? ` ${time}` : ""}`;
}

function Cell({ column, value, plain }: { column: ReportColumn; value: string | number | null | undefined; plain?: boolean }) {
  if (value === null || value === undefined || value === "") return null;
  if (column.type === "money") return <Money cents={Number(value)} />;
  if (column.type === "date") return <>{formatDay(String(value))}</>;
  if (column.type === "datetime") return <bdi dir="ltr">{formatLocal(String(value))}</bdi>;
  if (column.type === "code") return plain ? <bdi dir="ltr">{String(value)}</bdi> : <Code>{String(value)}</Code>;
  return <>{String(value)}</>;
}

function ReportTable({ report, plain }: { report: ReportDto; plain?: boolean }) {
  const { t } = useTranslation();
  const hasTotals = Object.keys(report.totals).length > 0;
  return (
    <Table data-testid={plain ? undefined : "report-table"}>
      <THead>
        <Tr>
          {report.columns.map((c) => (
            <Th key={c.key}>{c.label}</Th>
          ))}
        </Tr>
      </THead>
      <TBody>
        {report.rows.map((r, i) => (
          <Tr key={i}>
            {report.columns.map((c) => (
              <Td key={c.key}>
                <Cell column={c} value={r[c.key]} plain={plain} />
              </Td>
            ))}
          </Tr>
        ))}
        {hasTotals && (
          <Tr className="font-bold" data-testid={plain ? undefined : "report-totals"}>
            {report.columns.map((c, i) => (
              <Td key={c.key}>{c.key in report.totals ? <Cell column={c} value={report.totals[c.key]} plain={plain} /> : i === 0 ? t("reports.total") : null}</Td>
            ))}
          </Tr>
        )}
      </TBody>
    </Table>
  );
}

function Select({ id, label, value, onChange, children }: { id: string; label: string; value: string; onChange: (v: string) => void; children: ReactNode }) {
  const { t } = useTranslation();
  return (
    <div className="grid gap-1">
      <Label htmlFor={id}>{label}</Label>
      <NativeSelect id={id} value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">{t("common.all")}</option>
        {children}
      </NativeSelect>
    </div>
  );
}

/** Reports (SPEC 19): choose, filter, show with totals; print to PDF (A4 landscape) or save as Excel. */
export function Reports() {
  const { t, i18n } = useTranslation();
  const language = i18n.language === "fr" ? "fr" : "ar";
  const index = useQuery({ queryKey: ["reports"], queryFn: () => api<ReportsIndexDto>("GET", "/api/reports") });
  const settings = useQuery({ queryKey: ["settings"], queryFn: () => api<AgencySettingsDto>("GET", "/api/settings/agency") }).data;
  const [code, setCode] = useState<ReportCode | "">("");
  const [filters, setFilters] = useState<Filters>({});
  const [saved, setSaved] = useState<string | null>(null);
  const data = index.data;
  const info: ReportInfoDto | undefined = data?.reports.find((r) => r.code === code);
  const has = (f: ReportInfoDto["filters"][number]) => info?.filters.includes(f) ?? false;
  const set = (patch: Partial<Filters>) => setFilters((f) => ({ ...f, ...patch }));
  const pick = (v: string) => (v === "" ? undefined : v);

  const body = (): ReportRequest => {
    const period = data?.defaultPeriod;
    return {
      language,
      ...(has("period") ? { from: filters.from ?? period?.from, to: filters.to ?? period?.to } : {}),
      ...(has("insurer") && filters.insurerId ? { insurerId: filters.insurerId } : {}),
      ...(has("type") && filters.typeId ? { typeId: filters.typeId } : {}),
      ...(has("status") && filters.status ? { status: filters.status } : {}),
      ...(has("user") && filters.userId ? { userId: filters.userId } : {}),
      ...(has("account") && filters.account ? { account: filters.account } : {}),
      ...(has("method") && filters.method ? { method: filters.method } : {}),
      ...(has("origin") && filters.origin ? { origin: filters.origin } : {}),
    };
  };
  const run = useMutation({ mutationFn: () => api<ReportDto>("POST", `/api/reports/${code}`, body()) });
  const excel = useMutation({
    mutationFn: async () => {
      const file = await api<ExcelFileDto>("POST", `/api/reports/${code}/excel`, body());
      return (await adapter.saveFile(file.fileName, file.dataBase64)) ?? file.fileName;
    },
    onSuccess: (where) => setSaved(where),
  });
  const report = run.data && run.data.code === code ? run.data : null;
  const agency = settings ? (language === "fr" ? settings.nameFr : settings.nameAr) : "";

  return (
    <div className="grid gap-5">
      <PageHeader title={t("reports.title")} intro={t("reports.intro")} />
      {index.error && <ErrorMessage error={asClientError(index.error)} />}
      <Card>
        <CardContent className="grid gap-4 pt-5">
          <div className="grid gap-1 sm:max-w-md">
            <Label htmlFor="reportCode">{t("reports.choose")}</Label>
            <NativeSelect
              id="reportCode"
              value={code}
              onChange={(e) => {
                setCode(e.target.value as ReportCode);
                setFilters({});
                setSaved(null);
                run.reset();
              }}
            >
              <option value="">{t("reports.choosePlaceholder")}</option>
              {data?.reports.map((r) => (
                <option key={r.code} value={r.code}>
                  {t(`reports.titles.${r.code}`)}
                </option>
              ))}
            </NativeSelect>
          </div>
          {info && (
            <div className="flex flex-wrap items-end gap-4">
              {has("period") && (
                <>
                  <div className="grid gap-1">
                    <Label htmlFor="reportFrom">{t("common.from")}</Label>
                    <Input id="reportFrom" type="date" value={filters.from ?? data?.defaultPeriod.from ?? ""} onChange={(e) => set({ from: pick(e.target.value) })} />
                  </div>
                  <div className="grid gap-1">
                    <Label htmlFor="reportTo">{t("common.to")}</Label>
                    <Input id="reportTo" type="date" value={filters.to ?? data?.defaultPeriod.to ?? ""} onChange={(e) => set({ to: pick(e.target.value) })} />
                  </div>
                </>
              )}
              {has("insurer") && (
                <Select id="reportInsurer" label={t("reports.filters.insurer")} value={filters.insurerId ?? ""} onChange={(v) => set({ insurerId: pick(v), typeId: undefined })}>
                  {data?.insurers.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}
                </Select>
              )}
              {has("type") && (
                <Select id="reportType" label={t("reports.filters.type")} value={filters.typeId ?? ""} onChange={(v) => set({ typeId: pick(v) })}>
                  {data?.types.filter((x) => !filters.insurerId || x.insurerId === filters.insurerId).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
                </Select>
              )}
              {has("status") && info.statusPrefix && (
                <Select id="reportStatus" label={t("reports.filters.status")} value={filters.status ?? ""} onChange={(v) => set({ status: pick(v) })}>
                  {info.statuses.map((s) => <option key={s} value={s}>{t(`${info.statusPrefix}.${s}`)}</option>)}
                </Select>
              )}
              {has("user") && (
                <Select id="reportUser" label={t("reports.filters.user")} value={filters.userId ?? ""} onChange={(v) => set({ userId: pick(v) })}>
                  {data?.users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
                </Select>
              )}
              {has("account") && info.accounts.length > 1 && (
                <Select id="reportAccount" label={t("reports.filters.account")} value={filters.account ?? ""} onChange={(v) => set({ account: pick(v) as Filters["account"] })}>
                  {info.accounts.map((a) => <option key={a} value={a}>{t(`finance.accounts.${a}`)}</option>)}
                </Select>
              )}
              {has("method") && (
                <Select id="reportMethod" label={t("reports.filters.method")} value={filters.method ?? ""} onChange={(v) => set({ method: pick(v) as Filters["method"] })}>
                  {(["cash", "cheque", "transfer", "card"] as const).filter((m) => code !== "collections" || m !== "cash").map((m) => <option key={m} value={m}>{t(`finance.methods.${m}`)}</option>)}
                </Select>
              )}
              {has("origin") && (
                <Select id="reportOrigin" label={t("reports.filters.origin")} value={filters.origin ?? ""} onChange={(v) => set({ origin: pick(v) as Filters["origin"] })}>
                  {(["historical", "live"] as const).map((o) => <option key={o} value={o}>{t(`reports.origins.${o}`)}</option>)}
                </Select>
              )}
              <Button onClick={() => { setSaved(null); run.mutate(); }} disabled={run.isPending}>
                {t("reports.show")}
              </Button>
            </div>
          )}
          {run.error && <ErrorMessage error={asClientError(run.error)} />}
        </CardContent>
      </Card>

      {report && (
        <Card>
          <CardContent className="grid gap-3 pt-5">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h2 className="text-lg font-bold">{report.title}</h2>
                <p className="text-sm text-muted-foreground">{report.subtitle}</p>
                <p className="text-xs text-muted-foreground">{t("common.rows", { count: report.rows.length })}</p>
              </div>
              {data?.canExport && (
                <div className="flex gap-2">
                  <Button variant="outline" onClick={() => window.print()}>
                    {t("reports.print")}
                  </Button>
                  <Button variant="outline" onClick={() => excel.mutate()} disabled={excel.isPending}>
                    {t("reports.excel")}
                  </Button>
                </div>
              )}
            </div>
            {saved && <Alert variant="success">{t("reports.saved", { where: saved })}</Alert>}
            {excel.error && <ErrorMessage error={asClientError(excel.error)} />}
            {report.truncated && <Alert variant="warning">{t("reports.truncated", { max: report.rows.length })}</Alert>}
            {report.rows.length === 0 ? <p className="text-sm text-muted-foreground">{t("common.empty")}</p> : <div className="overflow-auto"><ReportTable report={report} /></div>}
          </CardContent>
        </Card>
      )}

      {report &&
        createPortal(
          <div className="print-root report-print" aria-hidden="true" dir={language === "ar" ? "rtl" : "ltr"}>
            <p style={{ fontWeight: 700, fontSize: "13pt" }}>{agency}</p>
            <p style={{ fontWeight: 700, fontSize: "12pt" }}>{report.title}</p>
            <p style={{ fontSize: "9pt" }}>{report.subtitle}</p>
            <p style={{ fontSize: "8pt", marginBottom: "4mm" }}>{t("reports.printedAt", { time: formatDateTime(report.generatedAt) })}</p>
            <ReportTable report={report} plain />
          </div>,
          document.body,
        )}
    </div>
  );
}
