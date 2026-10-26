import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { serverLink, type Health, type LinkError, type Probe, type SavedServer } from "./adapters/serverLink";

type Screen =
  | { kind: "loading" }
  | { kind: "setup" }
  | { kind: "confirm"; probe: Probe }
  | { kind: "status"; server: SavedServer };

const CHECK_EVERY_MS = 5000;

/** Shows "AB:CD:..." in 4 short lines so it is easy to compare by eye. */
function Fingerprint({ value }: { value: string }) {
  const parts = value.split(":");
  const lines = [0, 8, 16, 24].map((i) => parts.slice(i, i + 8).join(":"));
  return (
    <code className="fingerprint" dir="ltr">
      {lines.map((line) => (
        <span key={line}>{line}</span>
      ))}
    </code>
  );
}

function ErrorBox({ error }: { error: LinkError }) {
  const { t } = useTranslation();
  return (
    <div className="error" role="alert">
      <p>{t(`errors.${error.code}`)}</p>
      <small>{t("errors.code", { code: `LINK-${error.code.toUpperCase()}` })}</small>
      {error.seen && <Fingerprint value={error.seen} />}
    </div>
  );
}

function SetupScreen({ onProbe, onCancel }: { onProbe: (p: Probe) => void; onCancel?: () => void }) {
  const { t } = useTranslation();
  const [address, setAddress] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<LinkError | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      onProbe(await serverLink.probe(address));
    } catch (e) {
      setError(e as LinkError);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="card" onSubmit={submit}>
      <h2>{t("setup.title")}</h2>
      <p>{t("setup.intro")}</p>
      <label htmlFor="address">{t("setup.addressLabel")}</label>
      <input
        id="address"
        dir="ltr"
        value={address}
        placeholder="192.168.1.50:4100"
        onChange={(e) => setAddress(e.target.value)}
        autoFocus
      />
      <small>{t("setup.addressHint")}</small>
      {error && <ErrorBox error={error} />}
      <div className="actions">
        <button type="submit" disabled={busy || address.trim() === ""}>
          {busy ? t("setup.testing") : t("setup.test")}
        </button>
        {onCancel && (
          <button type="button" className="secondary" onClick={onCancel}>
            {t("setup.cancel")}
          </button>
        )}
      </div>
    </form>
  );
}

function ConfirmScreen({ probe, onSaved, onReject }: { probe: Probe; onSaved: (s: SavedServer) => void; onReject: () => void }) {
  const { t } = useTranslation();
  async function accept() {
    const server = { url: probe.url, fingerprint: probe.fingerprint };
    await serverLink.save(server);
    onSaved(server);
  }
  return (
    <div className="card">
      <h2>{t("confirm.title")}</h2>
      <p>{t("confirm.intro")}</p>
      <p>
        {t("confirm.server")}: <bdi dir="ltr">{probe.url}</bdi>
      </p>
      <p>{t("confirm.fingerprint")}:</p>
      <Fingerprint value={probe.fingerprint} />
      <div className="actions">
        <button type="button" onClick={() => void accept()}>{t("confirm.match")}</button>
        <button type="button" className="secondary" onClick={onReject}>{t("confirm.noMatch")}</button>
      </div>
    </div>
  );
}

function StatusScreen({ server, onChange }: { server: SavedServer; onChange: () => void }) {
  const { t, i18n } = useTranslation();
  const [health, setHealth] = useState<Health | null>(null);
  const [error, setError] = useState<LinkError | null>(null);
  const [checkedAt, setCheckedAt] = useState<Date | null>(null);

  const check = useCallback(async () => {
    try {
      setHealth(await serverLink.check());
      setError(null);
    } catch (e) {
      setHealth(null);
      setError(e as LinkError);
    } finally {
      setCheckedAt(new Date());
    }
  }, []);

  // Reconnects by itself: keeps checking, so the status comes back after a server restart.
  useEffect(() => {
    void check();
    const timer = setInterval(() => void check(), CHECK_EVERY_MS);
    return () => clearInterval(timer);
  }, [check]);

  const time = checkedAt?.toLocaleTimeString(i18n.language === "ar" ? "ar-MA" : "fr-MA", { timeZone: "Africa/Casablanca" });
  const dbOk = health?.database === "ok";

  return (
    <div className="card">
      <h2>{t("status.title")}</h2>
      {!health && !error && <p>{t("status.checking")}</p>}
      {health && (
        <div className={dbOk ? "ok" : "warn"} role="status">
          <p className="big">{dbOk ? `✓ ${t("status.connected")}` : `⚠ ${t("status.databaseDown")}`}</p>
          {dbOk && <p>{t("status.databaseOk")}</p>}
          <p>{t("status.version", { version: health.version })}</p>
        </div>
      )}
      {error && <ErrorBox error={error} />}
      <p>
        {t("status.serverLabel")}: <bdi dir="ltr">{server.url}</bdi>
      </p>
      {time && <small>{t("status.lastCheck", { time })}</small>}
      <div className="actions">
        <button type="button" onClick={() => void check()}>{t("status.retry")}</button>
        <button type="button" className="secondary" onClick={onChange}>{t("status.change")}</button>
      </div>
    </div>
  );
}

export function App() {
  const { t, i18n } = useTranslation();
  const [screen, setScreen] = useState<Screen>({ kind: "loading" });
  const [saved, setSaved] = useState<SavedServer | null>(null);

  useEffect(() => {
    void serverLink.load().then((server) => {
      setSaved(server);
      setScreen(server ? { kind: "status", server } : { kind: "setup" });
    });
  }, []);

  const toggleLanguage = () => void i18n.changeLanguage(i18n.language === "ar" ? "fr" : "ar");

  return (
    <main>
      <header>
        <h1>{t("app.name")}</h1>
        <button type="button" className="link" onClick={toggleLanguage}>{t("app.switchLanguage")}</button>
      </header>
      {screen.kind === "setup" && (
        <SetupScreen
          onProbe={(probe) => setScreen({ kind: "confirm", probe })}
          onCancel={saved ? () => setScreen({ kind: "status", server: saved }) : undefined}
        />
      )}
      {screen.kind === "confirm" && (
        <ConfirmScreen
          probe={screen.probe}
          onSaved={(server) => {
            setSaved(server);
            setScreen({ kind: "status", server });
          }}
          onReject={() => setScreen({ kind: "setup" })}
        />
      )}
      {screen.kind === "status" && <StatusScreen server={screen.server} onChange={() => setScreen({ kind: "setup" })} />}
    </main>
  );
}
