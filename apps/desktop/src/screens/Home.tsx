import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import type { EditRequestDto, Page as PageOf, PolicySummaryDto } from "@alyassir/shared";
import { Alert, Card, CardContent, CardHeader, CardTitle } from "@alyassir/ui";
import { api, useSession } from "../lib/session";
import type { Page } from "./Shell";

export function Home({ onOpen }: { onOpen: (page: Page) => void }) {
  const { t } = useTranslation();
  const { me, isManager, can } = useSession();
  const ending = useQuery({
    queryKey: ["policies", "endingSoon"],
    queryFn: () => api<PageOf<PolicySummaryDto>>("GET", "/api/policies?validity=active&endingWithinDays=30&pageSize=10"),
    enabled: can("policies.view"),
  }).data?.total;
  const unread = useQuery({ queryKey: ["unread"], queryFn: () => api<{ count: number }>("GET", "/api/messages/unread-count") }).data?.count ?? 0;
  const requests = useQuery({ queryKey: ["editRequests"], queryFn: () => api<EditRequestDto[]>("GET", "/api/edit-requests") }).data ?? [];
  const pending = requests.filter((r) => r.status === "pending").length;

  return (
    <div className="grid gap-5">
      <h1 className="text-xl font-bold">{t("home.welcome", { name: me?.displayName ?? "" })}</h1>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <button type="button" className="text-start" onClick={() => onOpen({ kind: "messages" })}>
          <Card className="transition-colors hover:bg-accent">
            <CardHeader>
              <CardTitle className="text-3xl">{unread}</CardTitle>
              <p className="text-sm text-muted-foreground">{t("home.unreadMessages")}</p>
            </CardHeader>
          </Card>
        </button>
        {can("policies.view") && (
          <button type="button" className="text-start" onClick={() => onOpen({ kind: "policies" })}>
            <Card className="transition-colors hover:bg-accent">
              <CardHeader>
                <CardTitle className="text-3xl">{ending ?? 0}</CardTitle>
                <p className="text-sm text-muted-foreground">{t("home.endingSoon")}</p>
              </CardHeader>
            </Card>
          </button>
        )}
        {isManager && (
          <button type="button" className="text-start" onClick={() => onOpen({ kind: "editRequests" })}>
            <Card className="transition-colors hover:bg-accent">
              <CardHeader>
                <CardTitle className="text-3xl">{pending}</CardTitle>
                <p className="text-sm text-muted-foreground">{t("home.pendingRequests")}</p>
              </CardHeader>
            </Card>
          </button>
        )}
      </div>
      <Card>
        <CardContent className="pt-5">
          <Alert>{t("home.phaseNote")}</Alert>
        </CardContent>
      </Card>
    </div>
  );
}
