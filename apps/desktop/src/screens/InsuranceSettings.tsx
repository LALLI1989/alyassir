import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { InsuranceCatalogDto } from "@alyassir/shared";
import { Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Checkbox, Input, Label, NativeSelect, Table, TBody, Td, Th, THead, Tr } from "@alyassir/ui";
import { asClientError } from "../adapters";
import { Field, PageHeader } from "../components/common";
import { Money, useCatalog } from "../components/insurance";
import { ErrorMessage, fieldsOf, useFieldError } from "../lib/errors";
import { api } from "../lib/session";

/** One small form + its call; the catalog is refreshed from the answer. */
function useCatalogCall() {
  const queries = useQueryClient();
  return useMutation({
    mutationFn: ({ method, path, body }: { method: string; path: string; body: unknown }) => api<InsuranceCatalogDto>(method, path, body),
    onSuccess: (c) => queries.setQueryData(["catalog"], c),
  });
}

function Section({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        {description && <CardDescription>{description}</CardDescription>}
      </CardHeader>
      <CardContent className="grid gap-4">{children}</CardContent>
    </Card>
  );
}

function ArchiveButton({ path, version, archived }: { path: string; version: number; archived: boolean }) {
  const { t } = useTranslation();
  const call = useCatalogCall();
  return (
    <Button size="sm" variant="ghost" disabled={call.isPending} onClick={() => call.mutate({ method: "POST", path, body: { version, archived: !archived } })}>
      {archived ? t("common.restore") : t("common.archive")}
    </Button>
  );
}

