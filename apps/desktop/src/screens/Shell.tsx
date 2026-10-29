import { useQuery } from "@tanstack/react-query";
import {
  Building2,
  Banknote,
  Car,
  ChartColumn,
  DatabaseBackup,
  History as HistoryIcon,
  Zap,
  HandCoins,
  Landmark,
  Lock,
  BellRing,
  Siren,
  Receipt,
  ClipboardList,
  Contact,
  FileText,
  ShieldCheck,
  Home as HomeIcon,
  KeyRound,
  LogOut,
  Mail,
  Moon,
  ScrollText,
  Server,
  Settings as SettingsIcon,
  Sun,
  UserCog,
  Users as UsersIcon,
} from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { MODULES, type AgencySettingsDto, type Module, type PermissionCode } from "@alyassir/shared";
import { Alert, Badge, Button, cn } from "@alyassir/ui";
import { DrawerBadge } from "../components/drawer";
import { api, useSession } from "../lib/session";
import { Account } from "./Account";
import { Audit } from "./Audit";
import { ClientFile } from "./ClientFile";
import { Clients } from "./Clients";
import { InsuranceSettings } from "./InsuranceSettings";
import { PolicyNew, Policies } from "./Policies";
import { PolicyPage } from "./PolicyPage";
import { Debts, Payments } from "./Payments";
import { Accounts } from "./Accounts";
import { Closing } from "./Closing";
import { Expenses } from "./Expenses";
import { Claims } from "./Claims";
import { Reminders, useReminders } from "./Reminders";
import { Vehicles } from "./Vehicles";
import { EditRequests } from "./EditRequests";
import { Home } from "./Home";
import { Messages } from "./Messages";
import { ServerStatusPage } from "./ServerSetup";
import { Settings } from "./Settings";
import { Backups } from "./Backups";
import { Historical } from "./Historical";
import { FirstStartQuestion, HistoricalBar, useHistorical, useOperationDay } from "../components/historical";
import { Reports } from "./Reports";
import { UsbBanner, UsbBlockPage, useUsb } from "../components/backups";
import { Users } from "./Users";

export type Page =
  | { kind: "home" }
  | { kind: "messages"; threadId?: string }
  | { kind: "editRequests" }
  | { kind: "users" }
  | { kind: "audit" }
  | { kind: "settings" }
  | { kind: "account" }
  | { kind: "server" }
  | { kind: "clients" }
  | { kind: "client"; id: string }
  | { kind: "vehicles" }
  | { kind: "policies" }
  | { kind: "policy"; id: string }
  | { kind: "policyNew"; clientId?: string }
  | { kind: "insurance" }
  | { kind: "payments" }
  | { kind: "debts" }
  | { kind: "expenses" }
  | { kind: "closing" }
  | { kind: "accounts" }
  | { kind: "claims" }
  | { kind: "reminders" }
  | { kind: "reports" }
  | { kind: "backups" }
  | { kind: "historical" }
  | { kind: "quickEntry" }
  | { kind: "module"; module: Module };

/** Modules that have their screens already (Phases 2 and 3); the others are announced. */
const BUILT: Partial<Record<Module, { page: Page; icon: ReactNode; pages: Page["kind"][] }>> = {
  clients: { page: { kind: "clients" }, icon: <Contact />, pages: ["clients", "client"] },
  vehicles: { page: { kind: "vehicles" }, icon: <Car />, pages: ["vehicles"] },
  policies: { page: { kind: "policies" }, icon: <FileText />, pages: ["policies", "policy", "policyNew"] },
  payments: { page: { kind: "payments" }, icon: <Banknote />, pages: ["payments"] },
  debts: { page: { kind: "debts" }, icon: <HandCoins />, pages: ["debts"] },
  expenses: { page: { kind: "expenses" }, icon: <Receipt />, pages: ["expenses"] },
  closing: { page: { kind: "closing" }, icon: <Lock />, pages: ["closing"] },
  claims: { page: { kind: "claims" }, icon: <Siren />, pages: ["claims"] },
  reports: { page: { kind: "reports" }, icon: <ChartColumn />, pages: ["reports"] },
};

const THEME_KEY = "alyassir.theme";

function useTheme(): [boolean, () => void] {
  const [dark, setDark] = useState(() => {
    try {
      return localStorage.getItem(THEME_KEY) === "dark";
    } catch {
      return false;
    }
  });
  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
    try {
      localStorage.setItem(THEME_KEY, dark ? "dark" : "light");
    } catch {
      // Theme still applies; it just is not remembered.
    }
  }, [dark]);
  return [dark, () => setDark((d) => !d)];
}

