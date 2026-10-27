import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import {
  EXTRA_PERMISSIONS,
  LEVELS,
  MODULES,
  SUPERVISOR_PERMISSIONS,
  createUserSchema,
  type Language,
  type PermissionCode,
  type UserDto,
} from "@alyassir/shared";
import {
  Alert,
  Badge,
  Button,
  Checkbox,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
  NativeSelect,
  Switch,
  Table,
  TBody,
  Td,
  Th,
  THead,
  Tr,
} from "@alyassir/ui";
import { asClientError, type ClientError } from "../adapters";
import { DataTable, Field, PageHeader } from "../components/common";
import { ErrorMessage, fieldsOf, useFieldError } from "../lib/errors";
import { formatDateTime } from "../lib/format";
import { api } from "../lib/session";

type Dialogs =
  | { kind: "create" }
  | { kind: "edit"; user: UserDto }
  | { kind: "permissions"; user: UserDto }
  | { kind: "reset"; user: UserDto }
  | { kind: "disable"; user: UserDto }
  | null;

function codeKey(code: string): string {
  return `permissions.codes.${code.replace(/\./g, "_")}`;
}

function CreateUserDialog({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const fieldError = useFieldError();
  const client = useQueryClient();
  const [form, setForm] = useState({ username: "", displayName: "", password: "" });
  const [local, setLocal] = useState<Record<string, string>>({});
  const create = useMutation({
    mutationFn: () => api<UserDto>("POST", "/api/users", { ...form, language: null }),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ["users"] });
      onClose();
    },
  });
  function submit(e: FormEvent) {
    e.preventDefault();
    const parsed = createUserSchema.safeParse({ ...form, language: null });
    const errors: Record<string, string> = {};
    if (!parsed.success) for (const i of parsed.error.issues) errors[i.path.join(".")] ??= i.message;
    setLocal(errors);
    if (!Object.keys(errors).length) create.mutate();
  }
  const server = fieldsOf(create.error ? asClientError(create.error) : null);
  const err = (k: string) => fieldError(local[k] ?? server[k]);
  return (
    <form onSubmit={submit} className="grid gap-4">
      <DialogHeader>
        <DialogTitle>{t("users.addTitle")}</DialogTitle>
      </DialogHeader>
      <Field id="displayName" label={t("users.displayName")} error={err("displayName")}>
        <Input id="displayName" value={form.displayName} onChange={(e) => setForm({ ...form, displayName: e.target.value })} />
      </Field>
      <Field id="newUsername" label={t("users.username")} hint={t("users.usernameHint")} error={err("username")}>
        <Input id="newUsername" dir="ltr" value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} />
      </Field>
      <Field id="newPassword" label={t("users.password")} hint={t("users.passwordHint")} error={err("password")}>
        <Input id="newPassword" type="password" dir="ltr" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
      </Field>
      {create.error && asClientError(create.error).code !== "VALIDATION" && <ErrorMessage error={asClientError(create.error)} />}
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onClose}>{t("common.cancel")}</Button>
        <Button type="submit" disabled={create.isPending}>{t("common.create")}</Button>
      </DialogFooter>
    </form>
  );
}

