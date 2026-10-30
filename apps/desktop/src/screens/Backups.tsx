import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import type { BackupFileDto, BackupSettings, BackupsDto, DriveStateDto } from "@alyassir/shared";
import {
  Alert,
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Checkbox,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
  Table,
  TBody,
  Td,
  Th,
  THead,
  Tr,
} from "@alyassir/ui";
import { asClientError } from "../adapters";
import { Field, PageHeader } from "../components/common";
import { UsbCopyPanel, useUsb } from "../components/backups";
import { ErrorMessage, fieldsOf, useFieldError } from "../lib/errors";
import { formatDateTime } from "../lib/format";
import { api, useSession } from "../lib/session";

const DAYS = [1, 2, 3, 4, 5, 6, 7] as const;

function megabytes(bytes: number): string {
  return (bytes / 1_000_000).toFixed(1);
}

function FolderDialog({ current, onClose }: { current: string; onClose: () => void }) {
  const { t } = useTranslation();
  const client = useQueryClient();
  const fieldError = useFieldError();
  const [path, setPath] = useState(current);
  const save = useMutation({
    mutationFn: () => api<BackupsDto>("PUT", "/api/backups/folder", { path }),
    onSuccess: (dto) => {
      client.setQueryData(["backups"], dto);
      onClose();
    },
  });
  const fields = fieldsOf(save.error ? asClientError(save.error) : null);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate();
  };
  return (
    <form className="grid gap-3" onSubmit={submit}>
      <DialogHeader>
        <DialogTitle>{t("backups.changeFolder")}</DialogTitle>
      </DialogHeader>
      <Field id="backupFolder" label={t("backups.folderPath")} hint={t("backups.folderHint")} error={fieldError(fields.path)}>
        <Input id="backupFolder" dir="ltr" value={path} onChange={(e) => setPath(e.target.value)} />
      </Field>
      {save.error && !fields.path && <ErrorMessage error={asClientError(save.error)} />}
      <DialogFooter>
        <Button type="submit" disabled={save.isPending}>{t("common.save")}</Button>
      </DialogFooter>
    </form>
  );
}

function SettingsCard({ settings }: { settings: BackupSettings }) {
  const { t } = useTranslation();
  const client = useQueryClient();
  const fieldError = useFieldError();
  const [form, setForm] = useState(settings);
  useEffect(() => setForm(settings), [settings]);
  const save = useMutation({
    mutationFn: () => api<BackupsDto>("PUT", "/api/backups/settings", form),
    onSuccess: (dto) => client.setQueryData(["backups"], dto),
  });
  const fields = fieldsOf(save.error ? asClientError(save.error) : null);
  const toggle = (d: number, on: boolean) => setForm((f) => ({ ...f, workDays: on ? [...f.workDays, d].sort() : f.workDays.filter((x) => x !== d) }));
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("backups.settings")}</CardTitle>
        <CardDescription>{t("backups.settingsHint")}</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        <fieldset className="grid gap-1.5">
          <legend className="mb-1 text-sm font-medium">{t("backups.workDays")}</legend>
          <div className="flex flex-wrap gap-3">
            {DAYS.map((d) => (
              <label key={d} className="flex items-center gap-1.5 text-sm">
                <Checkbox checked={form.workDays.includes(d)} onCheckedChange={(v) => toggle(d, v === true)} />
                {t(`backups.days.${d}`)}
              </label>
            ))}
          </div>
          {fields.workDays && <p className="text-xs text-destructive">{fieldError(fields.workDays)}</p>}
        </fieldset>
        <div className="flex flex-wrap gap-4">
          <Field id="workStart" label={t("backups.workStart")} error={fieldError(fields.workStart)}>
            <Input id="workStart" type="time" value={form.workStart} onChange={(e) => setForm({ ...form, workStart: e.target.value })} />
          </Field>
          <Field id="workEnd" label={t("backups.workEnd")} error={fieldError(fields.workEnd)}>
            <Input id="workEnd" type="time" value={form.workEnd} onChange={(e) => setForm({ ...form, workEnd: e.target.value })} />
          </Field>
          <Field id="usbTime" label={t("backups.usbTime")} error={fieldError(fields.usbTime)}>
            <Input id="usbTime" type="time" value={form.usbTime} onChange={(e) => setForm({ ...form, usbTime: e.target.value })} />
          </Field>
        </div>
        {save.isSuccess && <Alert variant="success">{t("common.saved")}</Alert>}
        {save.error && Object.keys(fields).length === 0 && <ErrorMessage error={asClientError(save.error)} />}
        <div>
          <Button onClick={() => save.mutate()} disabled={save.isPending}>{t("common.save")}</Button>
        </div>
      </CardContent>
    </Card>
  );
}

