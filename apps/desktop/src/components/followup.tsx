import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { MessageCircle, Phone } from "lucide-react";
import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { CLAIM_STATUSES, CONTACT_KINDS, TEMPLATE_CODES, type ClaimDto, type ClaimStatusCode, type ContactDto, type Page as PageOf, type WhatsappLinkDto } from "@alyassir/shared";
import {
  Alert,
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  NativeSelect,
  Table,
  TBody,
  Td,
  Textarea,
  Th,
  THead,
  Tr,
} from "@alyassir/ui";
import { adapter, asClientError } from "../adapters";
import { ErrorMessage, fieldsOf, useFieldError } from "../lib/errors";
import { formatDateTime } from "../lib/format";
import { api, useSession } from "../lib/session";
import { Field } from "./common";
import { Code, Money, MoneyInput, formatDay } from "./insurance";

// ---------------------------------------------------------------- WhatsApp (SPEC 18.4)

/** Opens WhatsApp with a message filled by the server; nothing is sent by the program. */
export function WhatsappButton({ clientId, policyId, template, size = "sm" }: { clientId: string; policyId?: string | null; template?: "renewal" | "payment" | null; size?: "sm" | "default" }) {
  const { t } = useTranslation();
  const { can } = useSession();
  const [open, setOpen] = useState(false);
  if (!can("clients.view")) return null;
  return (
    <>
      <Button type="button" size={size} variant="outline" onClick={() => setOpen(true)} aria-label={t("followup.whatsapp")}>
        <MessageCircle />
        {t("followup.whatsapp")}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent closeLabel={t("common.close")}>
          {open && <WhatsappDialog clientId={clientId} policyId={policyId ?? null} template={template ?? "renewal"} onClose={() => setOpen(false)} />}
        </DialogContent>
      </Dialog>
    </>
  );
}

function WhatsappDialog({ clientId, policyId, template: initial, onClose }: { clientId: string; policyId: string | null; template: "renewal" | "payment"; onClose: () => void }) {
  const { t, i18n } = useTranslation();
  const queries = useQueryClient();
  const [template, setTemplate] = useState<"renewal" | "payment">(initial);
  const [language, setLanguage] = useState<"ar" | "fr">(i18n.language === "fr" ? "fr" : "ar");
  const [done, setDone] = useState<WhatsappLinkDto | null>(null);
  const run = useMutation({
    mutationFn: () => api<WhatsappLinkDto>("POST", "/api/contacts/whatsapp", { clientId, policyId, template, language }),
    onSuccess: async (link) => {
      setDone(link);
      await queries.invalidateQueries({ queryKey: ["contacts", clientId] });
      await adapter.openWhatsapp(link.url);
    },
  });
  const error = run.error ? asClientError(run.error) : null;
  return (
    <form onSubmit={(e: FormEvent) => { e.preventDefault(); run.mutate(); }} className="grid gap-4" data-testid="whatsapp-dialog">
      <DialogHeader>
        <DialogTitle>{t("followup.whatsappTitle")}</DialogTitle>
        <DialogDescription>{t("followup.whatsappInfo")}</DialogDescription>
      </DialogHeader>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field id="waTemplate" label={t("followup.template")}>
          <NativeSelect id="waTemplate" value={template} onChange={(e) => setTemplate(e.target.value as "renewal" | "payment")}>
            {TEMPLATE_CODES.map((c) => <option key={c} value={c}>{t(`followup.templates.${c}`)}</option>)}
          </NativeSelect>
        </Field>
        <Field id="waLanguage" label={t("followup.language")}>
          <NativeSelect id="waLanguage" value={language} onChange={(e) => setLanguage(e.target.value as "ar" | "fr")}>
            <option value="ar">{t("language.ar")}</option>
            <option value="fr">{t("language.fr")}</option>
          </NativeSelect>
        </Field>
      </div>
      {done && (
        <Alert variant="success">
          <p dir="auto" className="whitespace-pre-wrap" data-testid="whatsapp-text">{done.text}</p>
          <p className="mt-1 text-xs">{t("followup.whatsappOpened", { phone: `+${done.phone}` })}</p>
        </Alert>
      )}
      {error && <ErrorMessage error={error} />}
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onClose}>{t("common.close")}</Button>
        <Button type="submit" disabled={run.isPending}>
          <MessageCircle />
          {t("followup.openWhatsapp")}
        </Button>
      </DialogFooter>
    </form>
  );
}

// ---------------------------------------------------------------- contact log (SPEC 18.3)

