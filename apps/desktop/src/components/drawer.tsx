import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Wallet } from "lucide-react";
import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import type { DrawerStateDto } from "@alyassir/shared";
import { Badge, Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, Textarea } from "@alyassir/ui";
import { asClientError } from "../adapters";
import { ErrorMessage, fieldsOf, useFieldError } from "../lib/errors";
import { api, useSession } from "../lib/session";
import { Field } from "./common";
import { Money, MoneyInput } from "./insurance";

/** Whoever records cash, or closes the drawer (the server checks the same). */
export function useHandlesCash(): boolean {
  const { can } = useSession();
  return can("payments.create") || can("expenses.create") || can("closing.create");
}

export function useDrawer() {
  const handles = useHandlesCash();
  const { can } = useSession();
  return useQuery({ queryKey: ["drawer"], queryFn: () => api<DrawerStateDto>("GET", "/api/drawer"), enabled: handles || can("closing.view") });
}

/**
 * Receiving the drawer (SPEC 17.3): the balance computed by the program, what the person really
 * found, and a reason when they differ. The server compares the two; the screen computes nothing.
 */
export function ReceiveDrawerDialog({ open, onClose, onReceived }: { open: boolean; onClose: () => void; onReceived?: () => void }) {
  const { t } = useTranslation();
  const fieldError = useFieldError();
  const queries = useQueryClient();
  const drawer = useDrawer();
  const [counted, setCounted] = useState<number | null>(null);
  const [reason, setReason] = useState("");
  const receive = useMutation({
    mutationFn: () => api<DrawerStateDto>("POST", "/api/drawer/receive", { shownCents: drawer.data?.balanceCents ?? 0, countedCents: counted, reason }),
    onSuccess: (st) => {
      queries.setQueryData(["drawer"], st);
      void queries.invalidateQueries({ queryKey: ["drawer"] });
      onReceived?.();
      onClose();
    },
    onError: (e) => {
      if (asClientError(e).code === "SESSION_CHANGED") void drawer.refetch();
    },
  });
  const error = receive.error ? asClientError(receive.error) : null;
  const fields = fieldsOf(error);
  const st = drawer.data;
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent closeLabel={t("common.close")}>
        <form onSubmit={(e: FormEvent) => { e.preventDefault(); receive.mutate(); }} className="grid gap-4" data-testid="receive-drawer">
          <DialogHeader>
            <DialogTitle>{t("drawer.receiveTitle")}</DialogTitle>
            <DialogDescription>{st?.session ? t("drawer.receiveJoin", { name: st.session.openedByName }) : t("drawer.receiveOpen")}</DialogDescription>
          </DialogHeader>
          <div className="flex items-center justify-between rounded-md border p-3">
            <span className="text-sm text-muted-foreground">{t("drawer.expected")}</span>
            <Money cents={st?.balanceCents ?? null} className="text-lg font-bold" />
          </div>
          <Field id="drawerCounted" label={t("drawer.counted")} hint={t("drawer.countedHint")} error={fieldError(fields.countedCents)}>
            <MoneyInput id="drawerCounted" cents={counted} onChange={setCounted} />
          </Field>
          <Field id="drawerReason" label={`${t("drawer.reason")} ${t("common.optional")}`} hint={t("drawer.reasonHint")}>
            <Textarea id="drawerReason" value={reason} onChange={(e) => setReason(e.target.value)} />
          </Field>
          <p className="text-xs text-muted-foreground">{t("drawer.responsibility")}</p>
          {error && error.code !== "VALIDATION" && <ErrorMessage error={error} />}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>{t("common.cancel")}</Button>
            <Button type="submit" disabled={receive.isPending || counted === null || !st}>{t("drawer.receive")}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Shown with the error "receive the drawer first": opens the window, then the person confirms again. */
export function ReceiveDrawerButton() {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [done, setDone] = useState(false);
  if (done) return <p className="mt-2 text-xs font-medium">{t("drawer.receivedRetry")}</p>;
  return (
    <>
      <Button type="button" size="sm" variant="outline" className="mt-2" onClick={() => setOpen(true)}>{t("drawer.receive")}</Button>
      {open && <ReceiveDrawerDialog open={open} onClose={() => setOpen(false)} onReceived={() => setDone(true)} />}
    </>
  );
}

/** Header badge: is the drawer received by me? (only for people who handle cash) */
export function DrawerBadge() {
  const { t } = useTranslation();
  const handles = useHandlesCash();
  const drawer = useDrawer();
  const [open, setOpen] = useState(false);
  if (!handles || !drawer.data) return null;
  if (drawer.data.holder) {
    return (
      <Badge variant="success" className="me-2" data-testid="drawer-badge">
        <Wallet className="size-3" />
        {t("drawer.held")}
      </Badge>
    );
  }
  return (
    <>
      <Button size="sm" variant="outline" className="me-2" onClick={() => setOpen(true)} data-testid="drawer-badge">
        <Wallet />
        {t("drawer.receive")}
      </Button>
      {open && <ReceiveDrawerDialog open={open} onClose={() => setOpen(false)} />}
    </>
  );
}
