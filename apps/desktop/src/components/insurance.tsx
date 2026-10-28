import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { formatCents, parseMoneyInput, type InsuranceCatalogDto, type ValidityStatus } from "@alyassir/shared";
import { Badge, Input } from "@alyassir/ui";
import { api } from "../lib/session";

/** "2026-10-27" -> "27/10/2026" (business dates have no time). */
export function formatDay(day: string | null | undefined): string {
  if (!day) return "";
  const [y, m, d] = day.split("-");
  return `${d}/${m}/${y}`;
}

/** An amount in cents, shown in dirhams. The screen never computes amounts (SPEC 4.2). */
export function Money({ cents, className }: { cents: number | null | undefined; className?: string }) {
  const { t } = useTranslation();
  if (cents === null || cents === undefined) return null;
  return (
    <bdi dir="ltr" className={className}>
      {formatCents(cents)} {t("money.mad")}
    </bdi>
  );
}

/** Text field for a MAD amount; gives integer cents (or null while the text is not an amount). */
export function MoneyInput({ id, cents, onChange, invalid }: { id: string; cents: number | null; onChange: (cents: number | null) => void; invalid?: boolean }) {
  const [text, setText] = useState(cents === null ? "" : formatCents(cents));
  useEffect(() => {
    // Follow a value set from outside (e.g. a default), without fighting the person typing.
    if (cents !== parseMoneyInput(text)) setText(cents === null ? "" : formatCents(cents));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cents]);
  return (
    <Input
      id={id}
      dir="ltr"
      inputMode="decimal"
      value={text}
      aria-invalid={invalid || (text !== "" && parseMoneyInput(text) === null) || undefined}
      onChange={(e) => {
        setText(e.target.value);
        onChange(parseMoneyInput(e.target.value));
      }}
    />
  );
}

const VALIDITY_VARIANT: Record<ValidityStatus, "success" | "secondary" | "destructive" | "warning"> = {
  active: "success",
  expired: "secondary",
  annulled: "destructive",
  cancelled: "warning",
};

export function ValidityBadge({ validity }: { validity: ValidityStatus }) {
  const { t } = useTranslation();
  return <Badge variant={VALIDITY_VARIANT[validity]}>{t(`policies.validities.${validity}`)}</Badge>;
}

export function useCatalog() {
  return useQuery({ queryKey: ["catalog"], queryFn: () => api<InsuranceCatalogDto>("GET", "/api/insurance/catalog") });
}

/** Name in the interface language (types and operations have both names). */
export function useLocalName(): (item: { nameAr: string; nameFr: string }) => string {
  const { i18n } = useTranslation();
  return (item) => (i18n.language === "fr" ? item.nameFr : item.nameAr);
}

/** One idempotency key per opened form: a double click or a retry is the same operation (SPEC 4.6). */
export function useOperationKey(): string {
  const [key] = useState(() => crypto.randomUUID());
  return key;
}

/** A plate or a document number always reads left to right. */
export function Code({ children }: { children: string | null | undefined }) {
  return (
    <bdi dir="ltr" className="font-mono text-sm">
      {children}
    </bdi>
  );
}
