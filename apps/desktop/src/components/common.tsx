import { ArrowDown, ArrowUp } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Button, Input, Label, Table, TBody, Td, Th, THead, Tr, cn } from "@alyassir/ui";

/** "AB:CD:..." in 4 short lines, easy to compare by eye. Hex always reads left to right. */
export function Fingerprint({ value }: { value: string }) {
  const parts = value.split(":");
  const lines = [0, 8, 16, 24].map((i) => parts.slice(i, i + 8).join(":"));
  return (
    <code dir="ltr" className="flex flex-col gap-0.5 rounded-md bg-muted p-3 text-start font-mono text-sm">
      {lines.map((line) => (
        <span key={line}>{line}</span>
      ))}
    </code>
  );
}

export function PageHeader({ title, intro, actions }: { title: string; intro?: string; actions?: ReactNode }) {
  return (
    <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
      <div className="max-w-3xl">
        <h1 className="text-xl font-bold">{title}</h1>
        {intro && <p className="mt-1 text-sm text-muted-foreground">{intro}</p>}
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </div>
  );
}

/** Label + control + hint + error, with the right ARIA links. */
export function Field({ id, label, hint, error, children }: { id: string; label: string; hint?: string; error?: string; children: ReactNode }) {
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      {children}
      {hint && !error && <p className="text-xs text-muted-foreground">{hint}</p>}
      {error && (
        <p id={`${id}-error`} className="text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}

export interface Column<T> {
  key: string;
  header: string;
  cell: (row: T) => ReactNode;
  /** Value used for searching and sorting. */
  value?: (row: T) => string | number;
  className?: string;
}

/** Table with search, sort and pages (SPEC 3.1), on data already loaded. */
export function DataTable<T>({ rows, columns, rowKey, pageSize = 20, searchable = true, empty }: {
  rows: T[];
  columns: Column<T>[];
  rowKey: (row: T) => string;
  pageSize?: number;
  searchable?: boolean;
  empty?: string;
}) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<{ key: string; dir: 1 | -1 } | null>(null);
  const [page, setPage] = useState(1);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    let list = q
      ? rows.filter((r) => columns.some((c) => c.value && String(c.value(r)).toLowerCase().includes(q)))
      : rows;
    if (sort) {
      const col = columns.find((c) => c.key === sort.key);
      if (col?.value) {
        const get = col.value;
        list = [...list].sort((a, b) => {
          const va = get(a);
          const vb = get(b);
          return (typeof va === "number" && typeof vb === "number" ? va - vb : String(va).localeCompare(String(vb))) * sort.dir;
        });
      }
    }
    return list;
  }, [rows, columns, query, sort]);

  const pages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const current = Math.min(page, pages);
  const visible = filtered.slice((current - 1) * pageSize, current * pageSize);

  return (
    <div className="grid gap-3">
      {searchable && (
        <Input
          className="max-w-xs"
          placeholder={t("common.searchPlaceholder")}
          aria-label={t("common.search")}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setPage(1);
          }}
        />
      )}
      <div className="rounded-lg border bg-card">
        <Table>
          <THead>
            <Tr>
              {columns.map((c) => (
                <Th key={c.key} className={c.className}>
                  {c.value ? (
                    <button
                      type="button"
                      className="inline-flex items-center gap-1"
                      onClick={() => setSort((s) => (s?.key === c.key ? { key: c.key, dir: s.dir === 1 ? -1 : 1 } : { key: c.key, dir: 1 }))}
                    >
                      {c.header}
                      {sort?.key === c.key && (sort.dir === 1 ? <ArrowUp className="size-3" aria-label={t("common.sortAsc")} /> : <ArrowDown className="size-3" aria-label={t("common.sortDesc")} />)}
                    </button>
                  ) : (
                    c.header
                  )}
                </Th>
              ))}
            </Tr>
          </THead>
          <TBody>
            {visible.length === 0 ? (
              <Tr>
                <Td colSpan={columns.length} className="py-8 text-center text-muted-foreground">
                  {empty ?? t("common.empty")}
                </Td>
              </Tr>
            ) : (
              visible.map((row) => (
                <Tr key={rowKey(row)}>
                  {columns.map((c) => (
                    <Td key={c.key} className={c.className}>
                      {c.cell(row)}
                    </Td>
                  ))}
                </Tr>
              ))
            )}
          </TBody>
        </Table>
      </div>
      <Pager page={current} pages={pages} total={filtered.length} onPage={setPage} />
    </div>
  );
}

export function Pager({ page, pages, total, onPage }: { page: number; pages: number; total: number; onPage: (p: number) => void }) {
  const { t } = useTranslation();
  return (
    <div className={cn("flex items-center justify-between gap-2 text-sm text-muted-foreground")}>
      <span>{t("common.rows", { count: total })}</span>
      <div className="flex items-center gap-2">
        <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => onPage(page - 1)}>
          {t("common.previous")}
        </Button>
        <span>{t("common.page", { page, pages })}</span>
        <Button variant="outline" size="sm" disabled={page >= pages} onClick={() => onPage(page + 1)}>
          {t("common.next")}
        </Button>
      </div>
    </div>
  );
}