function EditUserDialog({ user, onClose }: { user: UserDto; onClose: () => void }) {
  const { t } = useTranslation();
  const fieldError = useFieldError();
  const client = useQueryClient();
  const [displayName, setDisplayName] = useState(user.displayName);
  const [language, setLanguage] = useState<Language | "">(user.language ?? "");
  const [isSupervisor, setIsSupervisor] = useState(user.isSupervisor);
  const save = useMutation({
    mutationFn: () =>
      api<UserDto>("PATCH", `/api/users/${user.id}`, {
        version: user.version,
        displayName,
        language: language || null,
        ...(user.role === "employee" ? { isSupervisor } : {}),
      }),
    onSettled: () => client.invalidateQueries({ queryKey: ["users"] }),
    onSuccess: onClose,
  });
  const error = save.error ? asClientError(save.error) : null;
  return (
    <form onSubmit={(e) => { e.preventDefault(); save.mutate(); }} className="grid gap-4">
      <DialogHeader>
        <DialogTitle>{t("users.editTitle", { name: user.displayName })}</DialogTitle>
      </DialogHeader>
      <Field id="editName" label={t("users.displayName")} error={fieldError(fieldsOf(error).displayName)}>
        <Input id="editName" value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
      </Field>
      <Field id="editLanguage" label={t("users.language")}>
        <NativeSelect id="editLanguage" value={language} onChange={(e) => setLanguage(e.target.value as Language | "")}>
          <option value="">{t("users.languageNotChosen")}</option>
          <option value="ar">{t("language.ar")}</option>
          <option value="fr">{t("language.fr")}</option>
        </NativeSelect>
      </Field>
      {user.role === "employee" && (
        <div className="flex items-start gap-3">
          <Switch id="isSupervisor" checked={isSupervisor} onCheckedChange={setIsSupervisor} />
          <div className="grid gap-1">
            <Label htmlFor="isSupervisor">{t("users.supervisor")}</Label>
            <p className="text-xs text-muted-foreground">{t("users.supervisorHint")}</p>
            {user.isSupervisor && !isSupervisor && <p className="text-xs text-warning">{t("permissions.supervisorHint")}</p>}
          </div>
        </div>
      )}
      {error && error.code !== "VALIDATION" && <ErrorMessage error={error} />}
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onClose}>{t("common.cancel")}</Button>
        <Button type="submit" disabled={save.isPending}>{t("common.save")}</Button>
      </DialogFooter>
    </form>
  );
}

/** Matrix: 10 modules x view/create/edit, the two extras, and the supervisor powers. */
function PermissionsDialog({ user, onClose }: { user: UserDto; onClose: () => void }) {
  const { t } = useTranslation();
  const client = useQueryClient();
  const [codes, setCodes] = useState<Set<PermissionCode>>(new Set(user.permissions));
  const toggle = (code: PermissionCode, on: boolean) =>
    setCodes((prev) => {
      const next = new Set(prev);
      if (on) next.add(code);
      else next.delete(code);
      return next;
    });
  const save = useMutation({
    mutationFn: () => api<UserDto>("PUT", `/api/users/${user.id}/permissions`, { version: user.version, permissions: [...codes] }),
    onSettled: () => client.invalidateQueries({ queryKey: ["users"] }),
    onSuccess: onClose,
  });
  const box = (code: PermissionCode, label: string) => (
    <Checkbox checked={codes.has(code)} onCheckedChange={(v) => toggle(code, v === true)} aria-label={label} data-code={code} />
  );
  return (
    <div className="grid gap-4">
      <DialogHeader>
        <DialogTitle>{t("permissions.title", { name: user.displayName })}</DialogTitle>
        <DialogDescription>{t("permissions.safeBankNote")}</DialogDescription>
      </DialogHeader>
      <section className="grid gap-2">
        <h3 className="font-semibold">{t("permissions.modulesTitle")}</h3>
        <Table>
          <THead>
            <Tr>
              <Th />
              {LEVELS.map((l) => <Th key={l} className="text-center">{t(`levels.${l}`)}</Th>)}
            </Tr>
          </THead>
          <TBody>
            {MODULES.map((m) => (
              <Tr key={m}>
                <Td>{t(`modules.${m}`)}</Td>
                {LEVELS.map((l) => (
                  <Td key={l} className="text-center">{box(`${m}.${l}` as PermissionCode, `${t(`modules.${m}`)} — ${t(`levels.${l}`)}`)}</Td>
                ))}
              </Tr>
            ))}
          </TBody>
        </Table>
      </section>
      <section className="grid gap-2">
        <h3 className="font-semibold">{t("permissions.extrasTitle")}</h3>
        {EXTRA_PERMISSIONS.map((code) => (
          <label key={code} className="flex items-center gap-2 text-sm">
            {box(code, t(codeKey(code)))}
            {t(codeKey(code))}
          </label>
        ))}
      </section>
      <section className="grid gap-2">
        <h3 className="font-semibold">{t("permissions.supervisorTitle")}</h3>
        {user.isSupervisor ? (
          <>
            <p className="text-xs text-muted-foreground">{t("permissions.supervisorHint")}</p>
            {SUPERVISOR_PERMISSIONS.map((code) => (
              <label key={code} className="flex items-center gap-2 text-sm">
                {box(code, t(codeKey(code)))}
                {t(codeKey(code))}
              </label>
            ))}
          </>
        ) : (
          <Alert>{t("permissions.notSupervisorHint")}</Alert>
        )}
      </section>
      <ErrorMessage error={save.error ? asClientError(save.error) : null} />
      <DialogFooter>
        <Button variant="outline" onClick={onClose}>{t("common.cancel")}</Button>
        <Button onClick={() => save.mutate()} disabled={save.isPending}>{t("common.save")}</Button>
      </DialogFooter>
    </div>
  );
}

