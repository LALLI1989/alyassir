import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState, type ChangeEvent, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { LOGO_MAX_BYTES, agencySettingsSchema, type AgencySettingsDto } from "@alyassir/shared";
import { Alert, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Input } from "@alyassir/ui";
import { asClientError, type ClientError } from "../adapters";
import { Field, PageHeader } from "../components/common";
import { ErrorMessage, fieldsOf, useFieldError } from "../lib/errors";
import { api } from "../lib/session";

type Form = Omit<AgencySettingsDto, "hasLogo" | "backupDir" | "version">;

function readAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

function Logo({ settings }: { settings: AgencySettingsDto }) {
  const { t } = useTranslation();
  const client = useQueryClient();
  const input = useRef<HTMLInputElement>(null);
  const [localError, setLocalError] = useState<ClientError | null>(null);
  const logo = useQuery({
    queryKey: ["settings", "logo", settings.version],
    queryFn: () => api<{ type: string; dataBase64: string }>("GET", "/api/settings/agency/logo"),
    enabled: settings.hasLogo,
  });
  const save = useMutation({
    mutationFn: (dataBase64: string | null) => api<AgencySettingsDto>("PUT", "/api/settings/agency/logo", { version: settings.version, dataBase64 }),
    onSettled: () => client.invalidateQueries({ queryKey: ["settings"] }),
  });
  async function pick(file: File | undefined) {
    setLocalError(null);
    if (!file) return;
    // Same limits as the server, checked at once.
    if (file.size > LOGO_MAX_BYTES) return setLocalError({ code: "LOGO_TOO_LARGE" });
    if (!["image/png", "image/jpeg"].includes(file.type)) return setLocalError({ code: "LOGO_BAD_TYPE" });
    save.mutate(await readAsBase64(file));
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("settings.logo")}</CardTitle>
        <CardDescription>{t("settings.logoHint")}</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3">
        {settings.hasLogo && logo.data ? (
          <img src={`data:${logo.data.type};base64,${logo.data.dataBase64}`} alt={t("settings.logo")} className="max-h-32 w-fit rounded border bg-white p-2" />
        ) : (
          <p className="text-sm text-muted-foreground">{t("settings.noLogo")}</p>
        )}
        <input ref={input} type="file" accept="image/png,image/jpeg" className="hidden" onChange={(e) => void pick(e.target.files?.[0])} />
        <div className="flex gap-2">
          <Button type="button" variant="outline" onClick={() => input.current?.click()} disabled={save.isPending}>{t("settings.logoChoose")}</Button>
          {settings.hasLogo && <Button type="button" variant="ghost" onClick={() => save.mutate(null)} disabled={save.isPending}>{t("settings.logoRemove")}</Button>}
        </div>
        <ErrorMessage error={localError ?? (save.error ? asClientError(save.error) : null)} />
      </CardContent>
    </Card>
  );
}

export function Settings() {
  const { t } = useTranslation();
  const fieldError = useFieldError();
  const client = useQueryClient();
  const settings = useQuery({ queryKey: ["settings"], queryFn: () => api<AgencySettingsDto>("GET", "/api/settings/agency") });
  const [form, setForm] = useState<Form | null>(null);
  const [local, setLocal] = useState<Record<string, string>>({});

  useEffect(() => {
    if (settings.data) {
      const { hasLogo: _h, backupDir: _b, version: _v, ...rest } = settings.data;
      setForm(rest);
    }
  }, [settings.data]);

  const save = useMutation({
    mutationFn: (body: Form & { version: number }) => api<AgencySettingsDto>("PUT", "/api/settings/agency", body),
    onSettled: () => client.invalidateQueries({ queryKey: ["settings"] }),
  });

  if (!settings.data || !form) return <ErrorMessage error={settings.error ? asClientError(settings.error) : null} />;
  const data = settings.data;

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!form) return;
    const body = { ...form, version: data.version };
    const parsed = agencySettingsSchema.safeParse(body);
    const errors: Record<string, string> = {};
    if (!parsed.success) for (const i of parsed.error.issues) errors[i.path.join(".")] ??= i.message;
    setLocal(errors);
    if (!Object.keys(errors).length) save.mutate(body);
  }
  const server = fieldsOf(save.error ? asClientError(save.error) : null);
  const err = (k: string) => fieldError(local[k] ?? server[k]);
  const set = (k: keyof Form) => (e: ChangeEvent<HTMLInputElement>) =>
    setForm({ ...form, [k]: k === "idleTimeoutMinutes" ? Number(e.target.value) : e.target.value });

  return (
    <div className="grid max-w-2xl gap-5">
      <PageHeader title={t("settings.title")} />
      <Card>
        <CardContent className="pt-5">
          <form onSubmit={submit} className="grid gap-4">
            <Field id="nameAr" label={t("settings.nameAr")} error={err("nameAr")}><Input id="nameAr" dir="rtl" value={form.nameAr} onChange={set("nameAr")} /></Field>
            <Field id="nameFr" label={t("settings.nameFr")} error={err("nameFr")}><Input id="nameFr" dir="ltr" value={form.nameFr} onChange={set("nameFr")} /></Field>
            <Field id="address" label={t("settings.address")} error={err("address")}><Input id="address" value={form.address} onChange={set("address")} /></Field>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field id="phone" label={t("settings.phone")} error={err("phone")}><Input id="phone" dir="ltr" value={form.phone} onChange={set("phone")} /></Field>
              <Field id="licenseNumber" label={t("settings.licenseNumber")} error={err("licenseNumber")}><Input id="licenseNumber" dir="ltr" value={form.licenseNumber} onChange={set("licenseNumber")} /></Field>
            </div>
            <Field id="idle" label={t("settings.idleTimeout")} hint={t("settings.idleTimeoutHint")} error={err("idleTimeoutMinutes")}>
              <Input id="idle" type="number" min={5} max={480} dir="ltr" className="w-32" value={form.idleTimeoutMinutes} onChange={set("idleTimeoutMinutes")} />
            </Field>
            <Field id="backupDir" label={t("settings.backupDir")} hint={t("settings.backupDirHint")}>
              <Input id="backupDir" dir="ltr" value={data.backupDir} readOnly disabled />
            </Field>
            {save.isSuccess && <Alert variant="success">{t("common.saved")}</Alert>}
            {save.error && asClientError(save.error).code !== "VALIDATION" && <ErrorMessage error={asClientError(save.error)} />}
            <div><Button type="submit" disabled={save.isPending}>{t("common.save")}</Button></div>
          </form>
        </CardContent>
      </Card>
      <Logo settings={data} />
    </div>
  );
}
