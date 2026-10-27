import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import {
  CLIENT_KINDS,
  ID_TYPES_BY_KIND,
  RESIDENCIES,
  clientSchema,
  type ClientDto,
  type ClientKind,
  type IdType,
  type Page as PageOf,
  type Residency,
} from "@alyassir/shared";
import { Badge, Button, Checkbox, Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, Input, Label, NativeSelect, Table, TBody, Td, Th, THead, Tr } from "@alyassir/ui";
import { asClientError } from "../adapters";
import { Field, PageHeader, Pager } from "../components/common";
import { Code } from "../components/insurance";
import { ErrorMessage, fieldsOf, useFieldError } from "../lib/errors";
import { api, useSession } from "../lib/session";
import type { Page } from "./Shell";

interface ClientForm {
  kind: ClientKind;
  fullName: string;
  companyName: string;
  idType: IdType;
  idNumber: string;
  residency: Residency | "";
  phone: string;
}

const EMPTY: ClientForm = { kind: "individual", fullName: "", companyName: "", idType: "cin", idNumber: "", residency: "", phone: "" };

function toBody(f: ClientForm) {
  return {
    kind: f.kind,
    fullName: f.fullName,
    companyName: f.kind === "company" && f.companyName.trim() ? f.companyName : null,
    idType: f.idType,
    idNumber: f.idNumber,
    residency: f.kind === "foreign" && f.residency ? f.residency : null,
    phone: f.phone,
  };
}

/** Add or edit a client (also used while creating a policy, SPEC 9.1). */
export function ClientDialog({ client, onDone, onCancel }: { client?: ClientDto; onDone: (c: ClientDto) => void; onCancel: () => void }) {
  const { t } = useTranslation();
  const fieldError = useFieldError();
  const queries = useQueryClient();
  const [form, setForm] = useState<ClientForm>(
    client
      ? { kind: client.kind, fullName: client.fullName, companyName: client.companyName ?? "", idType: client.idType, idNumber: client.idNumber, residency: client.residency ?? "", phone: client.phone }
      : EMPTY,
  );
  const [local, setLocal] = useState<Record<string, string>>({});
  const save = useMutation({
    mutationFn: () =>
      client
        ? api<ClientDto>("PATCH", `/api/clients/${client.id}`, { ...toBody(form), version: client.version })
        : api<ClientDto>("POST", "/api/clients", toBody(form)),
    onSuccess: async (c) => {
      await queries.invalidateQueries({ queryKey: ["clients"] });
      await queries.invalidateQueries({ queryKey: ["client"] });
      onDone(c);
    },
  });
  const set = (patch: Partial<ClientForm>) => setForm((f) => ({ ...f, ...patch }));
  function submit(e: FormEvent) {
    e.preventDefault();
    const parsed = clientSchema.safeParse(toBody(form));
    const errors: Record<string, string> = {};
    if (!parsed.success) for (const i of parsed.error.issues) errors[i.path.join(".")] ??= i.message;
    setLocal(errors);
    if (!Object.keys(errors).length) save.mutate();
  }
  const error = save.error ? asClientError(save.error) : null;
  const server = fieldsOf(error);
  const err = (k: string) => fieldError(local[k] ?? server[k]);
  return (
    <form onSubmit={submit} className="grid gap-4">
      <DialogHeader>
        <DialogTitle>{client ? t("clients.editTitle") : t("clients.addTitle")}</DialogTitle>
      </DialogHeader>
      <Field id="clientKind" label={t("clients.kind")}>
        <NativeSelect
          id="clientKind"
          value={form.kind}
          onChange={(e) => {
            const kind = e.target.value as ClientKind;
            set({ kind, idType: ID_TYPES_BY_KIND[kind][0] as IdType });
          }}
        >
          {CLIENT_KINDS.map((k) => <option key={k} value={k}>{t(`clients.kinds.${k}`)}</option>)}
        </NativeSelect>
      </Field>
      {form.kind === "company" && (
        <Field id="companyName" label={t("clients.companyName")} error={err("companyName")}>
          <Input id="companyName" dir="auto" value={form.companyName} onChange={(e) => set({ companyName: e.target.value })} />
        </Field>
      )}
      <Field id="fullName" label={form.kind === "company" ? t("clients.contactName") : t("clients.fullName")} error={err("fullName")}>
        <Input id="fullName" dir="auto" value={form.fullName} onChange={(e) => set({ fullName: e.target.value })} />
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field id="idType" label={t("clients.idType")} error={err("idType")}>
          <NativeSelect id="idType" value={form.idType} onChange={(e) => set({ idType: e.target.value as IdType })}>
            {ID_TYPES_BY_KIND[form.kind].map((k) => <option key={k} value={k}>{t(`clients.idTypes.${k}`)}</option>)}
          </NativeSelect>
        </Field>
        <Field id="idNumber" label={t("clients.idNumber")} hint={t(`clients.idHints.${form.idType}`)} error={err("idNumber")}>
          <Input id="idNumber" dir="ltr" value={form.idNumber} onChange={(e) => set({ idNumber: e.target.value })} />
        </Field>
      </div>
      {form.kind === "foreign" && (
        <Field id="residency" label={t("clients.residency")} error={err("residency")}>
          <NativeSelect id="residency" value={form.residency} onChange={(e) => set({ residency: e.target.value as Residency | "" })}>
            <option value="" />
            {RESIDENCIES.map((r) => <option key={r} value={r}>{t(`clients.residencies.${r}`)}</option>)}
          </NativeSelect>
        </Field>
      )}
      <Field id="phone" label={t("clients.phone")} hint={t("clients.phoneHint")} error={err("phone")}>
        <Input id="phone" dir="ltr" inputMode="tel" value={form.phone} onChange={(e) => set({ phone: e.target.value })} />
      </Field>
      {error && error.code !== "VALIDATION" && <ErrorMessage error={error} />}
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onCancel}>{t("common.cancel")}</Button>
        <Button type="submit" disabled={save.isPending}>{client ? t("common.save") : t("common.create")}</Button>
      </DialogFooter>
    </form>
  );
}

