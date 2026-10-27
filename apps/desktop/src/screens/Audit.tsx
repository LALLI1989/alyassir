import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Fragment, useState } from "react";
import { useTranslation } from "react-i18next";
import type { AuditEntryDto, DirectoryUserDto, Page } from "@alyassir/shared";
import { Button, Input, Label, NativeSelect, Table, TBody, Td, Th, THead, Tr } from "@alyassir/ui";
import { asClientError } from "../adapters";
import { PageHeader, Pager } from "../components/common";
import { ErrorMessage } from "../lib/errors";
import { businessDayBound, formatDateTime } from "../lib/format";
import { api } from "../lib/session";

const ACTIONS = [
  "system.install", "auth.login", "auth.logout", "auth.login_failed", "auth.locked",
  "user.create", "user.update", "user.permissions", "user.reset_password", "user.change_password",
  "user.disable", "user.enable", "user.unlock", "user.language",
  "settings.update", "settings.logo_set", "settings.logo_removed",
  "edit_request.create", "edit_request.approve", "edit_request.reject", "edit_request.used",
];

function Json({ value }: { value: unknown }) {
  if (value === null || value === undefined) return null;
  return <pre dir="ltr" className="max-h-64 overflow-auto rounded bg-muted p-2 text-start text-xs">{JSON.stringify(value, null, 2)}</pre>;
}

export function Audit() {
  const { t } = useTranslation();
  const [page, setPage] = useState(1);
  const [userId, setUserId] = useState("");
  const [action, setAction] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const users = useQuery({ queryKey: ["directory"], queryFn: () => api<DirectoryUserDto[]>("GET", "/api/users/directory") }).data ?? [];

  const params = new URLSearchParams({ page: String(page), pageSize: "50" });
  if (userId) params.set("userId", userId);
  if (action) params.set("action", action);
  const f = businessDayBound(from, false);
  const tt = businessDayBound(to, true);
  if (f) params.set("from", f);
  if (tt) params.set("to", tt);
  const audit = useQuery({
    queryKey: ["audit", params.toString()],
    queryFn: () => api<Page<AuditEntryDto>>("GET", `/api/audit?${params.toString()}`),
    placeholderData: keepPreviousData,
  });
  const actionLabel = (a: string) => t(`audit.actions.${a.replace(/\./g, "_")}`, { defaultValue: a });
  const reset = () => setPage(1);

  return (
    <div>
      <PageHeader title={t("audit.title")} intro={t("audit.intro")} />
      <div className="mb-3 flex flex-wrap items-end gap-3">
        <NativeSelect aria-label={t("audit.who")} className="w-48" value={userId} onChange={(e) => { setUserId(e.target.value); reset(); }}>
          <option value="">{t("audit.filterUser")}</option>
          {users.map((u) => <option key={u.id} value={u.id}>{u.displayName}</option>)}
        </NativeSelect>
        <NativeSelect aria-label={t("audit.action")} className="w-60" value={action} onChange={(e) => { setAction(e.target.value); reset(); }}>
          <option value="">{t("audit.filterAction")}</option>
          {ACTIONS.map((a) => <option key={a} value={a}>{actionLabel(a)}</option>)}
        </NativeSelect>
        <div className="grid gap-1">
          <Label htmlFor="from">{t("common.from")}</Label>
          <Input id="from" type="date" className="w-40" value={from} onChange={(e) => { setFrom(e.target.value); reset(); }} />
        </div>
        <div className="grid gap-1">
          <Label htmlFor="to">{t("common.to")}</Label>
          <Input id="to" type="date" className="w-40" value={to} onChange={(e) => { setTo(e.target.value); reset(); }} />
        </div>
      </div>
      <ErrorMessage error={audit.error ? asClientError(audit.error) : null} />
      <div className="rounded-lg border bg-card">
        <Table>
          <THead>
            <Tr>
              <Th>{t("audit.when")}</Th>
              <Th>{t("audit.who")}</Th>
              <Th>{t("audit.action")}</Th>
              <Th>{t("audit.entity")}</Th>
              <Th>{t("audit.device")}</Th>
              <Th>{t("common.details")}</Th>
            </Tr>
          </THead>
          <TBody>
            {(audit.data?.items ?? []).map((e) => (
              <Fragment key={e.id}>
                <Tr>
                  <Td className="whitespace-nowrap">{formatDateTime(e.at)}</Td>
                  <Td>{e.userName ?? t("audit.system")}</Td>
                  <Td>{actionLabel(e.action)}</Td>
                  <Td className="text-xs text-muted-foreground"><bdi dir="ltr">{e.entityType ?? ""}</bdi></Td>
                  <Td><bdi dir="ltr">{e.device ?? ""}</bdi></Td>
                  <Td>
                    {(e.before !== null || e.after !== null || e.reason) && (
                      <Button size="sm" variant="ghost" onClick={() => setOpen(open === e.id ? null : e.id)}>{t("common.details")}</Button>
                    )}
                  </Td>
                </Tr>
                {open === e.id && (
                  <Tr>
                    <Td colSpan={6}>
                      <div className="grid gap-2 md:grid-cols-2">
                        <div><p className="mb-1 text-xs font-semibold">{t("audit.before")}</p><Json value={e.before} /></div>
                        <div><p className="mb-1 text-xs font-semibold">{t("audit.after")}</p><Json value={e.after} /></div>
                      </div>
                      {e.reason && <p className="mt-2 text-sm">{t("common.reason")}: {e.reason}</p>}
                    </Td>
                  </Tr>
                )}
              </Fragment>
            ))}
          </TBody>
        </Table>
      </div>
      <div className="mt-3">
        <Pager page={page} pages={Math.max(1, Math.ceil((audit.data?.total ?? 0) / 50))} total={audit.data?.total ?? 0} onPage={setPage} />
      </div>
    </div>
  );
}
