import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { Alert, Button, Card, CardContent, CardHeader, CardTitle, Input } from "@alyassir/ui";
import { adapter, asClientError, type ClientError } from "../adapters";
import { Field } from "../components/common";
import { ErrorMessage } from "../lib/errors";
import { useSession } from "../lib/session";

/** Phase 8A: the manager forgot his password; the printed recovery code lets him choose a new one. */
function RecoverManager({ onBack }: { onBack: () => void }) {
  const { t } = useTranslation();
  const [username, setUsername] = useState("");
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [again, setAgain] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ClientError | null>(null);
  const [newCode, setNewCode] = useState<string | null>(null);
  const mismatch = again.length > 0 && again !== password;

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (mismatch) return;
    setBusy(true);
    setError(null);
    try {
      setNewCode((await adapter.recover(username, code, password)).recoveryCode);
    } catch (e) {
      setError(asClientError(e));
    } finally {
      setBusy(false);
    }
  }

  if (newCode) {
    return (
      <div className="grid gap-4" data-testid="recovered">
        <Alert variant="success">{t("recovery.done")}</Alert>
        <p className="text-sm">{t("recovery.printNew")}</p>
        <p className="rounded-md border bg-muted p-3 text-center font-mono text-xl font-bold tracking-wider" dir="ltr" data-testid="new-recovery-code">
          {newCode}
        </p>
        <Button onClick={onBack}>{t("recovery.backToLogin")}</Button>
      </div>
    );
  }
  return (
    <form onSubmit={submit} className="grid gap-4" data-testid="recover-form">
      <p className="text-sm text-muted-foreground">{t("recovery.intro")}</p>
      <Field id="recoverUser" label={t("login.username")}>
        <Input id="recoverUser" dir="ltr" autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} autoFocus />
      </Field>
      <Field id="recoverCode" label={t("recovery.code")}>
        <Input id="recoverCode" dir="ltr" autoComplete="off" placeholder="XXXX-XXXX-XXXX-XXXX" value={code} onChange={(e) => setCode(e.target.value)} />
      </Field>
      <Field id="recoverPassword" label={t("recovery.newPassword")}>
        <Input id="recoverPassword" type="password" dir="ltr" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />
      </Field>
      <Field id="recoverAgain" label={t("recovery.again")} error={mismatch ? t("recovery.mismatch") : undefined}>
        <Input id="recoverAgain" type="password" dir="ltr" autoComplete="new-password" value={again} onChange={(e) => setAgain(e.target.value)} />
      </Field>
      <ErrorMessage error={error} />
      <Button type="submit" disabled={busy || !username || !code || !password || mismatch || again !== password}>
        {t("recovery.submit")}
      </Button>
      <Button type="button" variant="link" onClick={onBack}>
        {t("recovery.backToLogin")}
      </Button>
    </form>
  );
}

export function Login() {
  const { t, i18n } = useTranslation();
  const { signIn, endedCode } = useSession();
  const [forgot, setForgot] = useState(false);
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
          <CardTitle>{forgot ? t("recovery.title") : t("login.title")}</CardTitle>
          <p className="text-sm text-muted-foreground">{t("app.name")}</p>
        </CardHeader>
        <CardContent>
          {forgot ? (
            <RecoverManager onBack={() => setForgot(false)} />
          ) : (
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
            <Button type="button" variant="link" size="sm" onClick={() => setForgot(true)}>
              {t("recovery.link")}
            </Button>
          </form>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
