import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { DEFAULT_PLATE_TYPE, FUELS, PLATE_TYPES, vehicleSchema, type Fuel, type PlateType, type VehicleDto } from "@alyassir/shared";
import { Button, Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, Input, NativeSelect, Table, TBody, Td, Th, THead, Tr } from "@alyassir/ui";
import { asClientError } from "../adapters";
import { Field, PageHeader } from "../components/common";
import { Code } from "../components/insurance";
import { ErrorMessage, fieldsOf, useFieldError } from "../lib/errors";
import { formatDateTime } from "../lib/format";
import { api } from "../lib/session";
import type { Page } from "./Shell";

interface VehicleForm {
  plateType: PlateType;
  plate: string;
  fiscalPower: string;
  fuel: Fuel;
  brand: string;
  reason: string;
}

/** Add a vehicle to a client, or correct its card (SPEC 9.2). */
export function VehicleDialog({ clientId, vehicle, onDone, onCancel }: { clientId: string; vehicle?: VehicleDto; onDone: (v: VehicleDto) => void; onCancel: () => void }) {
  const { t } = useTranslation();
  const fieldError = useFieldError();
  const queries = useQueryClient();
  const [form, setForm] = useState<VehicleForm>(
    vehicle
      ? { plateType: vehicle.plateType, plate: vehicle.plate, fiscalPower: String(vehicle.fiscalPower), fuel: vehicle.fuel, brand: vehicle.brand, reason: "" }
      : { plateType: DEFAULT_PLATE_TYPE, plate: "", fiscalPower: "", fuel: "diesel", brand: "", reason: "" },
  );
  const [local, setLocal] = useState<Record<string, string>>({});
  const body = () => ({ clientId, plateType: form.plateType, plate: form.plate, fiscalPower: Number.parseInt(form.fiscalPower, 10), fuel: form.fuel, brand: form.brand });
  const save = useMutation({
    mutationFn: () =>
      vehicle
        ? api<VehicleDto>("PATCH", `/api/vehicles/${vehicle.id}`, { ...body(), clientId: undefined, version: vehicle.version, reason: form.reason })
        : api<VehicleDto>("POST", "/api/vehicles", body()),
    onSuccess: async (v) => {
      await queries.invalidateQueries({ queryKey: ["client"] });
      await queries.invalidateQueries({ queryKey: ["vehicles"] });
      onDone(v);
    },
  });
  const set = (patch: Partial<VehicleForm>) => setForm((f) => ({ ...f, ...patch }));
  function submit(e: FormEvent) {
    e.preventDefault();
    const parsed = vehicleSchema.safeParse(body());
    const errors: Record<string, string> = {};
    if (!parsed.success) for (const i of parsed.error.issues) errors[i.path.join(".")] ??= i.message;
    setLocal(errors);
    if (!Object.keys(errors).length) save.mutate();
  }
  const error = save.error ? asClientError(save.error) : null;
  const server = fieldsOf(error);
  const err = (k: string) => fieldError(local[k] ?? server[k]);
  const insured = Boolean(vehicle?.activePolicyId);
  return (
    <form onSubmit={submit} className="grid gap-4">
      <DialogHeader>
        <DialogTitle>{vehicle ? t("vehicles.editTitle") : t("vehicles.addTitle")}</DialogTitle>
      </DialogHeader>
      {insured && <p className="text-sm text-muted-foreground">{t("vehicles.plateNeedsOperation")}</p>}
      <div className="grid gap-4 sm:grid-cols-2">
        <Field id="plateType" label={t("vehicles.plateType")}>
          <NativeSelect id="plateType" value={form.plateType} disabled={insured} onChange={(e) => set({ plateType: e.target.value as PlateType })}>
            {PLATE_TYPES.map((p) => <option key={p} value={p}>{t(`vehicles.plateTypes.${p}`)}</option>)}
          </NativeSelect>
        </Field>
        <Field id="plate" label={t("vehicles.plate")} hint={t(`vehicles.plateHints.${form.plateType}`)} error={err("plate")}>
          <Input id="plate" dir="ltr" value={form.plate} disabled={insured} onChange={(e) => set({ plate: e.target.value })} />
        </Field>
        <Field id="fiscalPower" label={t("vehicles.fiscalPower")} hint={t("vehicles.fiscalPowerUnit")} error={err("fiscalPower")}>
          <Input id="fiscalPower" dir="ltr" inputMode="numeric" value={form.fiscalPower} onChange={(e) => set({ fiscalPower: e.target.value })} />
        </Field>
        <Field id="fuel" label={t("vehicles.fuel")}>
          <NativeSelect id="fuel" value={form.fuel} onChange={(e) => set({ fuel: e.target.value as Fuel })}>
            {FUELS.map((f) => <option key={f} value={f}>{t(`vehicles.fuels.${f}`)}</option>)}
          </NativeSelect>
        </Field>
      </div>
      <Field id="brand" label={t("vehicles.brand")} error={err("brand")}>
        <Input id="brand" dir="auto" value={form.brand} onChange={(e) => set({ brand: e.target.value })} />
      </Field>
      {vehicle && !insured && (
        <Field id="vehicleReason" label={`${t("vehicles.correctionReason")} ${t("common.optional")}`}>
          <Input id="vehicleReason" value={form.reason} onChange={(e) => set({ reason: e.target.value })} />
        </Field>
      )}
      {error && error.code !== "VALIDATION" && <ErrorMessage error={error} />}
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onCancel}>{t("common.cancel")}</Button>
        <Button type="submit" disabled={save.isPending}>{vehicle ? t("common.save") : t("common.create")}</Button>
      </DialogFooter>
    </form>
  );
}

