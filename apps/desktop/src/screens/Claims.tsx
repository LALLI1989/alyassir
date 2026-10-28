import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { CLAIM_STATUSES, type ClaimDto, type Page as PageOf, type PolicySummaryDto } from "@alyassir/shared";
import { Button, Card, CardContent, Dialog, DialogContent, DialogHeader, DialogTitle, Input, Label, NativeSelect } from "@alyassir/ui";
import { PageHeader, Pager } from "../components/common";
import { ClaimDialog, ClaimsTable } from "../components/followup";
import { Code, formatDay } from "../components/insurance";
import { api, useSession } from "../lib/session";
import type { Page } from "./Shell";

type StatusFilter = "open" | "all" | (typeof CLAIM_STATUSES)[number];

/** All claims (SPEC 18.1): search by number, client, policy or place; filter by status. */
export function Claims({ onOpen }: { onOpen: (page: Page) => void }) {
  const { t } = useTranslation();
  const { can } = useSession();
  const [q, setQ] = useState("");
  const [status, setStatus] = useState<StatusFilter>("open");
  const [page, setPage] = useState(1);
  const [editing, setEditing] = useState<ClaimDto | null>(null);
  const [creating, setCreating] = useState(false);
  const list = useQuery({
    queryKey: ["claims", "all", q, status, page],
    queryFn: () => api<PageOf<ClaimDto>>("GET", `/api/claims?q=${encodeURIComponent(q)}&status=${status}&page=${page}&pageSize=25`),
    placeholderData: keepPreviousData,
  });
  const data = list.data;
  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;
  return (
    <div className="grid gap-5">
      <PageHeader title={t("followup.claimsTitle")} intro={t("followup.claimsIntro")} actions={can("claims.create") && <Button onClick={() => setCreating(true)}>{t("followup.newClaim")}</Button>} />
      <div className="flex flex-wrap items-end gap-4">
        <Input className="max-w-md" placeholder={t("followup.claimsSearch")} aria-label={t("common.search")} value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} />
        <div className="grid gap-1">
          <Label htmlFor="claimFilter">{t("common.status")}</Label>
          <NativeSelect id="claimFilter" value={status} onChange={(e) => { setStatus(e.target.value as StatusFilter); setPage(1); }}>
            <option value="open">{t("followup.openClaims")}</option>
            <option value="all">{t("common.all")}</option>
            {CLAIM_STATUSES.map((s) => <option key={s} value={s}>{t(`followup.claimStatus.${s}`)}</option>)}
          </NativeSelect>
        </div>
      </div>
      <Card>
        <CardContent className="grid gap-3 pt-5">
          <ClaimsTable rows={data?.items ?? []} onEdit={setEditing} onOpenPolicy={(id) => onOpen({ kind: "policy", id })} />
          <Pager page={page} pages={pages} total={data?.total ?? 0} onPage={setPage} />
        </CardContent>
      </Card>
      <Dialog open={editing !== null} onOpenChange={(o) => !o && setEditing(null)}>
        <DialogContent closeLabel={t("common.close")} wide>{editing && <ClaimDialog claim={editing} policyId={editing.policyId} onClose={() => setEditing(null)} />}</DialogContent>
      </Dialog>
      <Dialog open={creating} onOpenChange={setCreating}>
        <DialogContent closeLabel={t("common.close")} wide>{creating && <NewClaim onClose={() => setCreating(false)} />}</DialogContent>
      </Dialog>
    </div>
  );
}

/** A new claim from the list: first find the policy, then the claim form. */
function NewClaim({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const [q, setQ] = useState("");
  const [policy, setPolicy] = useState<PolicySummaryDto | null>(null);
  const found = useQuery({
    queryKey: ["policies", "claimPick", q],
    queryFn: () => api<PageOf<PolicySummaryDto>>("GET", `/api/policies?q=${encodeURIComponent(q)}&pageSize=10`),
    enabled: q.trim().length > 1,
  });
  if (policy) return <ClaimDialog claim={null} policyId={policy.id} onClose={onClose} />;
  return (
    <div className="grid gap-3">
      <DialogHeader>
        <DialogTitle>{t("followup.pickPolicy")}</DialogTitle>
      </DialogHeader>
      <Input placeholder={t("policies.searchPlaceholder")} aria-label={t("followup.pickPolicy")} value={q} onChange={(e) => setQ(e.target.value)} />
      {found.data?.items.map((p) => (
        <button key={p.id} type="button" className="flex items-center justify-between rounded-md border p-2 text-start hover:bg-accent" onClick={() => setPolicy(p)}>
          <span className="grid">
            <Code>{p.policyNumber}</Code>
            <span className="text-xs text-muted-foreground" dir="auto">{p.clientName}</span>
          </span>
          <span className="text-xs">{`${formatDay(p.startDate)} → ${formatDay(p.endDate)}`}</span>
        </button>
      ))}
    </div>
  );
}