export function InsuranceSettings() {
  const { t } = useTranslation();
  const fieldError = useFieldError();
  const catalog = useCatalog().data;
  const call = useCatalogCall();
  const [insurer, setInsurer] = useState("");
  const [type, setType] = useState({ insurerId: "", nameAr: "", nameFr: "", requiresVehicle: true, supportsFleet: false });
  const [months, setMonths] = useState("");
  const [op, setOp] = useState({ nameAr: "", nameFr: "" });
  const error = call.error ? asClientError(call.error) : null;
  const fields = fieldsOf(error);
  if (!catalog) return null;
  const submit = (method: string, path: string, body: unknown, reset: () => void) => (e: FormEvent) => {
    e.preventDefault();
    call.mutate({ method, path, body }, { onSuccess: reset });
  };
  const status = (archived: boolean) => archived && <Badge variant="outline">{t("common.archived")}</Badge>;

  return (
    <div className="grid gap-5">
      <PageHeader title={t("insurance.title")} intro={t("insurance.intro")} />
      {error && error.code !== "VALIDATION" && <ErrorMessage error={error} />}

      <Section title={t("insurance.insurers")}>
        <Table>
          <TBody>
            {catalog.insurers.map((i) => (
              <Tr key={i.id}>
                <Td dir="auto">{i.name}</Td>
                <Td>{status(i.archived)}</Td>
                <Td className="text-end"><ArchiveButton path={`/api/insurance/insurers/${i.id}/archive`} version={i.version} archived={i.archived} /></Td>
              </Tr>
            ))}
          </TBody>
        </Table>
        <form className="flex flex-wrap items-end gap-2" onSubmit={submit("POST", "/api/insurance/insurers", { name: insurer }, () => setInsurer(""))}>
          <Field id="insurerName" label={t("insurance.name")} error={fieldError(fields.name)}>
            <Input id="insurerName" dir="auto" value={insurer} onChange={(e) => setInsurer(e.target.value)} />
          </Field>
          <Button type="submit" disabled={call.isPending}>{t("insurance.addInsurer")}</Button>
        </form>
      </Section>

      <Section title={t("insurance.types")} description={t("insurance.typeRulesHint")}>
        <Table>
          <THead>
            <Tr>
              <Th>{t("insurance.nameAr")}</Th>
              <Th>{t("insurance.nameFr")}</Th>
              <Th>{t("policies.insurer")}</Th>
              <Th>{t("insurance.requiresVehicle")}</Th>
              <Th>{t("insurance.supportsFleet")}</Th>
              <Th />
            </Tr>
          </THead>
          <TBody>
            {catalog.types.map((x) => (
              <Tr key={x.id}>
                <Td dir="rtl">{x.nameAr}</Td>
                <Td dir="ltr">{x.nameFr}</Td>
                <Td>{x.insurerName}</Td>
                <Td>{x.requiresVehicle ? t("common.yes") : t("common.no")}</Td>
                <Td>{x.supportsFleet ? t("common.yes") : t("common.no")}</Td>
                <Td className="text-end">
                  {status(x.archived)}
                  <ArchiveButton path={`/api/insurance/types/${x.id}/archive`} version={x.version} archived={x.archived} />
                </Td>
              </Tr>
            ))}
          </TBody>
        </Table>
        <form className="grid gap-3 sm:grid-cols-3" onSubmit={submit("POST", "/api/insurance/types", type, () => setType({ ...type, nameAr: "", nameFr: "" }))}>
          <Field id="typeInsurer" label={t("policies.insurer")} error={fieldError(fields.insurerId)}>
            <NativeSelect id="typeInsurer" value={type.insurerId} onChange={(e) => setType({ ...type, insurerId: e.target.value })}>
              <option value="" />
              {catalog.insurers.filter((i) => !i.archived).map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}
            </NativeSelect>
          </Field>
          <Field id="typeNameAr" label={t("insurance.nameAr")} error={fieldError(fields.nameAr)}>
            <Input id="typeNameAr" dir="rtl" value={type.nameAr} onChange={(e) => setType({ ...type, nameAr: e.target.value })} />
          </Field>
          <Field id="typeNameFr" label={t("insurance.nameFr")} error={fieldError(fields.nameFr)}>
            <Input id="typeNameFr" dir="ltr" value={type.nameFr} onChange={(e) => setType({ ...type, nameFr: e.target.value })} />
          </Field>
          <div className="flex items-center gap-2">
            <Checkbox id="requiresVehicle" checked={type.requiresVehicle} onCheckedChange={(v) => setType({ ...type, requiresVehicle: v === true, supportsFleet: v === true && type.supportsFleet })} />
            <Label htmlFor="requiresVehicle">{t("insurance.requiresVehicle")}</Label>
          </div>
          <div className="flex items-center gap-2">
            <Checkbox id="supportsFleet" checked={type.supportsFleet} disabled={!type.requiresVehicle} onCheckedChange={(v) => setType({ ...type, supportsFleet: v === true })} />
            <Label htmlFor="supportsFleet">{t("insurance.supportsFleet")}</Label>
          </div>
          <div className="flex justify-end">
            <Button type="submit" disabled={call.isPending}>{t("insurance.addType")}</Button>
          </div>
        </form>
      </Section>

      <Section title={t("insurance.durations")}>
        <p className="flex gap-1 text-sm">
          {t("insurance.fee")}
          <Money cents={catalog.certificateFeeCents} />
        </p>
        <div className="flex flex-wrap gap-2">
          {catalog.durations.map((d) => (
            <span key={d.id} className="inline-flex items-center gap-1 rounded-md border px-2 py-1 text-sm">
              {t("policies.months", { count: d.months })}
              {status(d.archived)}
              <ArchiveButton path={`/api/insurance/durations/${d.id}/archive`} version={d.version} archived={d.archived} />
            </span>
          ))}
        </div>
        <form className="flex flex-wrap items-end gap-2" onSubmit={submit("POST", "/api/insurance/durations", { months: Number.parseInt(months, 10) }, () => setMonths(""))}>
          <Field id="months" label={t("insurance.months")} error={fieldError(fields.months)}>
            <Input id="months" dir="ltr" inputMode="numeric" className="w-28" value={months} onChange={(e) => setMonths(e.target.value)} />
          </Field>
          <Button type="submit" disabled={call.isPending}>{t("insurance.addDuration")}</Button>
        </form>
      </Section>

      <Section title={t("insurance.operationTypes")}>
        <Table>
          <TBody>
            {catalog.operationTypes.map((o) => (
              <Tr key={o.code}>
                <Td dir="rtl">{o.nameAr}</Td>
                <Td dir="ltr">{o.nameFr}</Td>
                <Td>{o.isSystem ? <Badge variant="secondary">{t("insurance.system")}</Badge> : status(o.archived)}</Td>
                <Td className="text-end">{!o.isSystem && <ArchiveButton path={`/api/insurance/operation-types/${o.code}/archive`} version={o.version} archived={o.archived} />}</Td>
              </Tr>
            ))}
          </TBody>
        </Table>
        <form className="grid gap-3 sm:grid-cols-3" onSubmit={submit("POST", "/api/insurance/operation-types", op, () => setOp({ nameAr: "", nameFr: "" }))}>
          <Field id="opNameAr" label={t("insurance.nameAr")}>
            <Input id="opNameAr" dir="rtl" value={op.nameAr} onChange={(e) => setOp({ ...op, nameAr: e.target.value })} />
          </Field>
          <Field id="opNameFr" label={t("insurance.nameFr")}>
            <Input id="opNameFr" dir="ltr" value={op.nameFr} onChange={(e) => setOp({ ...op, nameFr: e.target.value })} />
          </Field>
          <div className="flex items-end">
            <Button type="submit" disabled={call.isPending}>{t("insurance.addOperationType")}</Button>
          </div>
        </form>
      </Section>
    </div>
  );
}