function NavItem({ active, icon, label, badge, onClick, disabled }: { active: boolean; icon: ReactNode; label: string; badge?: number; onClick: () => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? "page" : undefined}
      className={cn(
        "flex w-full items-center gap-2 rounded-md px-3 py-2 text-start text-sm transition-colors [&_svg]:size-4",
        active ? "bg-primary text-primary-foreground" : "hover:bg-accent",
        disabled && "opacity-60",
      )}
    >
      {icon}
      <span className="flex-1">{label}</span>
      {badge ? <Badge variant={active ? "secondary" : "default"}>{badge}</Badge> : null}
    </button>
  );
}

function ComingSoon({ title }: { title: string }) {
  const { t } = useTranslation();
  return (
    <div className="grid gap-3">
      <h1 className="text-xl font-bold">{title}</h1>
      <Alert>{t("common.comingSoonHint")}</Alert>
    </div>
  );
}

/** Main layout: side menu built from the user's permissions, header, current page. */
export function Shell() {
  const { t, i18n } = useTranslation();
  const { me, isManager, signOut, link, can } = useSession();
  const [page, setPage] = useState<Page>({ kind: "home" });
  const [dark, toggleTheme] = useTheme();
  const unread = useQuery({ queryKey: ["unread"], queryFn: () => api<{ count: number }>("GET", "/api/messages/unread-count") }).data?.count ?? 0;
  const reminders = useReminders().data?.total ?? 0;
  const usb = useUsb().data;
  const historical = useHistorical().data;
  const [operationDay, setOperationDay] = useOperationDay(historical);
  const settings = useQuery({ queryKey: ["settings"], queryFn: () => api<AgencySettingsDto>("GET", "/api/settings/agency") }).data;
  if (!me) return null;

  const agencyName = settings ? (i18n.language === "fr" ? settings.nameFr : settings.nameAr) : t("app.short");
  // "Financial dashboard" is a permission for the money cards of the home page, not a screen of its own.
  const visibleModules = MODULES.filter((m) => m !== "finance_dashboard" && can(`${m}.view` as PermissionCode));
  const roleBadge = isManager ? t("shell.managerBadge") : me.isSupervisor ? t("shell.supervisorBadge") : t("shell.employeeBadge");

  let content: ReactNode;
  switch (page.kind) {
    case "home":
      content = <Home onOpen={setPage} />;
      break;
    case "messages":
      content = <Messages initialThreadId={page.threadId} />;
      break;
    case "editRequests":
      content = <EditRequests onOpenThread={(threadId) => setPage({ kind: "messages", threadId })} />;
      break;
    case "users":
      content = isManager ? <Users /> : null;
      break;
    case "audit":
      content = isManager ? <Audit /> : null;
      break;
    case "settings":
      content = isManager ? <Settings /> : null;
      break;
    case "account":
      content = <Account />;
      break;
    case "server":
      content = <ServerStatusPage />;
      break;
    case "clients":
      content = <Clients onOpen={setPage} />;
      break;
    case "client":
      content = <ClientFile key={page.id} id={page.id} onOpen={setPage} />;
      break;
    case "vehicles":
      content = <Vehicles onOpen={setPage} />;
      break;
    case "policies":
      content = <Policies onOpen={setPage} />;
      break;
    case "policy":
      content = <PolicyPage key={page.id} id={page.id} onOpen={setPage} />;
      break;
    case "policyNew":
      content = <PolicyNew key={page.clientId ?? "new"} clientId={page.clientId} onOpen={setPage} />;
      break;
    case "insurance":
      content = isManager ? <InsuranceSettings /> : null;
      break;
    case "payments":
      content = <Payments onOpen={setPage} />;
      break;
    case "debts":
      content = <Debts onOpen={setPage} />;
      break;
    case "expenses":
      content = <Expenses />;
      break;
    case "closing":
      content = <Closing />;
      break;
    case "claims":
      content = <Claims onOpen={setPage} />;
      break;
    case "reminders":
      content = <Reminders onOpen={setPage} />;
      break;
    case "accounts":
      content = me.canSeeSafeAndBank ? <Accounts /> : null;
      break;
    case "reports":
      content = <Reports />;
      break;
    case "backups":
      content = <Backups />;
      break;
    case "historical":
      content = <Historical />;
      break;
    case "quickEntry":
      content = <PolicyNew key="quick" quick onOpen={setPage} />;
      break;
    case "module":
      content = <ComingSoon title={t(`modules.${page.module}`)} />;
      break;
  }

  const is = (kind: Page["kind"], module?: Module) => page.kind === kind && (!module || (page.kind === "module" && page.module === module));

  const askFirstStart = historical?.mode === "pending" && isManager;
  let mainContent: ReactNode = content;
  if (askFirstStart) mainContent = <FirstStartQuestion />;
  if (usb?.state === "block") mainContent = <UsbBlockPage state={usb} />;
  return (
    <div className="flex min-h-screen">
      <aside className="flex w-64 shrink-0 flex-col gap-4 border-e bg-card p-3">
        <div className="flex items-center gap-2 px-2 pt-2">
          <Building2 className="size-5 text-primary" />
          <span className="font-bold leading-tight">{agencyName}</span>
        </div>
        <nav className="grid gap-1" aria-label={t("shell.sectionWork")}>
          <NavItem active={is("home")} icon={<HomeIcon />} label={t("shell.home")} onClick={() => setPage({ kind: "home" })} />
          {isManager && historical?.mode === "open" && (
            <NavItem active={is("quickEntry")} icon={<Zap />} label={t("shell.quickEntry")} onClick={() => setPage({ kind: "quickEntry" })} />
          )}
          <NavItem active={is("reminders")} icon={<BellRing />} label={t("shell.reminders")} badge={reminders} onClick={() => setPage({ kind: "reminders" })} />
          <NavItem active={is("messages")} icon={<Mail />} label={t("shell.messages")} badge={unread} onClick={() => setPage({ kind: "messages" })} />
          <NavItem active={is("editRequests")} icon={<ClipboardList />} label={t("shell.editRequests")} onClick={() => setPage({ kind: "editRequests" })} />
          {visibleModules.map((m) => {
            const built = BUILT[m];
            return built ? (
              <NavItem key={m} active={built.pages.includes(page.kind)} icon={built.icon} label={t(`modules.${m}`)} onClick={() => setPage(built.page)} />
            ) : (
              <NavItem key={m} active={is("module", m)} icon={<span className="size-4" />} label={t(`modules.${m}`)} disabled onClick={() => setPage({ kind: "module", module: m })} />
            );
          })}
          {me.canSeeSafeAndBank && <NavItem active={is("accounts")} icon={<Landmark />} label={t("shell.accounts")} onClick={() => setPage({ kind: "accounts" })} />}
        </nav>
        {isManager && (
          <nav className="grid gap-1" aria-label={t("shell.sectionManage")}>
            <p className="px-3 text-xs font-semibold text-muted-foreground">{t("shell.sectionManage")}</p>
            <NavItem active={is("users")} icon={<UsersIcon />} label={t("shell.users")} onClick={() => setPage({ kind: "users" })} />
            <NavItem active={is("insurance")} icon={<ShieldCheck />} label={t("shell.insurance")} onClick={() => setPage({ kind: "insurance" })} />
            <NavItem active={is("audit")} icon={<ScrollText />} label={t("shell.audit")} onClick={() => setPage({ kind: "audit" })} />
            <NavItem active={is("backups")} icon={<DatabaseBackup />} label={t("shell.backups")} onClick={() => setPage({ kind: "backups" })} />
            <NavItem active={is("historical")} icon={<HistoryIcon />} label={t("shell.historical")} onClick={() => setPage({ kind: "historical" })} />
            <NavItem active={is("settings")} icon={<SettingsIcon />} label={t("shell.settings")} onClick={() => setPage({ kind: "settings" })} />
          </nav>
        )}
        <nav className="mt-auto grid gap-1" aria-label={t("shell.sectionMe")}>
          <NavItem active={is("account")} icon={<UserCog />} label={t("shell.account")} onClick={() => setPage({ kind: "account" })} />
          <NavItem active={is("server")} icon={<Server />} label={t("shell.server")} onClick={() => setPage({ kind: "server" })} />
        </nav>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center justify-between gap-3 border-b bg-card px-5 py-3">
          <div className="flex items-center gap-2 text-sm">
            <KeyRound className="size-4 text-muted-foreground" />
            <span className="font-medium" data-testid="current-user">{me.displayName}</span>
            <Badge variant="outline">{roleBadge}</Badge>
          </div>
          <div className="flex items-center gap-1">
            <DrawerBadge />
            <span className={cn("me-2 inline-flex items-center gap-1 text-xs", link === "connected" ? "text-success" : "text-warning")} role="status">
              <span className={cn("size-2 rounded-full", link === "connected" ? "bg-success" : "bg-warning")} />
              {link === "connected" ? t("status.connected") : t("status.reconnecting")}
            </span>
            <Button variant="ghost" size="sm" onClick={() => void i18n.changeLanguage(i18n.language === "ar" ? "fr" : "ar")}>
              {t("app.switchLanguage")}
            </Button>
            <Button variant="ghost" size="icon" onClick={toggleTheme} aria-label={dark ? t("theme.light") : t("theme.dark")}>
              {dark ? <Sun /> : <Moon />}
            </Button>
            <Button variant="outline" size="sm" onClick={() => void signOut()}>
              <LogOut />
              {t("shell.logout")}
            </Button>
          </div>
        </header>
        {historical && <HistoricalBar state={historical} day={operationDay} onDay={setOperationDay} />}
        {usb?.state === "remind" && <UsbBanner state={usb} />}
        <main className="flex-1 overflow-auto p-5">
          {mainContent}
        </main>
      </div>
    </div>
  );
}