function ResetPasswordDialog({ user, onClose }: { user: UserDto; onClose: () => void }) {
  const { t } = useTranslation();
  const fieldError = useFieldError();
  const [password, setPassword] = useState("");
  const reset = useMutation({ mutationFn: () => api<void>("POST", `/api/users/${user.id}/reset-password`, { newPassword: password }), onSuccess: onClose });
  const error = reset.error ? asClientError(reset.error) : null;
  return (
    <form onSubmit={(e) => { e.preventDefault(); reset.mutate(); }} className="grid gap-4">
      <DialogHeader>
        <DialogTitle>{t("users.resetTitle", { name: user.displayName })}</DialogTitle>
        <DialogDescription>{t("users.resetHint")}</DialogDescription>
      </DialogHeader>
      <Field id="resetPassword" label={t("users.newPassword")} hint={t("users.passwordHint")} error={fieldError(fieldsOf(error).newPassword)}>
        <Input id="resetPassword" type="password" dir="ltr" value={password} onChange={(e) => setPassword(e.target.value)} />
      </Field>
      {error && error.code !== "VALIDATION" && <ErrorMessage error={error} />}
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onClose}>{t("common.cancel")}</Button>
        <Button type="submit" disabled={reset.isPending}>{t("common.save")}</Button>
      </DialogFooter>
    </form>
  );
}

function DisableDialog({ user, onClose }: { user: UserDto; onClose: () => void }) {
  const { t } = useTranslation();
  const client = useQueryClient();
  const disable = useMutation({
    mutationFn: () => api<UserDto>("POST", `/api/users/${user.id}/disable`),
    onSettled: () => client.invalidateQueries({ queryKey: ["users"] }),
    onSuccess: onClose,
  });
  return (
    <div className="grid gap-4">
      <DialogHeader>
        <DialogTitle>{t("users.disable")}</DialogTitle>
        <DialogDescription>{t("users.disableConfirm", { name: user.displayName })}</DialogDescription>
      </DialogHeader>
      <ErrorMessage error={disable.error ? asClientError(disable.error) : null} />
      <DialogFooter>
        <Button variant="outline" onClick={onClose}>{t("common.cancel")}</Button>
        <Button variant="destructive" onClick={() => disable.mutate()} disabled={disable.isPending}>{t("users.disable")}</Button>
      </DialogFooter>
    </div>
  );
}

