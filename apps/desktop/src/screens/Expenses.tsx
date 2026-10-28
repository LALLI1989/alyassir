import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { ACCOUNT_CODES, type AccountCodeDto, type ExpenseDto, type ListItemDto, type Page as PageOf } from "@alyassir/shared";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
  NativeSelect,
  Table,
  TBody,
  Td,
  Textarea,
  Th,
  THead,
  Tr,
} from "@alyassir/ui";
import { asClientError } from "../adapters";
import { Field, PageHeader, Pager } from "../components/common";
import { Money, MoneyInput, useOperationKey } from "../components/insurance";
import { ErrorMessage, fieldsOf, useFieldError } from "../lib/errors";
import { formatDateTime } from "../lib/format";
import { api, useSession } from "../lib/session";

/** Default items carry a code translated here; items added by the manager one Latin name. */
export function useListName(list: "categories" | "reasons"): (item: { code: string | null; name: string | null }) => string {
  const { t } = useTranslation();
  return (item) => (item.code ? t(`cash.${list}.${item.code}`, { defaultValue: item.code }) : (item.name ?? ""));
}

export function useCategories() {
  return useQuery({ queryKey: ["expenseCategories"], queryFn: () => api<ListItemDto[]>("GET", "/api/expenses/categories") });
}

const STATUS_VARIANT = { pending: "warning", approved: "success", rejected: "destructive", cancelled: "outline" } as const;
type StatusFilter = "all" | ExpenseDto["status"];
type Acting = { expense: ExpenseDto; action: "approve" | "reject" | "edit" | "cancel" } | { expense: null; action: "add" };

/** Expenses (SPEC 17.2): added by employees from the drawer, approved or rejected by the manager. */
export function Expenses() {
  const { t } = useTranslation();
  const { can, isManager } = useSession();
  const listName = useListName("categories");
  const [status, setStatus] = useState<StatusFilter>(can("sup.approve_expenses") ? "pending" : "all");
  const [page, setPage] = useState(1);
  const [acting, setActing] = useState<Acting | null>(null);
  const list = useQuery({
    queryKey: ["expenses", status, page],
    queryFn: () => api<PageOf<ExpenseDto>>("GET", `/api/expenses?status=${status}&page=${page}&pageSize=25`),
    placeholderData: keepPreviousData,
  });
  const data = list.data;
  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;
  return (
    <div className="grid gap-5">
      <PageHeader
        title={t("cash.expensesTitle")}
        intro={t("cash.expensesIntro")}
        actions={can("expenses.create") && <Button onClick={() => setActing({ expense: null, action: "add" })}>{t("cash.addExpense")}</Button>}
      />
      <div className="grid max-w-xs gap-1">
        <Label htmlFor="expenseStatus">{t("common.status")}</Label>
        <NativeSelect id="expenseStatus" value={status} onChange={(e) => { setStatus(e.target.value as StatusFilter); setPage(1); }}>
          <option value="all">{t("common.all")}</option>
          {(["pending", "approved", "rejected", "cancelled"] as const).map((x) => <option key={x} value={x}>{t(`cash.expenseStatus.${x}`)}</option>)}
        </NativeSelect>
      </div>
      <Card>
        <CardContent className="grid gap-3 pt-5">
          <Table data-testid="expenses">
            <THead>
              <Tr>
                <Th>{t("common.date")}</Th>
                <Th>{t("cash.category")}</Th>
                <Th>{t("finance.amount")}</Th>
                <Th>{t("cash.by")}</Th>
                <Th>{t("common.status")}</Th>
                <Th />
              </Tr>
            </THead>
            <TBody>
              {data?.items.length === 0 && (
                <Tr>
                  <Td colSpan={6} className="py-8 text-center text-muted-foreground">{t("common.empty")}</Td>
                </Tr>
              )}
              {data?.items.map((e) => (
                <Tr key={e.id}>
                  <Td>{formatDateTime(e.createdAt)}</Td>
                  <Td>
                    <div className="grid">
                      <span>{listName(e.category)}</span>
                      {e.note && <span className="text-xs text-muted-foreground" dir="auto">{e.note}</span>}
                    </div>
                  </Td>
                  <Td><Money cents={e.amountCents} /></Td>
                  <Td>{e.createdByName}</Td>
                  <Td>
                    <div className="grid gap-0.5">
                      <Badge variant={STATUS_VARIANT[e.status]} className="w-fit">{t(`cash.expenseStatus.${e.status}`)}</Badge>
                      {e.account && e.status === "approved" && <span className="text-xs text-muted-foreground">{t(`finance.accounts.${e.account}`)}</span>}
                      {(e.rejectReason || e.cancelReason) && <span className="text-xs text-destructive" dir="auto">{e.rejectReason ?? e.cancelReason}</span>}
                    </div>
                  </Td>
                  <Td>
                    <div className="flex justify-end gap-1">
                      {e.status === "pending" && can("sup.approve_expenses") && <Button size="sm" onClick={() => setActing({ expense: e, action: "approve" })}>{t("cash.approve")}</Button>}
                      {e.status === "pending" && can("sup.approve_expenses") && <Button size="sm" variant="destructive" onClick={() => setActing({ expense: e, action: "reject" })}>{t("cash.reject")}</Button>}
                      {e.status === "pending" && isManager && <Button size="sm" variant="outline" onClick={() => setActing({ expense: e, action: "edit" })}>{t("common.edit")}</Button>}
                      {(e.status === "pending" || e.status === "approved") && isManager && <Button size="sm" variant="outline" onClick={() => setActing({ expense: e, action: "cancel" })}>{t("cash.cancelExpense")}</Button>}
                    </div>
                  </Td>
                </Tr>
              ))}
            </TBody>
          </Table>
          <Pager page={page} pages={pages} total={data?.total ?? 0} onPage={setPage} />
        </CardContent>
      </Card>
      {isManager && <ListSettings kind="categories" />}
      <Dialog open={acting !== null} onOpenChange={(o) => !o && setActing(null)}>
        <DialogContent closeLabel={t("common.close")}>{acting && <ExpenseDialog acting={acting} onClose={() => setActing(null)} />}</DialogContent>
      </Dialog>
    </div>
  );
}