export function ContactLog({ clientId }: { clientId: string }) {
  const { t } = useTranslation();
  const list = useQuery({ queryKey: ["contacts", clientId], queryFn: () => api<ContactDto[]>("GET", `/api/contacts/client/${clientId}`) });
  const [adding, setAdding] = useState(false);
  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="outline" onClick={() => setAdding(true)}>
          <Phone />
          {t("followup.addContact")}
        </Button>
        <WhatsappButton clientId={clientId} />
      </div>
      <Table data-testid="contacts">
        <THead>
          <Tr>
            <Th>{t("common.date")}</Th>
            <Th>{t("followup.contactKind")}</Th>
            <Th>{t("common.details")}</Th>
            <Th>{t("cash.by")}</Th>
          </Tr>
        </THead>
        <TBody>
          {list.data?.length === 0 && (
            <Tr>
              <Td colSpan={4} className="text-center text-muted-foreground">{t("common.empty")}</Td>
            </Tr>
          )}
          {list.data?.map((c) => (
            <Tr key={c.id}>
              <Td>{formatDateTime(c.createdAt)}</Td>
              <Td>
                <span className="inline-flex flex-wrap items-center gap-1">
                  {t(`followup.contactKinds.${c.kind}`)}
                  {c.promiseDate && <Badge variant="warning">{formatDay(c.promiseDate)}</Badge>}
                  {c.templateCode && <Badge variant="outline">{t(`followup.templates.${c.templateCode}`, { defaultValue: c.templateCode })}</Badge>}
                </span>
              </Td>
              <Td dir="auto" className="max-w-md whitespace-pre-wrap">{c.note}{c.policyNumber ? ` · ${c.policyNumber}` : ""}</Td>
              <Td>{c.createdByName}</Td>
            </Tr>
          ))}
        </TBody>
      </Table>
      <Dialog open={adding} onOpenChange={setAdding}>
        <DialogContent closeLabel={t("common.close")}>{adding && <ContactDialog clientId={clientId} onClose={() => setAdding(false)} />}</DialogContent>
      </Dialog>
    </div>
  );
}

export function ContactDialog({ clientId, policyId = null, onClose }: { clientId: string; policyId?: string | null; onClose: () => void }) {
  const { t } = useTranslation();
  const fieldError = useFieldError();
  const queries = useQueryClient();
  const [kind, setKind] = useState<(typeof CONTACT_KINDS)[number]>("called");
  const [promiseDate, setPromiseDate] = useState("");
  const [note, setNote] = useState("");
  const run = useMutation({
    mutationFn: () => api<ContactDto[]>("POST", "/api/contacts", { clientId, policyId, kind, promiseDate: kind === "promise" ? promiseDate || null : null, note }),
    onSuccess: async (list) => {
      queries.setQueryData(["contacts", clientId], list);
      await queries.invalidateQueries({ queryKey: ["reminders"] });
      onClose();
    },
  });
  const error = run.error ? asClientError(run.error) : null;
  const fields = fieldsOf(error);
  return (
    <form onSubmit={(e: FormEvent) => { e.preventDefault(); run.mutate(); }} className="grid gap-4">
      <DialogHeader>
        <DialogTitle>{t("followup.addContact")}</DialogTitle>
      </DialogHeader>
      <Field id="contactKind" label={t("followup.contactKind")}>
        <NativeSelect id="contactKind" value={kind} onChange={(e) => setKind(e.target.value as (typeof CONTACT_KINDS)[number])}>
          {CONTACT_KINDS.map((k) => <option key={k} value={k}>{t(`followup.contactKinds.${k}`)}</option>)}
        </NativeSelect>
      </Field>
      {kind === "promise" && (
        <Field id="promiseDate" label={t("followup.promiseDate")} error={fieldError(fields.promiseDate)}>
          <Input id="promiseDate" type="date" dir="ltr" value={promiseDate} onChange={(e) => setPromiseDate(e.target.value)} />
        </Field>
      )}
      <Field id="contactNote" label={`${t("cash.note")} ${kind === "note" ? "" : t("common.optional")}`} error={fieldError(fields.note)}>
        <Textarea id="contactNote" value={note} onChange={(e) => setNote(e.target.value)} />
      </Field>
      {error && error.code !== "VALIDATION" && <ErrorMessage error={error} />}
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onClose}>{t("common.cancel")}</Button>
        <Button type="submit" disabled={run.isPending}>{t("common.save")}</Button>
      </DialogFooter>
    </form>
  );
}

// ---------------------------------------------------------------- claims (SPEC 18.1)

const CLAIM_VARIANT: Record<ClaimStatusCode, "secondary" | "warning" | "success" | "destructive" | "outline"> = {
  declared: "secondary",
  expertise: "warning",
  processing: "warning",
  closed: "success",
  rejected: "destructive",
};

export function ClaimStatusBadge({ status }: { status: ClaimStatusCode }) {
  const { t } = useTranslation();
  return <Badge variant={CLAIM_VARIANT[status]}>{t(`followup.claimStatus.${status}`)}</Badge>;
}

