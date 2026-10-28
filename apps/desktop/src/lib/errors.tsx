import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Alert, Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, Label, Textarea } from "@alyassir/ui";
import { asClientError, type ClientError } from "../adapters";
import { ReceiveDrawerButton } from "../components/drawer";
import { formatDateTime } from "./format";
import { api, useSession } from "./session";

type Requestable = NonNullable<ClientError["requestable"]>;

/** Employee without the permission on this record: ask the manager for a one-time grant (SPEC 8). */
function RequestEdit({ target }: { target: Requestable }) {
  const { t } = useTranslation();
  const client = useQueryClient();
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");
  const send = useMutation({
    mutationFn: () => api("POST", "/api/edit-requests", { ...target, note }),
    onSuccess: () => client.invalidateQueries({ queryKey: ["editRequests"] }),
  });
  const operation = t(`editRequests.operations.${target.operation}`, { defaultValue: target.operation });
  if (send.isSuccess) return <p className="mt-2 text-xs">{t("editRequests.askSent")}</p>;
  return (
    <>
      <Button type="button" size="sm" variant="outline" className="mt-2" onClick={() => setOpen(true)}>{t("editRequests.ask")}</Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent closeLabel={t("common.close")}>
          <form onSubmit={(e) => { e.preventDefault(); send.mutate(); }} className="grid gap-4">
            <DialogHeader>
              <DialogTitle>{t("editRequests.askTitle", { operation })}</DialogTitle>
              <DialogDescription>{t("editRequests.askHint")}</DialogDescription>
            </DialogHeader>
            <div className="grid gap-1.5">
              <Label htmlFor="askNote">{t("editRequests.note")}</Label>
              <Textarea id="askNote" value={note} onChange={(e) => setNote(e.target.value)} />
            </div>
            {send.error && <ErrorMessage error={asClientError(send.error)} />}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setOpen(false)}>{t("common.cancel")}</Button>
              <Button type="submit" disabled={send.isPending || !note.trim()}>{t("messages.send")}</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}

/** Error text in the user's language, plus a support code (SPEC 5). */
export function ErrorMessage({ error }: { error: ClientError | null | undefined }) {
  const { t } = useTranslation();
  const { isManager } = useSession();
  if (!error) return null;
  const known = t(`errors.api.${error.code}`, { defaultValue: "" });
  const text = error.code === "ACCOUNT_LOCKED" && error.lockedUntil
    ? t("login.lockedUntil", { time: formatDateTime(error.lockedUntil) })
    : error.code === "FINGERPRINT_MISMATCH"
      ? t("errors.fingerprint_mismatch")
      : known || t("errors.api.INTERNAL");
  return (
    <Alert variant="error">
      <p>{text}</p>
      <p className="mt-1 text-xs opacity-80">{t("errors.code", { code: `API-${error.code}` })}</p>
      {error.requestable && !isManager && <RequestEdit target={error.requestable} />}
      {error.code === "DRAWER_NOT_RECEIVED" && <ReceiveDrawerButton />}
    </Alert>
  );
}

/** Field error key -> text, for forms (server and local validation use the same keys). */
export function useFieldError(): (key: string | undefined) => string | undefined {
  const { t } = useTranslation();
  return (key) => (key ? t(`errors.fields.${key}`, { defaultValue: t("errors.fields.invalid") }) : undefined);
}

export function fieldsOf(error: ClientError | null | undefined): Record<string, string> {
  return error?.code === "VALIDATION" ? (error.fields ?? {}) : {};
}
