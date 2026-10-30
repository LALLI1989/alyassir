import { QueryClient, useQuery, useQueryClient } from "@tanstack/react-query";
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { ChangeTopic, MeDto, PermissionCode } from "@alyassir/shared";
import { adapter, lastUserInput, noteUserInput, type LinkState, type LoginResult, type RequestOptions } from "../adapters";
import i18n from "./i18n";

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 1, staleTime: 10_000, refetchOnWindowFocus: false },
    mutations: { retry: false },
  },
});

/** Which cached queries each realtime topic refreshes. */
const TOPIC_KEYS: Record<ChangeTopic, string[]> = {
  users: ["users", "directory"],
  me: ["me"],
  settings: ["settings", "historical", "historicalChecklist"],
  messages: ["threads", "thread", "unread"],
  edit_requests: ["editRequests"],
  audit: ["audit"],
  insurance: ["catalog"],
  clients: ["clients", "client"],
  vehicles: ["vehicles", "vehicle", "client"],
  policies: ["policies", "policy", "client", "finance"],
  // Phase 8B: money changes also refresh the historical checklist (negative days in the yellow bar).
  payments: ["payments", "debts", "finance", "policies", "policy", "drawer", "reminders", "historicalChecklist"],
  drawer: ["drawer", "closings", "days", "accounts", "movements", "historicalChecklist"],
  expenses: ["expenses", "drawer", "accounts", "movements", "expenseCategories", "historicalChecklist"],
  accounts: ["accounts", "movements", "drawer", "withdrawalReasons", "historicalChecklist"],
  claims: ["claims", "reminders"],
  contacts: ["contacts", "reminders"],
  backups: ["backups", "usb", "dashboard"],
};

export function api<T>(method: string, path: string, body?: unknown, options?: RequestOptions): Promise<T> {
  return adapter.request<T>(method, path, body, options);
}

interface SessionValue {
  me: MeDto | null;
  serverVersion: string | null;
  link: LinkState;
  endedCode: string | null;
  signIn: (result: LoginResult) => void;
  signOut: () => Promise<void>;
  can: (code: PermissionCode) => boolean;
  isManager: boolean;
}

const SessionContext = createContext<SessionValue | null>(null);

export function useSession(): SessionValue {
  const value = useContext(SessionContext);
  if (!value) throw new Error("useSession outside SessionProvider");
  return value;
}

function applyUserLanguage(me: MeDto | null): void {
  if (me?.language && i18n.language !== me.language) void i18n.changeLanguage(me.language);
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const [initial, setInitial] = useState<LoginResult | null>(null);
  const [link, setLink] = useState<LinkState>("disconnected");
  const [endedCode, setEndedCode] = useState<string | null>(null);
  const client = useQueryClient();

  const meQuery = useQuery({
    queryKey: ["me"],
    queryFn: () => api<MeDto>("GET", "/api/me"),
    enabled: initial !== null,
    initialData: initial?.me,
  });
  const me = initial ? (meQuery.data ?? initial.me) : null;

  useEffect(() => applyUserLanguage(me), [me]);

  // Keyboard and mouse use is what keeps a session alive (not background refreshes).
  useEffect(() => {
    const events = ["keydown", "mousedown", "wheel", "touchstart"] as const;
    events.forEach((e) => window.addEventListener(e, noteUserInput, { passive: true }));
    return () => events.forEach((e) => window.removeEventListener(e, noteUserInput));
  }, []);

  useEffect(() => {
    const stopChange = adapter.onChange((topic) => {
      for (const key of TOPIC_KEYS[topic] ?? []) void client.invalidateQueries({ queryKey: [key] });
    });
    const stopLink = adapter.onLink((state) => {
      setLink(state);
      // Back after a cut: refetch everything shown, nothing may be stale (SPEC 3.2).
      if (state === "connected") void client.invalidateQueries();
    });
    const stopEnded = adapter.onSessionEnded((code) => {
      setInitial(null);
      setEndedCode(code);
      client.clear();
    });
    return () => {
      stopChange();
      stopLink();
      stopEnded();
    };
  }, [client]);

  const signOut = useCallback(async () => {
    await adapter.logout();
    setInitial(null);
    setEndedCode(null);
    client.clear();
  }, [client]);

  // The app also signs out by itself after the idle time, even if no request is made.
  const idleMinutes = useQuery({
    queryKey: ["settings"],
    queryFn: () => api<{ idleTimeoutMinutes: number }>("GET", "/api/settings/agency"),
    enabled: initial !== null,
  }).data?.idleTimeoutMinutes;
  useEffect(() => {
    if (!initial || !idleMinutes) return;
    const timer = setInterval(() => {
      if (Date.now() - lastUserInput() > idleMinutes * 60_000) {
        void adapter.logout().finally(() => {
          setInitial(null);
          setEndedCode("SESSION_EXPIRED");
          client.clear();
        });
      }
    }, 15_000);
    return () => clearInterval(timer);
  }, [initial, idleMinutes, client]);

  const value = useMemo<SessionValue>(
    () => ({
      me,
      serverVersion: initial?.serverVersion ?? null,
      link,
      endedCode,
      signIn: (result) => {
        noteUserInput();
        setEndedCode(null);
        client.clear();
        setInitial(result);
        applyUserLanguage(result.me);
      },
      signOut,
      can: (code) => me?.permissions.includes(code) ?? false,
      isManager: me?.role === "manager",
    }),
    [me, initial, link, endedCode, signOut, client],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}