function ExpenseDialog({ acting, onClose }: { acting: Acting; onClose: () => void }) {
  const { t } = useTranslation();
  const fieldError = useFieldError();
  const queries = useQueryClient();
  const { me } = useSession();
  const key = useOperationKey();
  const listName = useListName("categories");
  const categories = (useCategories().data ?? []).filter((c) => !c.archived || c.id === acting.expense?.category.id);
  const e = acting.expense;
  const [categoryId, setCategoryId] = useState(e?.category.id ?? "");
  const [amount, setAmount] = useState<number | null>(e?.amountCents ?? null);
  const [note, setNote] = useState(e?.note ?? "");
  const [reason, setReason] = useState("");
  const [account, setAccount] = useState<AccountCodeDto>("drawer");
  const accounts = me?.canSeeSafeAndBank ? ACCOUNT_CODES : (["drawer"] as const);
  const run = useMutation({
    mutationFn: () => {
      if (acting.action === "add") return api<ExpenseDto>("POST", "/api/expenses", { idempotencyKey: key, categoryId, amountCents: amount, note });
      const ex = acting.expense;
      if (acting.action === "edit") return api<ExpenseDto>("PATCH", `/api/expenses/${ex.id}`, { version: ex.version, categoryId, amountCents: amount, note });
      if (acting.action === "approve") return api<ExpenseDto>("POST", `/api/expenses/${ex.id}/approve`, { version: ex.version, account });
      return api<ExpenseDto>("POST", `/api/expenses/${ex.id}/${acting.action}`, { version: ex.version, reason });
    },
    onSuccess: async () => {
      await Promise.all(["expenses", "drawer", "accounts", "movements"].map((k) => queries.invalidateQueries({ queryKey: [k] })));
      onClose();
    },
  });
  const error = run.error ? asClientError(run.error) : null;
  const fields = fieldsOf(error);
  const form = acting.action === "add" || acting.action === "edit";
  return (
    <form onSubmit={(ev: FormEvent) => { ev.preventDefault(); run.mutate(); }} className="grid gap-4">
      <DialogHeader>
        <DialogTitle>{t(`cash.dialog.${acting.action}`)}</DialogTitle>
        <DialogDescription>{t(`cash.dialogInfo.${acting.action}`)}</DialogDescription>
      </DialogHeader>
      {e && !form && (
        <dl className="grid gap-2 rounded-md border p-3 text-sm">
          <div className="flex justify-between gap-3"><dt className="text-muted-foreground">{t("cash.category")}</dt><dd>{listName(e.category)}</dd></div>
          <div className="flex justify-between gap-3"><dt className="text-muted-foreground">{t("finance.amount")}</dt><dd className="font-semibold"><Money cents={e.amountCents} /></dd></div>
          <div className="flex justify-between gap-3"><dt className="text-muted-foreground">{t("cash.by")}</dt><dd>{e.createdByName}</dd></div>
        </dl>
      )}
      {form && (
        <>
          <Field id="expenseCategory" label={t("cash.category")} error={fieldError(fields.categoryId)}>
            <NativeSelect id="expenseCategory" value={categoryId} onChange={(ev) => setCategoryId(ev.target.value)}>
              <option value="" />
              {categories.map((c) => <option key={c.id} value={c.id}>{listName(c)}</option>)}
            </NativeSelect>
          </Field>
          <Field id="expenseAmount" label={t("finance.amount")} error={fieldError(fields.amountCents)}>
            <MoneyInput id="expenseAmount" cents={amount} onChange={setAmount} />
          </Field>
          <Field id="expenseNote" label={`${t("cash.note")} ${t("common.optional")}`}>
            <Input id="expenseNote" dir="auto" value={note} onChange={(ev) => setNote(ev.target.value)} />
          </Field>
        </>
      )}
      {acting.action === "approve" && (
        <Field id="expenseAccount" label={t("cash.payFrom")}>
          <NativeSelect id="expenseAccount" value={account} onChange={(ev) => setAccount(ev.target.value as AccountCodeDto)}>
            {accounts.map((a) => <option key={a} value={a}>{t(`finance.accounts.${a}`)}</option>)}
          </NativeSelect>
        </Field>
      )}
      {(acting.action === "reject" || acting.action === "cancel") && (
        <Field id="expenseReason" label={t("common.reason")} error={fieldError(fields.reason)}>
          <Textarea id="expenseReason" value={reason} onChange={(ev) => setReason(ev.target.value)} />
        </Field>
      )}
      {error && error.code !== "VALIDATION" && <ErrorMessage error={error} />}
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onClose}>{t("common.cancel")}</Button>
        <Button type="submit" variant={acting.action === "reject" || acting.action === "cancel" ? "destructive" : "default"} disabled={run.isPending}>{t("common.confirm")}</Button>
      </DialogFooter>
    </form>
  );
}