function RestoreDialog({ file, onClose }: { file: BackupFileDto; onClose: () => void }) {
  const { t } = useTranslation();
  const { signOut } = useSession();
  const [password, setPassword] = useState("");
  const restore = useMutation({
    mutationFn: () => api<{ restored: string; safety: string }>("POST", `/api/backups/${file.id}/restore`, { password }),
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    restore.mutate();
  };
  if (restore.data) {
    return (
      <div className="grid gap-3">
        <Alert variant="success">{t("backups.restored", { name: restore.data.restored, safety: restore.data.safety })}</Alert>
        <DialogFooter>
          <Button onClick={() => void signOut()}>{t("common.continue")}</Button>
        </DialogFooter>
      </div>
    );
  }
  return (
    <form className="grid gap-3" onSubmit={submit} data-testid="restore-dialog">
      <DialogHeader>
        <DialogTitle>{t("backups.restoreTitle", { time: formatDateTime(file.at) })}</DialogTitle>
      </DialogHeader>
      <Alert variant="warning">{t("backups.restoreWarning")}</Alert>
      <Field id="restorePassword" label={t("backups.restorePassword")}>
        <Input id="restorePassword" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
      </Field>
      {restore.isPending && <Alert>{t("backups.restoring")}</Alert>}
      {restore.error && <ErrorMessage error={asClientError(restore.error)} />}
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onClose} disabled={restore.isPending}>{t("common.cancel")}</Button>
        <Button type="submit" variant="destructive" disabled={restore.isPending || !password}>{t("backups.restoreConfirm")}</Button>
      </DialogFooter>
    </form>
  );
}

function DeleteDialog({ file, onClose }: { file: BackupFileDto; onClose: () => void }) {
  const { t } = useTranslation();
  const client = useQueryClient();
  const remove = useMutation({
    mutationFn: () => api<BackupsDto>("DELETE", `/api/backups/${file.id}`, {}),
    onSuccess: (dto) => {
      client.setQueryData(["backups"], dto);
      onClose();
    },
  });
  return (
    <div className="grid gap-3">
      <DialogHeader>
        <DialogTitle>{t("backups.delete")}</DialogTitle>
      </DialogHeader>
      <p className="text-sm">{t("backups.deleteConfirm", { name: file.name })}</p>
      {remove.error && <ErrorMessage error={asClientError(remove.error)} />}
      <DialogFooter>
        <Button variant="outline" onClick={onClose}>{t("common.cancel")}</Button>
        <Button variant="destructive" onClick={() => remove.mutate()} disabled={remove.isPending}>{t("backups.delete")}</Button>
      </DialogFooter>
    </div>
  );
}

/** Backups (SPEC 20): the manager only. Folder, last backup, files, restore, delete, working hours, USB copy. */
/** Phase 8A: Google Drive on the server computer, and the weekly look at drive.google.com. */
export function DriveCheck({ drive }: { drive: DriveStateDto }) {
  const { t } = useTranslation();
  const client = useQueryClient();
  const confirm = useMutation({
    mutationFn: () => api<DriveStateDto>("POST", "/api/backups/drive-checked", {}),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ["backups"] });
      void client.invalidateQueries({ queryKey: ["reminders"] });
      void client.invalidateQueries({ queryKey: ["dashboard"] });
    },
  });
  return (
    <div className="grid gap-3" data-testid="drive-check">
      {drive.running === false && <Alert variant="error">{t("backups.drive.notRunning")}</Alert>}
      {drive.confirmDue ? (
        <Alert variant="warning">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <span>{t("backups.drive.weekly")}</span>
            <Button size="sm" onClick={() => confirm.mutate()} disabled={confirm.isPending}>{t("backups.drive.checked")}</Button>
          </div>
        </Alert>
      ) : (
        drive.confirmedAt && <p className="text-sm text-muted-foreground">{t("backups.drive.lastChecked", { time: formatDateTime(drive.confirmedAt) })}</p>
      )}
      {confirm.error && <ErrorMessage error={asClientError(confirm.error)} />}
    </div>
  );
}

