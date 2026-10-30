import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { changePasswordSchema, type Language, type RecoveryCodeDto, type RecoveryStateDto } from "@alyassir/shared";
import { Alert, Button, Card, CardContent, CardHeader, CardTitle, Input, NativeSelect } from "@alyassir/ui";
import { asClientError } from "../adapters";
import { Field, PageHeader } from "../components/common";
import { ErrorMessage, fieldsOf, useFieldError } from "../lib/errors";
import i18n from "../lib/i18n";
import { formatDateTime } from "../lib/format";
import { api, useSession } from "../lib/session";

/** Phase 8A: the manager's printed recovery code: is there one, and make a new one (shown once). */
function RecoveryCode() {
  const { t } = useTranslation();
  const client = useQueryClient();
  const state = useQuery({ queryKey: ["recoveryCode"], queryFn: () => api<RecoveryStateDto>("GET", "/api/me/recovery-code") });
  const [password, setPassword] = useState("");
  const create = useMutation({
    mutationFn: () => api<RecoveryCodeDto>("POST", "/api/me/recovery-code", { password }),
    onSuccess: () => {
      setPassword("");
      void client.invalidateQueries({ queryKey: ["recoveryCode"] });
    },
  });
  const s = state.data;
  return (
    <Card data-testid="recovery-card">
      <CardHeader>
        <CardTitle>{t("recovery.cardTitle")}</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-4">
        <p className="text-sm">{t("recovery.cardIntro")}</p>
        {s && (s.exists && s.createdAt ? <Alert variant="success">{t("recovery.exists", { time: formatDateTime(s.createdAt) })}</Alert> : <Alert variant="warning">{t("recovery.none")}</Alert>)}
        {create.data ? (
          <div className="grid gap-2">
            <p className="text-sm font-medium">{t("recovery.printNew")}</p>
            <p className="rounded-md border bg-muted p-3 text-center font-mono text-xl font-bold tracking-wider" dir="ltr" data-testid="new-recovery-code">
              {create.data.recoveryCode}
            </p>
          </div>
        ) : (
          <form
            className="grid gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              create.mutate();
            }}
          >
            <Field id="recoveryPassword" label={t("account.currentPassword")}>
              <Input id="recoveryPassword" type="password" dir="ltr" value={password} onChange={(e) => setPassword(e.target.value)} />
            </Field>
            {create.error && <ErrorMessage error={asClientError(create.error)} />}
            <div>
              <Button type="submit" variant="outline" disabled={create.isPending || !password}>{t("recovery.create")}</Button>
            </div>
          </form>
        )}
      </CardContent>
    </Card>
  );
}

export function Account() {
  const { t } = useTranslation();
  const { me, isManager } = useSession();
  const client = useQueryClient();
  const fieldError = useFieldError();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [repeat, setRepeat] = useState("");
  const [local, setLocal] = useState<Record<string, string>>({});

  const change = useMutation({
    mutationFn: () => api<void>("POST", "/api/me/password", { currentPassword: current, newPassword: next }),
    onSuccess: () => {
      setCurrent("");
      setNext("");
      setRepeat("");
    },
  });
  const language = useMutation({
    mutationFn: (lng: Language) => api<void>("PUT", "/api/me/language", { language: lng }),
    onSuccess: async (_d, lng) => {
      await i18n.changeLanguage(lng);
      await client.invalidateQueries({ queryKey: ["me"] });
    },
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    change.reset();
    // Instant check with the same rules as the server.
    const parsed = changePasswordSchema.safeParse({ currentPassword: current, newPassword: next });
    const errors: Record<string, string> = {};
    if (!parsed.success) for (const i of parsed.error.issues) errors[i.path.join(".")] ??= i.message;
    if (next !== repeat) errors.repeat = "passwordsDiffer";
    setLocal(errors);
    if (Object.keys(errors).length === 0) change.mutate();
  }

  const serverFields = fieldsOf(change.error ? asClientError(change.error) : null);
  const err = (key: string) => (key === "repeat" && local.repeat ? t("account.passwordsDiffer") : fieldError(local[key] ?? serverFields[key]));

  return (
    <div className="grid max-w-xl gap-5">
      <PageHeader title={t("account.title")} />
      <Card>
        <CardHeader>
          <CardTitle>{t("language.label")}</CardTitle>
        </CardHeader>
        <CardContent>
          <NativeSelect
            aria-label={t("language.label")}
            value={me?.language ?? i18n.language}
            onChange={(e) => language.mutate(e.target.value as Language)}
            className="max-w-xs"
          >
            <option value="ar">{t("language.ar")}</option>
            <option value="fr">{t("language.fr")}</option>
          </NativeSelect>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>{t("account.changePassword")}</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={submit} className="grid gap-4">
            <Field id="current" label={t("account.currentPassword")} error={err("currentPassword")}>
              <Input id="current" type="password" dir="ltr" value={current} onChange={(e) => setCurrent(e.target.value)} />
            </Field>
            <Field id="next" label={t("account.newPassword")} hint={t("users.passwordHint")} error={err("newPassword")}>
              <Input id="next" type="password" dir="ltr" value={next} onChange={(e) => setNext(e.target.value)} />
            </Field>
            <Field id="repeat" label={t("account.repeatPassword")} error={err("repeat")}>
              <Input id="repeat" type="password" dir="ltr" value={repeat} onChange={(e) => setRepeat(e.target.value)} />
            </Field>
            {change.isSuccess && <Alert variant="success">{t("account.passwordChanged")}</Alert>}
            {change.error && asClientError(change.error).code !== "VALIDATION" && <ErrorMessage error={asClientError(change.error)} />}
            <Button type="submit" disabled={change.isPending}>{t("common.save")}</Button>
          </form>
        </CardContent>
      </Card>
      {isManager && <RecoveryCode />}
    </div>
  );
}
