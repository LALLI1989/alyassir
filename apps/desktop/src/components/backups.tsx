import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import type { UsbStateDto } from "@alyassir/shared";
import { Alert, Button, Card, CardContent, CardHeader, CardTitle, Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, Label, NativeSelect, Textarea } from "@alyassir/ui";
import { asClientError } from "../adapters";
import { ErrorMessage } from "../lib/errors";
import { formatDateTime } from "../lib/format";
import { api } from "../lib/session";

/** State of the monthly USB copy (owner decision 29/10/2026), checked every minute. */
export function useUsb() {
  return useQuery({ queryKey: ["usb"], queryFn: () => api<UsbStateDto>("GET", "/api/backups/usb"), refetchInterval: 60_000 });
}

function gigabytes(bytes: number): string {
  return (bytes / 1_000_000_000).toFixed(1);
}

function SkipDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const client = useQueryClient();
  const [reason, setReason] = useState("");
  const skip = useMutation({
    mutationFn: () => api<UsbStateDto>("POST", "/api/backups/usb/skip", { reason }),
    onSuccess: (state) => {
      client.setQueryData(["usb"], state);
      void client.invalidateQueries();
      onClose();
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    skip.mutate();
  };
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent closeLabel={t("common.close")}>
        <form className="grid gap-3" onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>{t("backups.usb.skipTitle")}</DialogTitle>
          </DialogHeader>
          <div className="grid gap-1">
            <Label htmlFor="usbSkipReason">{t("backups.usb.skipReason")}</Label>
            <Textarea id="usbSkipReason" value={reason} onChange={(e) => setReason(e.target.value)} />
            <p className="text-xs text-muted-foreground">{t("backups.usb.skipHint")}</p>
          </div>
          {skip.error && <ErrorMessage error={asClientError(skip.error)} />}
          <DialogFooter>
            <Button type="submit" disabled={skip.isPending || reason.trim().length < 3}>{t("backups.usb.skip")}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** The copy itself, on the server computer: choose the key, copy, read back, done. */
export function UsbCopyPanel({ state }: { state: UsbStateDto }) {
  const { t } = useTranslation();
  const client = useQueryClient();
  const [drive, setDrive] = useState("");
  const [skipping, setSkipping] = useState(false);
  const [done, setDone] = useState(false);
  const chosen = drive || state.drives[0]?.drive || "";
  const copy = useMutation({
    mutationFn: () => api<UsbStateDto>("POST", "/api/backups/usb/copy", { drive: chosen }),
    onSuccess: (next) => {
      setDone(true);
      client.setQueryData(["usb"], next);
      void client.invalidateQueries();
    },
  });
  return (
    <div className="grid gap-3" data-testid="usb-panel">
      {done && <Alert variant="success">{t("backups.usb.copied")}</Alert>}
      {state.atServer ? (
        state.drives.length === 0 ? (
          <Alert variant="warning">{t("backups.usb.noDrive")}</Alert>
        ) : (
          <div className="grid gap-1 sm:max-w-sm">
            <Label htmlFor="usbDrive">{t("backups.usb.drive")}</Label>
            <NativeSelect id="usbDrive" value={chosen} onChange={(e) => setDrive(e.target.value)}>
              {state.drives.map((d) => (
                <option key={d.drive} value={d.drive}>
                  {`${d.drive} ${d.label} — ${t("backups.usb.free", { gb: gigabytes(d.freeBytes) })}`}
                </option>
              ))}
            </NativeSelect>
          </div>
        )
      ) : (
        <Alert>{t("backups.usb.waiting")}</Alert>
      )}
      {copy.isPending && <Alert>{t("backups.usb.copying")}</Alert>}
      {copy.error && <ErrorMessage error={asClientError(copy.error)} />}
      <div className="flex flex-wrap gap-2">
        {state.atServer && (
          <Button onClick={() => copy.mutate()} disabled={copy.isPending || !chosen}>
            {t("backups.usb.copy")}
          </Button>
        )}
        <Button variant="outline" onClick={() => void client.invalidateQueries({ queryKey: ["usb"] })}>
          {t("backups.usb.refresh")}
        </Button>
        {state.canSkip && state.state !== "none" && (
          <Button variant="ghost" onClick={() => setSkipping(true)}>
            {t("backups.usb.skip")}
          </Button>
        )}
      </div>
      <SkipDialog open={skipping} onClose={() => setSkipping(false)} />
    </div>
  );
}

/** Reminder on every computer from the first Friday 13:00 until the copy is done. */
export function UsbBanner({ state }: { state: UsbStateDto }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  return (
    <>
      <Alert variant="warning" className="flex flex-wrap items-center justify-between gap-3 rounded-none border-x-0 border-t-0" data-testid="usb-banner">
        <span>{t("backups.usb.remind", { time: formatDateTime(state.blockFrom) })}</span>
        <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
          {t("backups.usb.open")}
        </Button>
      </Alert>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent closeLabel={t("common.close")}>
          <DialogHeader>
            <DialogTitle>{t("backups.usb.open")}</DialogTitle>
          </DialogHeader>
          {open && <UsbCopyPanel state={state} />}
        </DialogContent>
      </Dialog>
    </>
  );
}

/** Overdue: the application stops on every computer until the copy is done or skipped with a reason. */
export function UsbBlockPage({ state }: { state: UsbStateDto }) {
  const { t } = useTranslation();
  return (
    <div className="mx-auto grid max-w-2xl gap-4 py-8" data-testid="usb-block">
      <Card>
        <CardHeader>
          <CardTitle>{t("backups.usb.title")}</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4">
          <p className="text-sm">{t("backups.usb.text")}</p>
          <UsbCopyPanel state={state} />
        </CardContent>
      </Card>
    </div>
  );
}
