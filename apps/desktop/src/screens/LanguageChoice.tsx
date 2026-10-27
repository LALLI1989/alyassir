import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import type { Language } from "@alyassir/shared";
import { Button, Card, CardContent, CardDescription, CardHeader, CardTitle } from "@alyassir/ui";
import { asClientError } from "../adapters";
import { ErrorMessage } from "../lib/errors";
import i18n from "../lib/i18n";
import { api } from "../lib/session";

/** First sign-in: each user chooses their language once (SPEC 5). */
export function LanguageChoice() {
  const { t } = useTranslation();
  const client = useQueryClient();
  const choose = useMutation({
    mutationFn: (language: Language) => api<void>("PUT", "/api/me/language", { language }),
    onSuccess: async (_d, language) => {
      await i18n.changeLanguage(language);
      await client.invalidateQueries({ queryKey: ["me"] });
    },
  });
  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>{t("language.title")}</CardTitle>
          <CardDescription>{t("language.intro")}</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3">
          <div className="grid grid-cols-2 gap-3">
            <Button size="lg" disabled={choose.isPending} onClick={() => choose.mutate("ar")} lang="ar">
              {t("language.ar")}
            </Button>
            <Button size="lg" variant="outline" disabled={choose.isPending} onClick={() => choose.mutate("fr")} lang="fr">
              {t("language.fr")}
            </Button>
          </div>
          <ErrorMessage error={choose.error ? asClientError(choose.error) : null} />
        </CardContent>
      </Card>
    </div>
  );
}
