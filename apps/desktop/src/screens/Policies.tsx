import { keepPreviousData, useMutation, useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import type { ClientDto, ClientFileDto, DatesPreviewDto, Page as PageOf, PolicyDto, PolicySummaryDto, ValidityStatus } from "@alyassir/shared";
import {
  Alert,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Checkbox,
  Dialog,
  DialogContent,
  Input,
  Label,
  NativeSelect,
  Table,
  TBody,
  Td,
  Th,
  THead,
  Tr,
} from "@alyassir/ui";
import { asClientError } from "../adapters";
import { Field, PageHeader, Pager } from "../components/common";
import { Code, Money, MoneyInput, ValidityBadge, formatDay, useCatalog, useOperationKey } from "../components/insurance";
import { ErrorMessage, fieldsOf, useFieldError } from "../lib/errors";
import { api, useSession } from "../lib/session";
import { ClientDialog, clientDisplayName } from "./Clients";
import type { Page } from "./Shell";
import { VehicleDialog } from "./Vehicles";

export function Policies({ onOpen }: { onOpen: (page: Page) => void }) {
  const { t } = useTranslation();
  const { can } = useSession();
  const [q, setQ] = useState("");
  const [validity, setValidity] = useState<"all" | ValidityStatus>("all");
  const [endingSoon, setEndingSoon] = useState(false);
  const [page, setPage] = useState(1);
  const list = useQuery({
    queryKey: ["policies", q, validity, endingSoon, page],
    queryFn: () =>
      api<PageOf<PolicySummaryDto>>(
        "GET",
        `/api/policies?q=${encodeURIComponent(q)}&validity=${validity}${endingSoon ? "&endingWithinDays=30" : ""}&page=${page}&pageSize=25`,
      ),
    placeholderData: keepPreviousData,
  });
  const data = list.data;
  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;
  return (
    <div>
      <PageHeader
        title={t("policies.title")}
        intro={t("policies.intro")}
        actions={can("policies.create") && <Button onClick={() => onOpen({ kind: "policyNew" })}>{t("policies.new")}</Button>}
      />
      <div className="mb-3 flex flex-wrap items-end gap-4">
        <Input
          className="max-w-md"
          placeholder={t("policies.searchPlaceholder")}
          aria-label={t("common.search")}
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setPage(1);
          }}
        />
        <div className="grid gap-1">
          <Label htmlFor="validityFilter">{t("policies.filterValidity")}</Label>
          <NativeSelect id="validityFilter" value={validity} onChange={(e) => { setValidity(e.target.value as "all" | ValidityStatus); setPage(1); }}>
            <option value="all">{t("common.all")}</option>
            {(["active", "expired", "annulled", "cancelled"] as const).map((v) => <option key={v} value={v}>{t(`policies.validities.${v}`)}</option>)}
          </NativeSelect>
        </div>
        <div className="flex items-center gap-2 pb-2">
          <Checkbox id="endingSoon" checked={endingSoon} onCheckedChange={(v) => { setEndingSoon(v === true); setPage(1); }} />
          <Label htmlFor="endingSoon">{t("policies.endingSoon")}</Label>
        </div>
      </div>
      <PolicyTable rows={data?.items ?? []} onOpen={onOpen} />
      <div className="mt-3">
        <Pager page={page} pages={pages} total={data?.total ?? 0} onPage={setPage} />
      </div>
    </div>
  );
}

