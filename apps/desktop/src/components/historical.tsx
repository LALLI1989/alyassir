import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { AGENCY_FIRST_DAY, type HistoricalStateDto } from "@alyassir/shared";
import { Button, Card, CardContent, CardHeader, CardTitle, Input, Label } from "@alyassir/ui";
import { asClientError, currentOperationDay, setOperationDay } from "../adapters";
import { ErrorMessage } from "../lib/errors";
import { api, useSession } from "../lib/session";
import { formatDay } from "./insurance";

const DAY_KEY = "alyassir.operationDay";

/** Historical entry mode (Phase 7): pending (question), open (old entries), locked (live work). */
export function useHistorical() {
  return useQuery({ queryKey: ["historical"], queryFn: () => api<HistoricalStateDto>("GET", "/api/historical"), staleTime: 30_000 });
}

function rememberedDay(): string {
  try {
    return localStorage.getItem(DAY_KEY) ?? AGENCY_FIRST_DAY;
  } catch {
    return AGENCY_FIRST_DAY;
  }
}

/**
 * The operation date of every request while the manager enters old work. Set during render so the
 * first requests already carry it; cleared for everyone else and after going live.
 */
export function useOperationDay(state: HistoricalStateDto | undefined): [string | null, (day: string) => void] {
  const { isManager } = useSession();
  const client = useQueryClient();
  const [day, setDay] = useState<string>(rememberedDay);
  const active = isManager && state?.mode === "open";
  const value = active ? day : null;
  if (currentOperationDay() !== value) setOperationDay(value);
  const change = (next: string) => {
    if (!next || next < AGENCY_FIRST_DAY || (state && next > state.today)) return;
    setDay(next);
    setOperationDay(next);
    try {
      localStorage.setItem(DAY_KEY, next);
    } catch {
      // Still used for this session.
    }
    void client.invalidateQueries();
  };
  return [value, change];
}

/** The yellow bar, always visible during the historical entry (SPEC 22). */
export function HistoricalBar({ state, day, onDay }: { state: HistoricalStateDto; day: string | null; onDay: (d: string) => void }) {
  const { t } = useTranslation();
  const { isManager } = useSession();
  // Locked: live work. Pending, for the manager: the first-start question fills the screen.
  if (state.mode === "locked" || (state.mode === "pending" && isManager)) return null;
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-b border-warning/40 bg-warning/20 px-5 py-2 text-sm" data-testid="historical-bar" role="status">
      <span className="font-medium">{day ? t("historical.barManager") : t("historical.barEmployee")}</span>
      {day && (
        <span className="flex items-center gap-2">
          <Label htmlFor="operationDay">{t("historical.operationDay")}</Label>
          <Input
            id="operationDay"
            type="date"
            dir="ltr"
            className="h-8 w-44 bg-background"
            min={state.firstDay}
            max={state.today}
            value={day}
            onChange={(e) => onDay(e.target.value)}
          />
          <span className="font-bold" data-testid="operation-day">{formatDay(day)}</span>
        </span>
      )}
    </div>
  );
}

/** First start (owner decision 28/10/2026): "Do you have old policies?" */
export function FirstStartQuestion() {
  const { t } = useTranslation();
  const client = useQueryClient();
  const answer = useMutation({
    mutationFn: (hasOldPolicies: boolean) => api<HistoricalStateDto>("POST", "/api/historical/answer", { hasOldPolicies }),
    onSuccess: (state) => {
      client.setQueryData(["historical"], state);
      void client.invalidateQueries();
    },
  });
  return (
    <div className="mx-auto grid max-w-2xl gap-4 py-8" data-testid="first-start">
      <Card>
        <CardHeader>
          <CardTitle>{t("historical.question")}</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4">
          <p className="text-sm">{t("historical.questionText")}</p>
          <div className="grid gap-2 sm:grid-cols-2">
            <Button onClick={() => answer.mutate(true)} disabled={answer.isPending}>{t("historical.yes")}</Button>
            <Button variant="outline" onClick={() => answer.mutate(false)} disabled={answer.isPending}>{t("historical.no")}</Button>
          </div>
          {answer.error && <ErrorMessage error={asClientError(answer.error)} />}
        </CardContent>
      </Card>
    </div>
  );
}