export function Users() {
  const { t } = useTranslation();
  const client = useQueryClient();
  const [dialog, setDialog] = useState<Dialogs>(null);
  const [actionError, setActionError] = useState<ClientError | null>(null);
  const users = useQuery({ queryKey: ["users"], queryFn: () => api<UserDto[]>("GET", "/api/users") });
  const quick = useMutation({
    mutationFn: ({ id, action }: { id: string; action: "enable" | "unlock" }) => api<UserDto>("POST", `/api/users/${id}/${action}`),
    onSuccess: () => setActionError(null),
    onError: (e) => setActionError(asClientError(e)),
    onSettled: () => client.invalidateQueries({ queryKey: ["users"] }),
  });

  const close = () => setDialog(null);
  return (
    <div>
      <PageHeader title={t("users.title")} actions={<Button onClick={() => setDialog({ kind: "create" })}>{t("users.add")}</Button>} />
      <ErrorMessage error={actionError} />
      <DataTable
        rows={users.data ?? []}
        rowKey={(u) => u.id}
        columns={[
          { key: "name", header: t("users.displayName"), value: (u) => u.displayName, cell: (u) => <span className="font-medium">{u.displayName}</span> },
          { key: "username", header: t("users.username"), value: (u) => u.username, cell: (u) => <bdi dir="ltr">{u.username}</bdi> },
          {
            key: "role",
            header: t("users.role"),
            value: (u) => u.role,
            cell: (u) => (
              <div className="flex gap-1">
                <Badge variant={u.role === "manager" ? "default" : "secondary"}>{u.role === "manager" ? t("shell.managerBadge") : t("shell.employeeBadge")}</Badge>
                {u.isSupervisor && <Badge variant="outline">{t("shell.supervisorBadge")}</Badge>}
              </div>
            ),
          },
          {
            key: "status",
            header: t("users.status"),
            value: (u) => (u.isActive ? 1 : 0),
            cell: (u) => (
              <div className="flex flex-wrap gap-1">
                <Badge variant={u.isActive ? "success" : "destructive"}>{u.isActive ? t("users.active") : t("users.disabled")}</Badge>
                {u.lockedUntil && <Badge variant="warning" title={formatDateTime(u.lockedUntil)}>{t("users.locked")}</Badge>}
              </div>
            ),
          },
          {
            key: "actions",
            header: t("common.actions"),
            cell: (u) => (
              <div className="flex flex-wrap gap-1">
                <Button size="sm" variant="outline" onClick={() => setDialog({ kind: "edit", user: u })}>{t("common.edit")}</Button>
                {u.role === "employee" && (
                  <>
                    <Button size="sm" variant="outline" onClick={() => setDialog({ kind: "permissions", user: u })}>{t("users.permissions")}</Button>
                    <Button size="sm" variant="outline" onClick={() => setDialog({ kind: "reset", user: u })}>{t("users.resetPassword")}</Button>
                    {u.isActive ? (
                      <Button size="sm" variant="ghost" onClick={() => setDialog({ kind: "disable", user: u })}>{t("users.disable")}</Button>
                    ) : (
                      <Button size="sm" variant="ghost" onClick={() => quick.mutate({ id: u.id, action: "enable" })}>{t("users.enable")}</Button>
                    )}
                  </>
                )}
                {u.lockedUntil && <Button size="sm" variant="secondary" onClick={() => quick.mutate({ id: u.id, action: "unlock" })}>{t("users.unlock")}</Button>}
              </div>
            ),
          },
        ]}
      />
      <Dialog open={dialog !== null} onOpenChange={(open) => !open && close()}>
        <DialogContent closeLabel={t("common.close")} wide={dialog?.kind === "permissions"}>
          {dialog?.kind === "create" && <CreateUserDialog onClose={close} />}
          {dialog?.kind === "edit" && <EditUserDialog user={dialog.user} onClose={close} />}
          {dialog?.kind === "permissions" && <PermissionsDialog user={dialog.user} onClose={close} />}
          {dialog?.kind === "reset" && <ResetPasswordDialog user={dialog.user} onClose={close} />}
          {dialog?.kind === "disable" && <DisableDialog user={dialog.user} onClose={close} />}
        </DialogContent>
      </Dialog>
    </div>
  );
}