function PolicyTable({ rows, onOpen }: { rows: PolicySummaryDto[]; onOpen: (page: Page) => void }) {
  const { t } = useTranslation();
  return (
    <div className="rounded-lg border bg-card">
      <Table>
        <THead>
          <Tr>
            <Th>{t("policies.number")}</Th>
            <Th>{t("policies.client")}</Th>
            <Th>{t("policies.type")}</Th>
            <Th>{t("policies.vehicles")}</Th>
            <Th>{t("policies.start")}</Th>
            <Th>{t("policies.end")}</Th>
            <Th>{t("policies.amount")}</Th>
            <Th>{t("policies.validity")}</Th>
            <Th />
          </Tr>
        </THead>
        <TBody>
          {rows.length === 0 && (
            <Tr>
              <Td colSpan={9} className="py-8 text-center text-muted-foreground">{t("common.empty")}</Td>
            </Tr>
          )}
          {rows.map((p) => (
            <Tr key={p.id}>
              <Td>
                <div className="grid">
                  <Code>{p.policyNumber}</Code>
                  <span className="text-xs text-muted-foreground">{p.insurerName}</span>
                </div>
              </Td>
              <Td dir="auto">{p.clientName}</Td>
              <Td><bdi dir="ltr">{p.typeName}</bdi>{p.isFleet ? ` · ${t("policies.fleet")}` : ""}</Td>
              <Td>
                <div className="flex max-w-56 flex-wrap gap-1">{p.plates.slice(0, 3).map((plate) => <Code key={plate}>{plate}</Code>)}{p.plates.length > 3 ? ` +${p.plates.length - 3}` : ""}</div>
              </Td>
              <Td>{formatDay(p.startDate)}</Td>
              <Td>{formatDay(p.endDate)}</Td>
              <Td><Money cents={p.totalAmountCents} /></Td>
              <Td><ValidityBadge validity={p.validity} /></Td>
              <Td className="text-end">
                <Button size="sm" variant="outline" onClick={() => onOpen({ kind: "policy", id: p.id })}>{t("common.open")}</Button>
              </Td>
            </Tr>
          ))}
        </TBody>
      </Table>
    </div>
  );
}

/** Choose an existing client, or add one on the spot (SPEC 9.1). */
function ClientPicker({ onPick }: { onPick: (id: string) => void }) {
  const { t } = useTranslation();
  const { can } = useSession();
  const [q, setQ] = useState("");
  const [adding, setAdding] = useState(false);
  const found = useQuery({
    queryKey: ["clients", "pick", q],
    queryFn: () => api<PageOf<ClientDto>>("GET", `/api/clients?q=${encodeURIComponent(q)}&pageSize=10`),
    enabled: q.trim().length > 0,
  });
  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap gap-2">
        <Input className="max-w-sm" placeholder={t("clients.searchPlaceholder")} aria-label={t("policies.pickClient")} value={q} onChange={(e) => setQ(e.target.value)} />
        {can("clients.create") && <Button type="button" variant="outline" onClick={() => setAdding(true)}>{t("clients.add")}</Button>}
      </div>
      {found.data?.items.filter((c) => !c.archived).map((c) => (
        <button key={c.id} type="button" className="flex items-center justify-between rounded-md border p-2 text-start hover:bg-accent" onClick={() => onPick(c.id)}>
          <span dir="auto">{clientDisplayName(c)}</span>
          <Code>{c.idNumber}</Code>
        </button>
      ))}
      <Dialog open={adding} onOpenChange={setAdding}>
        <DialogContent closeLabel={t("common.close")}>
          {adding && <ClientDialog onCancel={() => setAdding(false)} onDone={(c) => { setAdding(false); onPick(c.id); }} />}
        </DialogContent>
      </Dialog>
    </div>
  );
}