/** Claims of a client or of a policy, with the "new claim" button when a policy is known. */
export function ClaimsList({ clientId, policyId, onOpenPolicy }: { clientId?: string; policyId?: string; onOpenPolicy?: (id: string) => void }) {
  const { t } = useTranslation();
  const { can } = useSession();
  const [page, setPage] = useState(1);
  const params = new URLSearchParams({ status: "all", page: String(page), pageSize: "10" });
  if (clientId) params.set("clientId", clientId);
  if (policyId) params.set("policyId", policyId);
  const list = useQuery({ queryKey: ["claims", clientId ?? "", policyId ?? "", page], queryFn: () => api<PageOf<ClaimDto>>("GET", `/api/claims?${params.toString()}`), placeholderData: keepPreviousData });
  const [editing, setEditing] = useState<ClaimDto | "new" | null>(null);
  if (!can("claims.view")) return null;
  return (
    <div className="grid gap-3">
      {policyId && can("claims.create") && (
        <div>
          <Button size="sm" variant="outline" onClick={() => setEditing("new")}>{t("followup.newClaim")}</Button>
        </div>
      )}
      <ClaimsTable rows={list.data?.items ?? []} onEdit={setEditing} onOpenPolicy={onOpenPolicy} />
      <Dialog open={editing !== null} onOpenChange={(o) => !o && setEditing(null)}>
        <DialogContent closeLabel={t("common.close")} wide>
          {editing && <ClaimDialog claim={editing === "new" ? null : editing} policyId={policyId ?? null} onClose={() => setEditing(null)} />}
        </DialogContent>
      </Dialog>
      {list.data && list.data.total > list.data.pageSize && (
        <div className="flex gap-2">
          <Button size="sm" variant="outline" disabled={page <= 1} onClick={() => setPage(page - 1)}>{t("common.previous")}</Button>
          <Button size="sm" variant="outline" disabled={page * list.data.pageSize >= list.data.total} onClick={() => setPage(page + 1)}>{t("common.next")}</Button>
        </div>
      )}
    </div>
  );
}

export function ClaimsTable({ rows, onEdit, onOpenPolicy }: { rows: ClaimDto[]; onEdit: (c: ClaimDto) => void; onOpenPolicy?: (id: string) => void }) {
  const { t } = useTranslation();
  const { can } = useSession();
  return (
    <Table data-testid="claims">
      <THead>
        <Tr>
          <Th>{t("followup.accidentDate")}</Th>
          <Th>{t("followup.claimNumber")}</Th>
          <Th>{t("policies.client")}</Th>
          <Th>{t("policies.number")}</Th>
          <Th>{t("followup.requested")}</Th>
          <Th>{t("followup.compensated")}</Th>
          <Th>{t("common.status")}</Th>
          <Th />
        </Tr>
      </THead>
      <TBody>
        {rows.length === 0 && (
          <Tr>
            <Td colSpan={8} className="text-center text-muted-foreground">{t("common.empty")}</Td>
          </Tr>
        )}
        {rows.map((c) => (
          <Tr key={c.id}>
            <Td>
              <div className="grid">
                <span>{formatDay(c.accidentDate)}</span>
                <span className="text-xs text-muted-foreground" dir="auto">{c.place}</span>
              </div>
            </Td>
            <Td><Code>{c.claimNumber}</Code></Td>
            <Td dir="auto">{c.clientName}</Td>
            <Td>{onOpenPolicy ? <Button variant="link" className="h-auto p-0" onClick={() => onOpenPolicy(c.policyId)}><Code>{c.policyNumber}</Code></Button> : <Code>{c.policyNumber}</Code>}</Td>
            <Td><Money cents={c.requestedCents} /></Td>
            <Td><Money cents={c.compensatedCents} /></Td>
            <Td>
              <span className="inline-flex flex-wrap items-center gap-1">
                <ClaimStatusBadge status={c.status} />
                {c.lateReason && <Badge variant="outline">{t("followup.lateDeclared")}</Badge>}
              </span>
            </Td>
            <Td className="text-end">{can("claims.edit") && <Button size="sm" variant="outline" onClick={() => onEdit(c)}>{t("common.edit")}</Button>}</Td>
          </Tr>
        ))}
      </TBody>
    </Table>
  );
}

