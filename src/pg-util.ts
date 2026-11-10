import type pg from "pg";

export interface TableInfo {
  schema: string;
  name: string;
  pk: string[];
  /** columns we can write back on undo (generated columns excluded) */
  insertable: string[];
  /** columns we can SET on undo (also excludes GENERATED ALWAYS identity) */
  updatable: string[];
}

/** What the journal stores for one Postgres statement. Row images are jsonb text, so numbers keep full precision. */
export interface PgBefore {
  kind: "postgres";
  url: string;
  command: "INSERT" | "UPDATE" | "DELETE";
  tables: Record<string, TableInfo>;
  rows: { t: string; old: string | null; new: string | null }[];
}

export const quoteIdent = (s: string) => `"${s.replace(/"/g, '""')}"`;
export const qualified = (t: TableInfo) => `${quoteIdent(t.schema)}.${quoteIdent(t.name)}`;
/** For messages people read: public.customers, not "public"."customers". */
export const displayName = (t: TableInfo) => `${t.schema}.${t.name}`;

/** Never store a password in the journal. */
export function sanitizeUrl(url: string): string {
  try {
    const u = new URL(url);
    u.password = "";
    return u.toString();
  } catch {
    return url.replace(/:\/\/([^:@/]+):[^@/]*@/, "://$1@");
  }
}

export async function inspectTable(client: pg.ClientBase, oid: number | string): Promise<TableInfo> {
  const { rows } = await client.query(
    `SELECT n.nspname AS schema, c.relname AS name,
       COALESCE((SELECT array_agg(a.attname::text ORDER BY array_position(i.indkey::int2[], a.attnum))
                 FROM pg_index i JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
                 WHERE i.indrelid = c.oid AND i.indisprimary), '{}') AS pk,
       COALESCE((SELECT array_agg(a.attname::text ORDER BY a.attnum) FROM pg_attribute a
                 WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped AND a.attgenerated = ''), '{}') AS insertable,
       COALESCE((SELECT array_agg(a.attname::text ORDER BY a.attnum) FROM pg_attribute a
                 WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped AND a.attgenerated = ''
                   AND a.attidentity <> 'a'), '{}') AS updatable
     FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE c.oid = $1`,
    [oid],
  );
  if (!rows[0]) throw new Error(`table ${oid} not found`);
  return rows[0];
}

/**
 * Only plain INSERT / UPDATE / DELETE get through `execute`.
 * WITH is blocked because a data-modifying CTE could change tables Retrace can't see.
 */
export function validateDml(sql: string): { sql: string } | { error: string } {
  const body = sql.trim().replace(/;\s*$/, "");
  const head = body.replace(/^(\s*--[^\n]*\n|\s*\/\*[\s\S]*?\*\/)*/, "").trimStart().toLowerCase();
  if (/^(select|show|explain)\b/.test(head)) return { error: "Use the query tool for reads. execute is for INSERT, UPDATE and DELETE." };
  if (/^with\b/.test(head)) return { error: "WITH statements aren't supported by execute yet. Write a plain INSERT, UPDATE or DELETE." };
  if (/^merge\b/.test(head)) return { error: "MERGE isn't supported yet. Use INSERT ... ON CONFLICT, UPDATE or DELETE." };
  if (!/^(insert|update|delete)\b/.test(head)) {
    return { error: "Blocked by Retrace: only INSERT, UPDATE and DELETE can run. Schema changes (DROP, ALTER, TRUNCATE, CREATE) and other commands aren't allowed." };
  }
  const noStrings = body.replace(/'(?:[^']|'')*'/g, "''").replace(/"(?:[^"]|"")*"/g, '""');
  if (noStrings.includes(";")) return { error: "One statement at a time, please. Nothing was changed." };
  if (/\breturning\b/i.test(body)) return { error: "Remove the RETURNING clause; Retrace adds its own to record the change." };
  return { sql: body };
}