/** New policy in three parts: client, vehicle(s), policy (SPEC 11). */
export function PolicyNew({ clientId: initialClient, onOpen }: { clientId?: string; onOpen: (page: Page) => void }) {
  const { t } = useTranslation();
  const fieldError = useFieldError();
  const { can } = useSession();
  const key = useOperationKey();
  const catalog = useCatalog().data;
  const [clientId, setClientId] = useState(initialClient ?? "");
  const [typeId, setTypeId] = useState("");
  const [isFleet, setIsFleet] = useState(false);
  const [fleetName, setFleetName] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [certificates, setCertificates] = useState<Record<string, string>>({});
  const [policyNumber, setPolicyNumber] = useState("");
  const [durationId, setDurationId] = useState("");
  const [typedEnd, setTypedEnd] = useState<string | null>(null);
  const [amount, setAmount] = useState<number | null>(null);
  const [addingVehicle, setAddingVehicle] = useState(false);

  const file = useQuery({ queryKey: ["client", clientId], queryFn: () => api<ClientFileDto>("GET", `/api/clients/${clientId}`), enabled: Boolean(clientId) });
  const types = useMemo(() => (catalog?.types ?? []).filter((x) => !x.archived && !catalog?.insurers.find((i) => i.id === x.insurerId)?.archived), [catalog]);
  const type = types.find((x) => x.id === typeId);
  const durations = (catalog?.durations ?? []).filter((d) => !d.archived);
  useEffect(() => {
    if (!durationId && durations.length) setDurationId(durations.find((d) => d.months === 12)?.id ?? durations[0]?.id ?? "");
  }, [durations, durationId]);
  const preview = useQuery({
    queryKey: ["datesPreview", durationId],
    queryFn: () => api<DatesPreviewDto>("POST", "/api/policies/dates-preview", { coverageDurationId: durationId }),
    enabled: Boolean(durationId),
  });
  const freeVehicles = (file.data?.vehicles ?? []).filter((v) => !v.archived && !v.activePolicyId);
  const fleet = Boolean(type?.supportsFleet && isFleet);

  const create = useMutation({
    mutationFn: () =>
      api<PolicyDto>("POST", "/api/policies", {
        idempotencyKey: key,
        clientId,
        insuranceTypeId: typeId,
        policyNumber,
        coverageDurationId: durationId,
        endDate: typedEnd,
        totalAmountCents: amount,
        isFleet: fleet,
        fleetName,
        vehicles: type?.requiresVehicle ? selected.map((vehicleId) => ({ vehicleId, certificateNumber: certificates[vehicleId] ?? "" })) : [],
      }),
    onSuccess: (p) => onOpen({ kind: "policy", id: p.id }),
  });
  const error = create.error ? asClientError(create.error) : null;
  const fields = fieldsOf(error);

  function toggle(id: string, on: boolean) {
    if (!fleet) return setSelected(on ? [id] : []);
    setSelected((s) => (on ? [...s, id] : s.filter((x) => x !== id)));
  }
  function submit(e: FormEvent) {
    e.preventDefault();
    create.mutate();
  }

  return (
    <form onSubmit={submit} className="grid gap-5">
      <PageHeader title={t("policies.newTitle")} />
      <Card>
        <CardHeader>
          <CardTitle>{t("policies.steps.client")}</CardTitle>
        </CardHeader>
        <CardContent>
          {file.data ? (
            <div className="flex items-center justify-between gap-2">
              <div className="grid">
                <span className="font-medium" dir="auto">{clientDisplayName(file.data.client)}</span>
                <Code>{file.data.client.idNumber}</Code>
              </div>
              {!initialClient && <Button type="button" variant="outline" size="sm" onClick={() => { setClientId(""); setSelected([]); }}>{t("common.change")}</Button>}
            </div>
          ) : (
            <ClientPicker onPick={(id) => { setClientId(id); setSelected([]); }} />
          )}
        </CardContent>
      </Card>

      {clientId && (
        <Card>
          <CardHeader>
            <CardTitle>{t("policies.steps.vehicles")}</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-4">
            <Field id="type" label={t("policies.type")}>
              <NativeSelect id="type" value={typeId} onChange={(e) => { setTypeId(e.target.value); setIsFleet(false); setSelected([]); }}>
                <option value="">{t("policies.chooseType")}</option>
                {types.map((x) => <option key={x.id} value={x.id}>{`${x.insurerName} — ${x.name}`}</option>)}
              </NativeSelect>
            </Field>
            {type && !type.requiresVehicle && <p className="text-sm text-muted-foreground">{t("policies.noVehicleNeeded")}</p>}
            {type?.requiresVehicle && (
              <>
                {type.supportsFleet && (
                  <div className="flex items-start gap-2">
                    <Checkbox id="isFleet" checked={isFleet} onCheckedChange={(v) => { setIsFleet(v === true); setSelected([]); }} />
                    <div className="grid gap-1">
                      <Label htmlFor="isFleet">{t("policies.isFleet")}</Label>
                      <span className="text-xs text-muted-foreground">{t("policies.fleetHint")}</span>
                    </div>
                  </div>
                )}
                {fleet && (
                  <Field id="fleetName" label={`${t("policies.fleetName")} ${t("common.optional")}`}>
                    <Input id="fleetName" dir="auto" value={fleetName} onChange={(e) => setFleetName(e.target.value)} />
                  </Field>
                )}
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium">{fleet ? t("policies.pickVehiclesFleet") : t("policies.pickVehicles")}</span>
                  {can("vehicles.create") && <Button type="button" size="sm" variant="outline" onClick={() => setAddingVehicle(true)}>{t("vehicles.add")}</Button>}
                </div>
                {freeVehicles.length === 0 && <Alert>{t("policies.noFreeVehicles")}</Alert>}
                <div className="grid gap-2">
                  {freeVehicles.map((v) => {
                    const on = selected.includes(v.id);
                    return (
                      <div key={v.id} className="grid items-center gap-2 rounded-md border p-2 sm:grid-cols-[auto_1fr_1fr]">
                        <Checkbox id={`pick-${v.id}`} checked={on} onCheckedChange={(c) => toggle(v.id, c === true)} aria-label={v.plate} />
                        <Label htmlFor={`pick-${v.id}`} className="flex gap-2">
                          <Code>{v.plate}</Code>
                          <span dir="auto">{v.brand}</span>
                        </Label>
                        {on && (
                          <Input
                            dir="ltr"
                            aria-label={`${t("policies.certificate")} ${v.plate}`}
                            placeholder={t("policies.certificate")}
                            value={certificates[v.id] ?? ""}
                            onChange={(e) => setCertificates((c) => ({ ...c, [v.id]: e.target.value }))}
                          />
                        )}
                      </div>
                    );
                  })}
                </div>
                {fleet && <p className="text-xs text-muted-foreground">{t("policies.fleetCount", { count: selected.length })}</p>}
                <p className="text-xs text-muted-foreground">{t("policies.certificateHint")}</p>
              </>
            )}
          </CardContent>
        </Card>
      )}

      {clientId && type && (
        <Card>
          <CardHeader>
            <CardTitle>{t("policies.steps.policy")}</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-4 sm:grid-cols-2">
            <Field id="policyNumber" label={t("policies.number")} hint={t("policies.numberHint")} error={fieldError(fields.policyNumber)}>
              <Input id="policyNumber" dir="ltr" value={policyNumber} onChange={(e) => setPolicyNumber(e.target.value)} />
            </Field>
            <Field id="amount" label={t("policies.amount")} hint={t("policies.amountHint")} error={fieldError(fields.totalAmountCents)}>
              <MoneyInput id="amount" cents={amount} onChange={setAmount} />
            </Field>
            <Field id="duration" label={t("policies.duration")}>
              <NativeSelect id="duration" value={durationId} onChange={(e) => setDurationId(e.target.value)}>
                {durations.map((d) => <option key={d.id} value={d.id}>{t("policies.months", { count: d.months })}</option>)}
              </NativeSelect>
            </Field>
            <div className="grid gap-1.5">
              <span className="text-sm font-medium">{t("policies.start")}</span>
              <span>{formatDay(preview.data?.startDate)}</span>
            </div>
            <div className="grid gap-2 sm:col-span-2">
              <div className="flex items-center gap-2">
                <Checkbox id="typedEnd" checked={typedEnd !== null} onCheckedChange={(v) => setTypedEnd(v === true ? (preview.data?.endDate ?? "") : null)} />
                <Label htmlFor="typedEnd">{t("policies.endEdit")}</Label>
              </div>
              {typedEnd === null ? (
                <p className="text-sm">{t("policies.endComputed", { date: formatDay(preview.data?.endDate) })}</p>
              ) : (
                <Field id="endDate" label={t("policies.end")} error={fieldError(fields.endDate)}>
                  <Input id="endDate" type="date" dir="ltr" className="max-w-xs" value={typedEnd} onChange={(e) => setTypedEnd(e.target.value)} />
                </Field>
              )}
            </div>
          </CardContent>
        </Card>
      )}

      {error && error.code !== "VALIDATION" && <ErrorMessage error={error} />}
      {error?.code === "VALIDATION" && !fields.policyNumber && !fields.totalAmountCents && !fields.endDate && <ErrorMessage error={error} />}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" onClick={() => onOpen(initialClient ? { kind: "client", id: initialClient } : { kind: "policies" })}>{t("common.cancel")}</Button>
        <Button type="submit" disabled={!clientId || !type || create.isPending}>{t("common.create")}</Button>
      </div>

      <Dialog open={addingVehicle} onOpenChange={setAddingVehicle}>
        <DialogContent closeLabel={t("common.close")}>
          {addingVehicle && <VehicleDialog clientId={clientId} onCancel={() => setAddingVehicle(false)} onDone={(v) => { setAddingVehicle(false); toggle(v.id, true); }} />}
        </DialogContent>
      </Dialog>
    </form>
  );
}
