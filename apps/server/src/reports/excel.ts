/**
 * A report as an Excel file (ExcelJS, SPEC 3 and 19): title, filters, translated headers, rows and
 * totals. Arabic sheets read from right to left. Amounts are written in dirhams with 2 decimals
 * (cents / 100 is exact for display) and stay numbers, so the owner can add them up in Excel.
 */
import ExcelJS from "exceljs";
import type { ReportDto } from "@alyassir/shared";
import { tr, type Lang } from "./texts";

export async function toExcel(report: ReportDto, lang: Lang): Promise<Buffer> {
  const book = new ExcelJS.Workbook();
  book.creator = "Alyassir";
  book.created = new Date(report.generatedAt);
  const sheet = book.addWorksheet(report.code, { views: [{ rightToLeft: lang === "ar", state: "frozen", ySplit: 4 }] });
  const width = Math.max(1, report.columns.length);

  sheet.addRow([report.title]).font = { bold: true, size: 14 };
  sheet.mergeCells(1, 1, 1, width);
  sheet.addRow([report.subtitle]);
  sheet.mergeCells(2, 1, 2, width);
  sheet.addRow([]);
  const header = sheet.addRow(report.columns.map((c) => c.label));
  header.font = { bold: true };
  header.eachCell((cell) => {
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFE5E7EB" } };
    cell.border = { bottom: { style: "thin" } };
  });

  const cell = (type: string, v: string | number | null) => {
    if (v === null) return null;
    if (type === "money" && typeof v === "number") return v / 100;
    return v;
  };
  for (const r of report.rows) sheet.addRow(report.columns.map((c) => cell(c.type, r[c.key] ?? null)));

  if (Object.keys(report.totals).length > 0) {
    const values = report.columns.map((c, i) => (c.key in report.totals ? cell(c.type, report.totals[c.key] ?? 0) : i === 0 ? tr(lang, "reports.total") : null));
    const totalRow = sheet.addRow(values);
    totalRow.font = { bold: true };
    totalRow.eachCell((c) => (c.border = { top: { style: "thin" } }));
  }
  if (report.truncated) sheet.addRow([tr(lang, "reports.truncated", { max: report.rows.length })]);

  report.columns.forEach((c, i) => {
    const col = sheet.getColumn(i + 1);
    if (c.type === "money") col.numFmt = "#,##0.00";
    const longest = Math.max(c.label.length, ...report.rows.slice(0, 500).map((r) => String(r[c.key] ?? "").length));
    col.width = Math.min(45, Math.max(10, longest + 2));
  });
  return Buffer.from(await book.xlsx.writeBuffer());
}