export function Backups() {
  const { t } = useTranslation();
  const client = useQueryClient();
  const list = useQuery({ queryKey: ["backups"], queryFn: () => api<BackupsDto>("GET", "/api/backups") });
  const usb = useUsb().data;
  const [folder, setFolder] = useState(false);
  const [restoring, setRestoring] = useState<BackupFileDto | null>(null);
  const [deleting, setDeleting] = useState<BackupFileDto | null>(null);
  const take = useMutation({
    mutationFn: () => api<BackupsDto>("POST", "/api/backups", {}),
    onSuccess: (dto) => client.setQueryData(["backups"], dto),
  });
  const data = list.data;

  return (
    <div className="grid gap-5">
      <PageHeader
        title={t("backups.title")}
        intro={t("backups.intro")}
        actions={data?.enabled && <Button onClick={() => take.mutate()} disabled={take.isPending || data.dirProblem !== null}>{t("backups.takeNow")}</Button>}
      />
      {list.error && <ErrorMessage error={asClientError(list.error)} />}
      {data && !data.enabled && <Alert>{t("backups.disabled")}</Alert>}
      {data?.enabled && (
        <>
          <Card>
            <CardHeader>
              <CardTitle>{t("backups.folder")}</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-3">
              <div className="flex flex-wrap items-center gap-3">
                <bdi dir="ltr" className="rounded bg-muted px-2 py-1 font-mono text-sm" data-testid="backup-folder">{data.dir}</bdi>
                <Button variant="outline" size="sm" onClick={() => setFolder(true)}>{t("backups.changeFolder")}</Button>
              </div>
              {data.dirProblem && <Alert variant="error">{t(`backups.folderProblem.${data.dirProblem}`)}</Alert>}
              <Alert>{t("backups.driveHelp")}</Alert>
              <DriveCheck drive={data.drive} />
              <p className="text-sm" data-testid="backup-last">{data.lastOkAt ? t("backups.lastOk", { time: formatDateTime(data.lastOkAt) }) : t("backups.never")}</p>
              {data.lastError && <Alert variant="warning">{t("backups.lastError", { error: data.lastError })}</Alert>}
              {(take.isPending || data.running) && <Alert>{t("backups.running")}</Alert>}
              {take.error && <ErrorMessage error={asClientError(take.error)} />}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>{t("backups.files")}</CardTitle>
            </CardHeader>
            <CardContent>
              {data.files.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t("common.empty")}</p>
              ) : (
                <Table data-testid="backup-files">
                  <THead>
                    <Tr>
                      <Th>{t("backups.columns.at")}</Th>
                      <Th>{t("backups.columns.kind")}</Th>
                      <Th>{t("backups.columns.size")}</Th>
                      <Th>{t("backups.columns.place")}</Th>
                      <Th>{t("backups.columns.check")}</Th>
                      <Th>{t("common.actions")}</Th>
                    </Tr>
                  </THead>
                  <TBody>
                    {data.files.map((f) => (
                      <Tr key={f.id}>
                        <Td>{formatDateTime(f.at)}</Td>
                        <Td>{t(`backups.kinds.${f.kind}`)}</Td>
                        <Td>{t("backups.size", { mb: megabytes(f.sizeBytes) })}</Td>
                        <Td>{t(`backups.places.${f.place}`)}</Td>
                        <Td>{f.checked ? <Badge variant="success">{t("backups.check.ok")}</Badge> : <Badge variant="outline">{t("backups.check.none")}</Badge>}</Td>
                        <Td>
                          <div className="flex gap-1">
                            <Button size="sm" variant="outline" onClick={() => setRestoring(f)}>{t("backups.restore")}</Button>
                            <Button size="sm" variant="ghost" onClick={() => setDeleting(f)}>{t("backups.delete")}</Button>
                          </div>
                        </Td>
                      </Tr>
                    ))}
                  </TBody>
                </Table>
              )}
            </CardContent>
          </Card>

          {usb && (
            <Card>
              <CardHeader>
                <CardTitle>{t("backups.usb.open")}</CardTitle>
                <CardDescription>{t("backups.settingsHint")}</CardDescription>
              </CardHeader>
              <CardContent>
                <UsbCopyPanel state={usb} />
              </CardContent>
            </Card>
          )}

          <SettingsCard settings={data.settings} />
        </>
      )}

      <Dialog open={folder} onOpenChange={setFolder}>
        <DialogContent closeLabel={t("common.close")}>{folder && data && <FolderDialog current={data.dir} onClose={() => setFolder(false)} />}</DialogContent>
      </Dialog>
      <Dialog open={restoring !== null} onOpenChange={(o) => !o && setRestoring(null)}>
        <DialogContent closeLabel={t("common.close")}>{restoring && <RestoreDialog file={restoring} onClose={() => setRestoring(null)} />}</DialogContent>
      </Dialog>
      <Dialog open={deleting !== null} onOpenChange={(o) => !o && setDeleting(null)}>
        <DialogContent closeLabel={t("common.close")}>{deleting && <DeleteDialog file={deleting} onClose={() => setDeleting(null)} />}</DialogContent>
      </Dialog>
    </div>
  );
}
