import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Alert, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Input } from "@alyassir/ui";
import { adapter, type Health, type LinkError, type Probe, type SavedServer } from "../adapters";
import { Field, Fingerprint } from "../components/common";
import { formatTime } from "../lib/format";

function LinkErrorBox({ error }: { error: LinkError }) {
  const { t } = useTranslation();
  return (
    <Alert variant="error">
      <p>{t(`errors.${error.code}`)}</p>
      <p className="mt-1 text-xs opacity-80">{t("errors.code", { code: `LINK-${error.code.toUpperCase()}` })}</p>
      {error.seen && <div className="mt-2"><Fingerprint value={error.seen} /></div>}
    </Alert>
  );
}

function AddressForm({ onProbe, onCancel }: { onProbe: (p: Probe) => void; onCancel?: () => void }) {
  const { t } = useTranslation();
  const [address, setAddress] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<LinkError | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      onProbe(await adapter.probe(address));
    } catch (e) {
      setError(e as LinkError);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="grid gap-4">
      <Field id="address" label={t("setup.addressLabel")} hint={t("setup.addressHint")}>
        <Input id="address" dir="ltr" value={address} placeholder="192.168.1.50:4100" onChange={(e) => setAddress(e.target.value)} autoFocus />
      </Field>
      {error && <LinkErrorBox error={error} />}
      <div className="flex gap-2">
        <Button type="submit" disabled={busy || address.trim() === ""}>{busy ? t("setup.testing") : t("setup.test")}</Button>
        {onCancel && <Button type="button" variant="outline" onClick={onCancel}>{t("setup.cancel")}</Button>}
      </div>
    </form>
  );
}

function ConfirmFingerprint({ probe, onSaved, onReject }: { probe: Probe; onSaved: (s: SavedServer) => void; onReject: () => void }) {
  const { t } = useTranslation();
  async function accept() {
    const server = { url: probe.url, fingerprint: probe.fingerprint };
    await adapter.saveServer(server);
    onSaved(server);
  }
  return (
    <div className="grid gap-4">
      <p className="text-sm">{t("confirm.intro")}</p>
      <p className="text-sm">{t("confirm.server")}: <bdi dir="ltr">{probe.url}</bdi></p>
      <div>
        <p className="mb-1 text-sm font-medium">{t("confirm.fingerprint")}</p>
        <Fingerprint value={probe.fingerprint} />
      </div>
      <div className="flex flex-wrap gap-2">
        <Button onClick={() => void accept()}>{t("confirm.match")}</Button>
        <Button variant="outline" onClick={onReject}>{t("confirm.noMatch")}</Button>
      </div>
    </div>
  );
}

/** Choose and confirm the server: address, then fingerprint check (SPEC 4.14, 6.2). */
export function ServerSetup({ onSaved, onCancel }: { onSaved: (s: SavedServer) => void; onCancel?: () => void }) {
  const { t } = useTranslation();
  const [probe, setProbe] = useState<Probe | null>(null);
  return (
    <Card className="mx-auto w-full max-w-lg">
      <CardHeader>
        <CardTitle>{probe ? t("confirm.title") : t("setup.title")}</CardTitle>
        {!probe && <CardDescription>{t("setup.intro")}</CardDescription>}
      </CardHeader>
      <CardContent>
        {probe ? <ConfirmFingerprint probe={probe} onSaved={onSaved} onReject={() => setProbe(null)} /> : <AddressForm onProbe={setProbe} onCancel={onCancel} />}
      </CardContent>
    </Card>
  );
}

/** Shows the app only once a confirmed server is saved on this computer. */
export function ServerGate({ children }: { children: ReactNode }) {
  const [saved, setSaved] = useState<SavedServer | null | undefined>(undefined);
  useEffect(() => {
    void adapter.loadServer().then(setSaved, () => setSaved(null));
  }, []);
  if (saved === undefined) return null;
  if (adapter.needsServerSetup && !saved) {
    return (
      <div className="flex min-h-screen items-center p-4">
        <ServerSetup onSaved={setSaved} />
      </div>
    );
  }
  return <>{children}</>;
}

/** "Server connection" page: current status, and changing the server. */
export function ServerStatusPage() {
  const { t } = useTranslation();
  const [saved, setSaved] = useState<SavedServer | null>(null);
  const [health, setHealth] = useState<Health | null>(null);
  const [error, setError] = useState<LinkError | null>(null);
  const [checkedAt, setCheckedAt] = useState<Date | null>(null);
  const [changing, setChanging] = useState(false);

  const check = useCallback(async () => {
    try {
      setHealth(await adapter.check());
      setError(null);
    } catch (e) {
      setHealth(null);
      setError(e as LinkError);
    } finally {
      setCheckedAt(new Date());
    }
  }, []);

  useEffect(() => {
    void adapter.loadServer().then(setSaved);
    void check();
  }, [check]);

  if (changing) {
    return <ServerSetup onSaved={(s) => { setSaved(s); setChanging(false); void check(); }} onCancel={() => setChanging(false)} />;
  }

  const dbOk = health?.database === "ok";
  return (
    <Card className="max-w-xl">
      <CardHeader>
        <CardTitle>{t("status.title")}</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-3">
        {!health && !error && <p>{t("status.checking")}</p>}
        {health && (
          <Alert variant={dbOk ? "success" : "warning"}>
            <p className="font-semibold">{dbOk ? `✓ ${t("status.connected")}` : `⚠ ${t("status.databaseDown")}`}</p>
            {dbOk && <p>{t("status.databaseOk")}</p>}
            <p>{t("status.version", { version: health.version })}</p>
          </Alert>
        )}
        {error && <LinkErrorBox error={error} />}
        {saved && <p className="text-sm">{t("status.serverLabel")}: <bdi dir="ltr">{saved.url}</bdi></p>}
        {saved?.fingerprint && <Fingerprint value={saved.fingerprint} />}
        {checkedAt && <p className="text-xs text-muted-foreground">{t("status.lastCheck", { time: formatTime(checkedAt) })}</p>}
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => void check()}>{t("status.retry")}</Button>
          {adapter.needsServerSetup && <Button variant="outline" onClick={() => setChanging(true)}>{t("status.change")}</Button>}
        </div>
      </CardContent>
    </Card>
  );
}
