import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { Alert, Button, Card, CardContent, CardHeader, CardTitle, Input } from "@alyassir/ui";
import { adapter, asClientError, type ClientError } from "../adapters";
import { Field } from "../components/common";
import { ErrorMessage } from "../lib/errors";
import { useSession } from "../lib/session";

export function Login() {
  const { t, i18n } = useTranslation();
  const { signIn, endedCode } = useSession();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ClientError | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      signIn(await adapter.login(username, password));
    } catch (e) {
      setError(asClientError(e));
      setPassword("");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-4 p-4">
      <div className="flex w-full max-w-sm items-center justify-between">
        <span className="font-bold">{t("app.short")}</span>
        <Button variant="link" size="sm" onClick={() => void i18n.changeLanguage(i18n.language === "ar" ? "fr" : "ar")}>
          {t("app.switchLanguage")}
        </Button>
      </div>
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>{t("login.title")}</CardTitle>
          <p className="text-sm text-muted-foreground">{t("app.name")}</p>
        </CardHeader>
        <CardContent>
          <form onSubmit={submit} className="grid gap-4">
            {endedCode && !error && (
              <Alert variant="warning">{endedCode === "SESSION_EXPIRED" ? t("login.idleEnded") : t("login.sessionEnded")}</Alert>
            )}
            <Field id="username" label={t("login.username")}>
              <Input id="username" dir="ltr" autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} autoFocus />
            </Field>
            <Field id="password" label={t("login.password")}>
              <Input id="password" type="password" dir="ltr" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
            </Field>
            <ErrorMessage error={error} />
            <Button type="submit" disabled={busy || !username || !password}>
              {busy ? t("login.submitting") : t("login.submit")}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