/** The manager adds categories (or withdrawal reasons) and archives the ones no longer used. */
export function ListSettings({ kind }: { kind: "categories" | "reasons" }) {
  const { t } = useTranslation();
  const fieldError = useFieldError();
  const queries = useQueryClient();
  const listName = useListName(kind);
  const path = kind === "categories" ? "/api/expenses/categories" : "/api/accounts/withdrawal-reasons";
  const queryKey = [kind === "categories" ? "expenseCategories" : "withdrawalReasons"];
  const items = useQuery({ queryKey, queryFn: () => api<ListItemDto[]>("GET", path) });
  const [name, setName] = useState("");
  const add = useMutation({
    mutationFn: () => api<ListItemDto[]>("POST", path, { name }),
    onSuccess: (list) => {
      queries.setQueryData(queryKey, list);
      setName("");
    },
  });
  const archive = useMutation({
    mutationFn: (item: ListItemDto) => api<ListItemDto[]>("POST", `${path}/${item.id}/archive`, { version: item.version, archived: !item.archived }),
    onSuccess: (list) => queries.setQueryData(queryKey, list),
  });
  const error = add.error ? asClientError(add.error) : archive.error ? asClientError(archive.error) : null;
  const fields = fieldsOf(error);
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t(`cash.${kind}Title`)}</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-3">
        <div className="flex flex-wrap gap-2">
          {(items.data ?? []).map((i) => (
            <span key={i.id} className="inline-flex items-center gap-1 rounded-md border px-2 py-1 text-sm">
              <span className={i.archived ? "text-muted-foreground line-through" : ""}>{listName(i)}</span>
              {!i.code && (
                <Button type="button" size="sm" variant="ghost" className="h-6 px-1 text-xs" onClick={() => archive.mutate(i)}>
                  {i.archived ? t("common.restore") : t("common.archive")}
                </Button>
              )}
            </span>
          ))}
        </div>
        <form onSubmit={(e) => { e.preventDefault(); add.mutate(); }} className="flex flex-wrap items-end gap-2">
          <Field id={`new-${kind}`} label={t(`cash.${kind}New`)} hint={t("common.latinHint")} error={fieldError(fields.name)}>
            <Input id={`new-${kind}`} dir="ltr" value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Button type="submit" variant="outline" disabled={add.isPending || !name.trim()}>{t("common.add")}</Button>
        </form>
        {error && error.code !== "VALIDATION" && <ErrorMessage error={error} />}
      </CardContent>
    </Card>
  );
}
