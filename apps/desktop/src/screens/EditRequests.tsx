import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { EditRequestDto } from "@alyassir/shared";
import { Badge, Button, Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, Textarea } from "@alyassir/ui";
import { asClientError } from "../adapters";
import { DataTable, Field, PageHeader } from "../components/common";
import { ErrorMessage, fieldsOf, useFieldError } from "../lib/errors";
import { formatDateTime } from "../lib/format";
import { api, useSession } from "../lib/session";

const STATUS_VARIANT = { pending: "warning", approved: "success", rejected: "destructive", used: "secondary", expired: "outline" } as const;

function DecideDialog({ request, approve, onClose }: { request: EditRequestDto; approve: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const fieldError = useFieldError();
  const client = useQueryClient();
  const [reason, setReason] = useState("");
  const decide = useMutation({
    mutationFn: () => api<EditRequestDto>("POST", `/api/edit-requests/${request.id}/${approve ? "approve" : "reject"}`, { reason }),
    onSettled: () => client.invalidateQueries({ queryKey: ["editRequests"] }),
    onSuccess: onClose,
  });
  const error = decide.error ? asClientError(decide.error) : null;
  return (
    <form onSubmit={(e) => { e.preventDefault(); decide.mutate(); }} className="grid gap-4">
      <DialogHeader>
        <DialogTitle>{t("editRequests.decideTitle", { name: request.requesterName })}</DialogTitle>
      </DialogHeader>
      <p className="whitespace-pre-wrap rounded-md bg-muted p-3 text-sm">{request.note}</p>
      <Field id="reason" label={t("editRequests.decisionReason")} error={fieldError(fieldsOf(error).reason)}>
        <Textarea id="reason" value={reason} onChange={(e) => setReason(e.target.value)} />
      </Field>
      {error && error.code !== "VALIDATION" && <ErrorMessage error={error} />}
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onClose}>{t("common.cancel")}</Button>
        <Button type="submit" variant={approve ? "default" : "destructive"} disabled={decide.isPending}>
          {approve ? t("editRequests.approve") : t("editRequests.reject")}
        </Button>
      </DialogFooter>
    </form>
  );
}

export function EditRequests({ onOpenThread }: { onOpenThread: (threadId: string) => void }) {
  const { t } = useTranslation();
  const { isManager } = useSession();
  const [deciding, setDeciding] = useState<{ request: EditRequestDto; approve: boolean } | null>(null);
  const requests = useQuery({ queryKey: ["editRequests"], queryFn: () => api<EditRequestDto[]>("GET", "/api/edit-requests") });

  return (
    <div>
      <PageHeader title={t("editRequests.title")} intro={t("editRequests.intro")} />
      <DataTable
        rows={requests.data ?? []}
        rowKey={(r) => r.id}
        empty={t("editRequests.empty")}
        columns={[
          { key: "date", header: t("common.date"), value: (r) => r.createdAt, cell: (r) => formatDateTime(r.createdAt) },
          ...(isManager ? [{ key: "requester", header: t("editRequests.requester"), value: (r: EditRequestDto) => r.requesterName, cell: (r: EditRequestDto) => r.requesterName }] : []),
          { key: "record", header: t("editRequests.record"), value: (r) => r.entityType, cell: (r) => t(`editRequests.entities.${r.entityType}`, { defaultValue: r.entityType }) },
          { key: "operation", header: t("editRequests.operation"), value: (r) => r.operation, cell: (r) => <bdi dir="ltr">{r.operation}</bdi> },
          { key: "note", header: t("editRequests.note"), value: (r) => r.note, cell: (r) => <span className="line-clamp-2">{r.note}</span> },
          {
            key: "status",
            header: t("editRequests.status"),
            value: (r) => r.status,
            cell: (r) => (
              <div className="grid gap-1">
                <Badge variant={STATUS_VARIANT[r.status]}>{t(`editRequests.statuses.${r.status}`)}</Badge>
                {r.decisionReason && <span className="text-xs text-muted-foreground">{r.decisionReason}</span>}
                {r.status === "approved" && r.expiresAt && <span className="text-xs">{t("editRequests.expiresAt", { time: formatDateTime(r.expiresAt) })}</span>}
                {r.status === "used" && r.usedAt && <span className="text-xs">{t("editRequests.usedAt", { time: formatDateTime(r.usedAt) })}</span>}
              </div>
            ),
          },
          {
            key: "actions",
            header: t("common.actions"),
            cell: (r) => (
              <div className="flex flex-wrap gap-1">
                {isManager && r.status === "pending" && (
                  <>
                    <Button size="sm" onClick={() => setDeciding({ request: r, approve: true })}>{t("editRequests.approve")}</Button>
                    <Button size="sm" variant="destructive" onClick={() => setDeciding({ request: r, approve: false })}>{t("editRequests.reject")}</Button>
                  </>
                )}
                {r.threadId && <Button size="sm" variant="outline" onClick={() => onOpenThread(r.threadId as string)}>{t("shell.messages")}</Button>}
              </div>
            ),
          },
        ]}
      />
      <Dialog open={deciding !== null} onOpenChange={(open) => !open && setDeciding(null)}>
        <DialogContent closeLabel={t("common.close")}>
          {deciding && <DecideDialog request={deciding.request} approve={deciding.approve} onClose={() => setDeciding(null)} />}
        </DialogContent>
      </Dialog>
    </div>
  );
}