export function clientDisplayName(c: Pick<ClientDto, "kind" | "fullName" | "companyName">): string {
  return c.kind === "company" && c.companyName ? c.companyName : c.fullName;
}

/** Search by part of the name, phone or identity (server-side, paged). */
export function Clients({ onOpen }: { onOpen: (page: Page) => void }) {
  const { t } = useTranslation();
  const { can } = useSession();
  const [q, setQ] = useState("");
  const [archived, setArchived] = useState(false);
  const [page, setPage] = useState(1);
  const [adding, setAdding] = useState(false);
  const list = useQuery({
    queryKey: ["clients", q, archived, page],
    queryFn: () => api<PageOf<ClientDto>>("GET", `/api/clients?q=${encodeURIComponent(q)}&includeArchived=${archived}&page=${page}&pageSize=25`),
    placeholderData: keepPreviousData,
  });
  const data = list.data;
  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;
  return (
    <div>
      <PageHeader
        title={t("clients.title")}
        intro={t("clients.intro")}
        actions={can("clients.create") && <Button onClick={() => setAdding(true)}>{t("clients.add")}</Button>}
      />
      <div className="mb-3 flex flex-wrap items-center gap-4">
        <Input
          className="max-w-sm"
          placeholder={t("clients.searchPlaceholder")}
          aria-label={t("common.search")}
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setPage(1);
          }}
        />
        <div className="flex items-center gap-2">
          <Checkbox id="showArchived" checked={archived} onCheckedChange={(v) => setArchived(v === true)} />
          <Label htmlFor="showArchived">{t("clients.includeArchived")}</Label>
        </div>
      </div>
      <div className="rounded-lg border bg-card">
        <Table>
          <THead>
            <Tr>
              <Th>{t("clients.fullName")}</Th>
              <Th>{t("clients.idNumber")}</Th>
              <Th>{t("clients.phone")}</Th>
              <Th>{t("clients.activePolicies")}</Th>
              <Th />
            </Tr>
          </THead>
          <TBody>
            {data && data.items.length === 0 && (
              <Tr>
                <Td colSpan={5} className="py-8 text-center text-muted-foreground">{t("common.empty")}</Td>
              </Tr>
            )}
            {data?.items.map((c) => (
              <Tr key={c.id}>
                <Td>
                  <div className="grid">
                    <span className="font-medium" dir="auto">{clientDisplayName(c)}</span>
                    <span className="text-xs text-muted-foreground">{t(`clients.kinds.${c.kind}`)}</span>
                  </div>
                </Td>
                <Td><Code>{c.idNumber}</Code></Td>
                <Td><Code>{c.phone}</Code></Td>
                <Td>{c.activePolicies}</Td>
                <Td className="text-end">
                  {c.archived && <Badge variant="outline" className="me-2">{t("common.archived")}</Badge>}
                  <Button size="sm" variant="outline" onClick={() => onOpen({ kind: "client", id: c.id })}>{t("common.open")}</Button>
                </Td>
              </Tr>
            ))}
          </TBody>
        </Table>
      </div>
      <div className="mt-3">
        <Pager page={page} pages={pages} total={data?.total ?? 0} onPage={setPage} />
      </div>
      <Dialog open={adding} onOpenChange={setAdding}>
        <DialogContent closeLabel={t("common.close")}>
          {adding && <ClientDialog onCancel={() => setAdding(false)} onDone={(c) => { setAdding(false); onOpen({ kind: "client", id: c.id }); }} />}
        </DialogContent>
      </Dialog>
    </div>
  );
}