export function PlateHistory({ vehicle }: { vehicle: VehicleDto }) {
  const { t } = useTranslation();
  if (!vehicle.plateHistory.length) return null;
  return (
    <div className="grid gap-1 text-xs text-muted-foreground">
      <span className="font-medium">{t("vehicles.plateHistory")}</span>
      {vehicle.plateHistory.map((h) => (
        <span key={h.changedAt}>
          <Code>{h.plate}</Code> → <Code>{h.newPlate}</Code> · {formatDateTime(h.changedAt)}
          {h.changedByName ? ` · ${h.changedByName}` : ""}
        </span>
      ))}
    </div>
  );
}

/** Search a vehicle by plate, written with or without dashes. */
export function Vehicles({ onOpen }: { onOpen: (page: Page) => void }) {
  const { t } = useTranslation();
  const [q, setQ] = useState("");
  const list = useQuery({
    queryKey: ["vehicles", q],
    queryFn: () => api<VehicleDto[]>("GET", `/api/vehicles?q=${encodeURIComponent(q)}`),
    enabled: q.trim().length > 0,
    placeholderData: keepPreviousData,
  });
  return (
    <div>
      <PageHeader title={t("vehicles.title")} intro={t("vehicles.intro")} />
      <Input className="mb-3 max-w-sm" dir="ltr" placeholder={t("vehicles.searchPlaceholder")} aria-label={t("common.search")} value={q} onChange={(e) => setQ(e.target.value)} />
      {!q.trim() ? (
        <p className="text-sm text-muted-foreground">{t("vehicles.searchHint")}</p>
      ) : (
        <div className="rounded-lg border bg-card">
          <Table>
            <THead>
              <Tr>
                <Th>{t("vehicles.plate")}</Th>
                <Th>{t("vehicles.brand")}</Th>
                <Th>{t("vehicles.fiscalPower")}</Th>
                <Th>{t("policies.validity")}</Th>
                <Th />
              </Tr>
            </THead>
            <TBody>
              {list.data?.length === 0 && (
                <Tr>
                  <Td colSpan={5} className="py-8 text-center text-muted-foreground">{t("common.empty")}</Td>
                </Tr>
              )}
              {list.data?.map((v) => (
                <Tr key={v.id}>
                  <Td>
                    <div className="grid gap-1">
                      <Code>{v.plate}</Code>
                      <span className="text-xs text-muted-foreground">{t(`vehicles.plateTypes.${v.plateType}`)}</span>
                    </div>
                  </Td>
                  <Td dir="auto">{v.brand}</Td>
                  <Td>{v.fiscalPower}</Td>
                  <Td>
                    {v.activePolicyId ? (
                      <Button size="sm" variant="link" className="h-auto p-0" onClick={() => onOpen({ kind: "policy", id: v.activePolicyId as string })}>
                        {t("vehicles.insuredBy", { number: v.activePolicyNumber })}
                      </Button>
                    ) : (
                      <span className="text-muted-foreground">{t("vehicles.notInsured")}</span>
                    )}
                  </Td>
                  <Td className="text-end">
                    <Button size="sm" variant="outline" onClick={() => onOpen({ kind: "client", id: v.clientId })}>{t("vehicles.client")}</Button>
                  </Td>
                </Tr>
              ))}
            </TBody>
          </Table>
        </div>
      )}
    </div>
  );
}
