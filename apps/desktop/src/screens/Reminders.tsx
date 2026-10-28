import { useQuery } from "@tanstack/react-query";
import { Phone } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { ReminderItemDto, RemindersDto } from "@alyassir/shared";
import { Alert, Badge, Button, Card, CardContent, CardHeader, CardTitle, Dialog, DialogContent, Table, TBody, Td, Th, THead, Tr } from "@alyassir/ui";
import { PageHeader } from "../components/common";
import { ContactDialog, WhatsappButton } from "../components/followup";
import { Code, Money, formatDay } from "../components/insurance";
import { api, useSession } from "../lib/session";
import { useListName } from "./Expenses";
import type { Page } from "./Shell";

export function useReminders() {
  return useQuery({ queryKey: ["reminders"], queryFn: () => api<RemindersDto>("GET", "/api/reminders"), refetchInterval: 5 * 60_000 });
}

/** Reminders (SPEC 18.2): what needs attention, each person according to their permissions. */
export function Reminders({ onOpen }: { onOpen: (page: Page) => void }) {
  const { t } = useTranslation();
  const reminders = useReminders();
  const r = reminders.data;
  return (
    <div className="grid gap-5">
      <PageHeader title={t("followup.remindersTitle")} intro={t("followup.remindersIntro")} />
      {r && r.total === 0 && <Alert variant="success">{t("followup.nothingToDo")}</Alert>}
      {r?.groups.map((g) => (
        <Card key={g.kind} data-testid={`reminders-${g.kind}`}>
          <CardHeader className="flex-row items-center gap-2 space-y-0">
            <CardTitle>{t(`followup.reminderKinds.${g.kind}`, { days: daysOf(g.kind, r) })}</CardTitle>
            <Badge>{g.count}</Badge>
          </CardHeader>
          <CardContent>
            <ReminderTable items={g.items} onOpen={onOpen} />
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

function daysOf(kind: string, r: RemindersDto): number {
  if (kind === "policy_ending") return r.settings.policyDays;
  if (kind === "instalment_due") return r.settings.instalmentDays;
  if (kind === "cheque_due") return r.settings.chequeDays;
  if (kind === "claim_stale") return r.settings.claimDays;
  return 0;
}

function ReminderTable({ items, onOpen }: { items: ReminderItemDto[]; onOpen: (page: Page) => void }) {
  const { t } = useTranslation();
  const { can } = useSession();
  const category = useListName("categories");
  const [contact, setContact] = useState<ReminderItemDto | null>(null);
  const kind = items[0]?.kind;
  const go = (i: ReminderItemDto) => {
    if (i.kind === "unread_messages") return onOpen({ kind: "messages" });
    if (i.kind === "edit_requests") return onOpen({ kind: "editRequests" });
    if (i.kind === "expense_pending") return onOpen({ kind: "expenses" });
    if (i.kind === "cheque_due" || i.kind === "in_collection") return onOpen({ kind: "payments" });
    if (i.kind === "claim_stale") return onOpen({ kind: "claims" });
    if (i.policyId) return onOpen({ kind: "policy", id: i.policyId });
    if (i.clientId) return onOpen({ kind: "client", id: i.clientId });
  };
  const detail = (i: ReminderItemDto): string => {
    if (!i.detail) return "";
    if (i.kind === "instalment_due") return t("finance.instalmentN", { n: i.detail });
    if (i.kind === "debt_open") return t(`finance.debtSources.${i.detail}`, { defaultValue: i.detail });
    if (i.kind === "in_collection") return t(`finance.methods.${i.detail}`, { defaultValue: i.detail });
    if (i.kind === "expense_pending") return category({ code: i.detail, name: i.detail });
    if (i.kind === "claim_stale") return t(`followup.claimStatus.${i.detail}`, { defaultValue: i.detail });
    if (i.kind === "unread_messages" || i.kind === "edit_requests") return t("followup.countN", { count: Number(i.detail) });
    return i.detail;
  };
  return (
    <>
      <Table>
        {kind !== "unread_messages" && kind !== "edit_requests" && (
          <THead>
            <Tr>
              <Th>{t("common.date")}</Th>
              <Th>{t("policies.client")}</Th>
              <Th>{t("policies.number")}</Th>
              <Th>{t("common.details")}</Th>
              <Th>{t("finance.amount")}</Th>
              <Th />
            </Tr>
          </THead>
        )}
        <TBody>
          {items.map((i) => (
            <Tr key={i.key}>
              {kind !== "unread_messages" && kind !== "edit_requests" && (
                <>
                  <Td>{formatDay(i.date)}</Td>
                  <Td>
                    <div className="grid">
                      <span dir="auto">{i.clientName}</span>
                      {i.phone && <bdi dir="ltr" className="text-xs text-muted-foreground">{i.phone}</bdi>}
                    </div>
                  </Td>
                  <Td>
                    <div className="grid">
                      <Code>{i.policyNumber}</Code>
                      {i.plate && <Code>{i.plate}</Code>}
                    </div>
                  </Td>
                </>
              )}
              <Td dir="auto">{detail(i)}</Td>
              {kind !== "unread_messages" && kind !== "edit_requests" && <Td><Money cents={i.amountCents} /></Td>}
              <Td>
                <div className="flex flex-wrap justify-end gap-1">
                  <Button size="sm" variant="outline" onClick={() => go(i)}>{t("common.open")}</Button>
                  {i.clientId && i.template && i.phone && <WhatsappButton clientId={i.clientId} policyId={i.policyId} template={i.template} />}
                  {i.clientId && i.template && can("clients.view") && (
                    <Button size="sm" variant="outline" onClick={() => setContact(i)}>
                      <Phone />
                      {t("followup.addContact")}
                    </Button>
                  )}
                </div>
              </Td>
            </Tr>
          ))}
        </TBody>
      </Table>
      <Dialog open={contact !== null} onOpenChange={(o) => !o && setContact(null)}>
        <DialogContent closeLabel={t("common.close")}>
          {contact?.clientId && <ContactDialog clientId={contact.clientId} policyId={contact.policyId} onClose={() => setContact(null)} />}
        </DialogContent>
      </Dialog>
    </>
  );
}
