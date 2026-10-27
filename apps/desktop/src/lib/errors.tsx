import { useTranslation } from "react-i18next";
import { Alert } from "@alyassir/ui";
import type { ClientError } from "../adapters";
import { formatDateTime } from "./format";

/** Error text in the user's language, plus a support code (SPEC 5). */
export function ErrorMessage({ error }: { error: ClientError | null | undefined }) {
  const { t } = useTranslation();
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
