import { QueryClientProvider } from "@tanstack/react-query";
import { DirectionProvider } from "@radix-ui/react-direction";
import { useTranslation } from "react-i18next";
import { queryClient, SessionProvider, useSession } from "./lib/session";
import { LanguageChoice } from "./screens/LanguageChoice";
import { Login } from "./screens/Login";
import { ServerGate } from "./screens/ServerSetup";
import { Shell } from "./screens/Shell";

function Main() {
  const { me } = useSession();
  if (!me) return <Login />;
  // First sign-in: the user chooses a language before anything else (SPEC 5).
  if (me.language === null) return <LanguageChoice />;
  return <Shell />;
}

export function App() {
  const { i18n } = useTranslation();
  return (
    <DirectionProvider dir={i18n.language === "ar" ? "rtl" : "ltr"}>
      <QueryClientProvider client={queryClient}>
        <ServerGate>
          <SessionProvider>
            <Main />
          </SessionProvider>
        </ServerGate>
      </QueryClientProvider>
    </DirectionProvider>
  );
}
