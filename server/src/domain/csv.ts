import { parse } from "csv-parse/sync";

export const REQUIRED_COLUMNS = ["store_id", "store_name", "address", "city", "state", "country"] as const;
export type StoreRow = Record<(typeof REQUIRED_COLUMNS)[number], string>;

export type CsvParseResult = { ok: true; rows: StoreRow[] } | { ok: false; errors: string[] };

const MAX_REPORTED_ERRORS = 20;

/**
 * Validates headers first (fail fast with a clear message), then rows.
 * The whole file is rejected if anything is wrong: partial imports are
 * confusing and the user can simply fix and re-upload.
 */
export function parseStoresCsv(content: string | Buffer, maxRows: number): CsvParseResult {
  let records: string[][];
  try {
    records = parse(content, { bom: true, skip_empty_lines: true, trim: true, relax_column_count: true });
  } catch (err) {
    return { ok: false, errors: [`File is not valid CSV: ${(err as Error).message}`] };
  }

  const [header, ...body] = records;
  if (!header) return { ok: false, errors: ["File is empty."] };

  const normalized = header.map((h) => h.trim().toLowerCase());
  const missing = REQUIRED_COLUMNS.filter((c) => !normalized.includes(c));
  const unexpected = normalized.filter((h) => !(REQUIRED_COLUMNS as readonly string[]).includes(h));
  const duplicates = normalized.filter((h, i) => normalized.indexOf(h) !== i);
  const headerErrors: string[] = [];
  if (missing.length) headerErrors.push(`Missing required column(s): ${missing.join(", ")}`);
  if (unexpected.length) headerErrors.push(`Unexpected column(s): ${unexpected.join(", ")}`);
  if (duplicates.length) headerErrors.push(`Duplicate column(s): ${[...new Set(duplicates)].join(", ")}`);
  if (headerErrors.length) {
    headerErrors.push(`Expected header: ${REQUIRED_COLUMNS.join(",")}`);
    return { ok: false, errors: headerErrors };
  }

  if (body.length === 0) return { ok: false, errors: ["File has a header but no store rows."] };
  if (body.length > maxRows) return { ok: false, errors: [`File has ${body.length} rows; maximum is ${maxRows}.`] };

  const index = Object.fromEntries(REQUIRED_COLUMNS.map((c) => [c, normalized.indexOf(c)])) as Record<
    (typeof REQUIRED_COLUMNS)[number],
    number
  >;
  const errors: string[] = [];
  const seen = new Map<string, number>();
  const rows: StoreRow[] = [];

  body.forEach((cells, i) => {
    const line = i + 2; // 1-based, after header
    if (cells.length !== header.length) {
      errors.push(`Line ${line}: expected ${header.length} columns, found ${cells.length}`);
      return;
    }
    const row = Object.fromEntries(REQUIRED_COLUMNS.map((c) => [c, cells[index[c]] ?? ""])) as StoreRow;
    const empty = REQUIRED_COLUMNS.filter((c) => c !== "country" && row[c] === "");
    if (empty.length) errors.push(`Line ${line}: empty value for ${empty.join(", ")}`);
    const firstSeen = seen.get(row.store_id);
    if (row.store_id && firstSeen !== undefined) {
      errors.push(`Line ${line}: duplicate store_id "${row.store_id}" (first seen on line ${firstSeen})`);
    } else if (row.store_id) {
      seen.set(row.store_id, line);
    }
    rows.push(row);
  });

  if (errors.length) {
    const extra = errors.length - MAX_REPORTED_ERRORS;
    return {
      ok: false,
      errors: extra > 0 ? [...errors.slice(0, MAX_REPORTED_ERRORS), `…and ${extra} more error(s)`] : errors,
    };
  }
  return { ok: true, rows };
}