/** New claim (on a policy) or follow-up of an existing one. Amounts are information only. */
export function ClaimDialog({ claim, policyId, onClose }: { claim: ClaimDto | null; policyId: string | null; onClose: () => void }) {
  const { t } = useTranslation();
  const fieldError = useFieldError();
  const queries = useQueryClient();
  const { isManager } = useSession();
  const [accidentDate, setAccidentDate] = useState(claim?.accidentDate ?? "");
  const [claimNumber, setClaimNumber] = useState(claim?.claimNumber ?? "");
  const [place, setPlace] = useState(claim?.place ?? "");
  const [description, setDescription] = useState(claim?.description ?? "");
  const [requested, setRequested] = useState<number | null>(claim?.requestedCents ?? null);
  const [compensated, setCompensated] = useState<number | null>(claim?.compensatedCents ?? null);
  const [notes, setNotes] = useState(claim?.notes ?? "");
  const [status, setStatus] = useState<ClaimStatusCode>(claim?.status ?? "declared");
  const [reason, setReason] = useState("");
  const [lateReason, setLateReason] = useState("");
  const run = useMutation({
    mutationFn: () =>
      claim
        ? api<ClaimDto>("PATCH", `/api/claims/${claim.id}`, { version: claim.version, claimNumber, place, description, requestedCents: requested, compensatedCents: compensated, notes, status, reason })
        : api<ClaimDto>("POST", "/api/claims", { policyId, claimNumber, accidentDate, place, description, requestedCents: requested, notes, lateReason }),
    onSuccess: async () => {
      await Promise.all(["claims", "reminders"].map((k) => queries.invalidateQueries({ queryKey: [k] })));
      onClose();
    },
  });
  const error = run.error ? asClientError(run.error) : null;
  const fields = fieldsOf(error);
  const reopening = claim && (claim.status === "closed" || claim.status === "rejected") && status !== claim.status;
  return (
    <form onSubmit={(e: FormEvent) => { e.preventDefault(); run.mutate(); }} className="grid gap-4" data-testid="claim-dialog">
      <DialogHeader>
        <DialogTitle>{claim ? t("followup.claimTitle", { number: claim.policyNumber }) : t("followup.newClaim")}</DialogTitle>
        <DialogDescription>{t("followup.claimInfo")}</DialogDescription>
      </DialogHeader>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field id="accidentDate" label={t("followup.accidentDate")} hint={claim ? undefined : t("followup.accidentHint")} error={fieldError(fields.accidentDate)}>
          <Input id="accidentDate" type="date" dir="ltr" value={accidentDate} disabled={Boolean(claim)} onChange={(e) => setAccidentDate(e.target.value)} />
        </Field>
        <Field id="claimNumber" label={`${t("followup.claimNumber")} ${t("common.optional")}`} error={fieldError(fields.claimNumber)}>
          <Input id="claimNumber" dir="ltr" value={claimNumber} onChange={(e) => setClaimNumber(e.target.value)} />
        </Field>
        <Field id="claimPlace" label={t("followup.place")} error={fieldError(fields.place)}>
          <Input id="claimPlace" dir="auto" value={place} onChange={(e) => setPlace(e.target.value)} />
        </Field>
        <Field id="claimRequested" label={`${t("followup.requested")} ${t("common.optional")}`} error={fieldError(fields.requestedCents)}>
          <MoneyInput id="claimRequested" cents={requested} onChange={setRequested} />
        </Field>
        {claim && (
          <>
            <Field id="claimCompensated" label={`${t("followup.compensated")} ${t("common.optional")}`} error={fieldError(fields.compensatedCents)}>
              <MoneyInput id="claimCompensated" cents={compensated} onChange={setCompensated} />
            </Field>
            <Field id="claimStatus" label={t("common.status")}>
              <NativeSelect id="claimStatus" value={status} onChange={(e) => setStatus(e.target.value as ClaimStatusCode)}>
                {CLAIM_STATUSES.map((s) => <option key={s} value={s}>{t(`followup.claimStatus.${s}`)}</option>)}
              </NativeSelect>
            </Field>
          </>
        )}
      </div>
      <Field id="claimDescription" label={`${t("followup.description")} ${t("common.optional")}`}>
        <Textarea id="claimDescription" dir="auto" value={description} onChange={(e) => setDescription(e.target.value)} />
      </Field>
      <Field id="claimNotes" label={`${t("followup.notes")} ${t("common.optional")}`}>
        <Textarea id="claimNotes" dir="auto" value={notes} onChange={(e) => setNotes(e.target.value)} />
      </Field>
      {reopening && (
        <Field id="claimReason" label={t("common.reason")} hint={t("followup.reopenHint")} error={fieldError(fields.reason)}>
          <Textarea id="claimReason" value={reason} onChange={(e) => setReason(e.target.value)} />
        </Field>
      )}
      {!claim && isManager && error?.code === "CLAIM_LATE_DECLARATION" && (
        <Field id="lateReason" label={t("followup.lateReason")} hint={t("followup.lateReasonHint")}>
          <Textarea id="lateReason" value={lateReason} onChange={(e) => setLateReason(e.target.value)} />
        </Field>
      )}
      {error && error.code !== "VALIDATION" && <ErrorMessage error={error} />}
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onClose}>{t("common.cancel")}</Button>
        <Button type="submit" disabled={run.isPending}>{t("common.save")}</Button>
      </DialogFooter>
    </form>
  );
}
