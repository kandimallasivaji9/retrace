import { randomUUID } from "node:crypto";
import pg from "pg";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { Journal } from "./journal.js";
import { displayName, inspectTable, sanitizeUrl, validateDml, type PgBefore, type TableInfo } from "./pg-util.js";
import { VERSION } from "./version.js";

const MAX_TRACKED_ROWS = 100_000;
const MAX_RESULT_ROWS = 100;
const DRY = "[retrace dry-run] Nothing was changed.";

const TOOLS = [
  {
    name: "list_tables",
    description: "List the tables in the database with approximate row counts.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "describe_table",
    description: "Show a table's columns, types and primary key.",
    inputSchema: { type: "object", properties: { table: { type: "string", description: "Table name, optionally schema-qualified" } }, required: ["table"] },
  },
  {
    name: "query",
    description: `Run a read-only SQL query (SELECT). Returns up to ${MAX_RESULT_ROWS} rows as JSON.`,
    inputSchema: { type: "object", properties: { sql: { type: "string" } }, required: ["sql"] },
  },
  {
    name: "execute",
    description: "Run one INSERT, UPDATE or DELETE statement. Retrace records every change so it can be undone. Schema changes (DROP, ALTER, TRUNCATE) are blocked.",
    inputSchema: { type: "object", properties: { sql: { type: "string" } }, required: ["sql"] },
  },
];

const ok = (text: string) => ({ content: [{ type: "text", text }] });
const fail = (text: string) => ({ content: [{ type: "text", text }], isError: true });
const plural = (n: number) => `${n} row${n === 1 ? "" : "s"}`;

/** Retrace's own Postgres MCP server: reads pass through, every write is journaled and undoable. Needs Postgres 18+. */
export async function startPostgresServer(url: string, opts: { journal?: string; dryRun?: boolean } = {}) {
  const pool = new pg.Pool({ connectionString: url, max: 4 });
  const { rows: [v] } = await pool.query("SELECT current_setting('server_version_num')::int AS n, current_setting('server_version') AS s");
  if (v.n < 180000) {
    throw new Error(`Retrace needs Postgres 18 or newer (this server is ${v.s}). It relies on RETURNING old/new to record changes.`);
  }

  const journal = new Journal(opts.journal);
  const runId = randomUUID();
  const safeUrl = sanitizeUrl(url);

  async function execute(sql: string) {
    const checked = validateDml(sql);
    if ("error" in checked) return fail(checked.error);

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL statement_timeout = '60s'");
      const res: pg.QueryResult<any> = await client.query({
        text: `${checked.sql}\nRETURNING COALESCE(old.tableoid, new.tableoid)::oid AS __t, to_jsonb(old)::text AS __old, to_jsonb(new)::text AS __new`,
        queryMode: "extended", // one statement only: Postgres rejects "DELETE ...; DROP ..."
      } as any);
      const command = res.command as PgBefore["command"];
      const n = res.rows.length;

      const tables: Record<string, TableInfo> = {};
      for (const oid of new Set(res.rows.map((r) => String(r.__t)))) {
        const info = await inspectTable(client, oid);
        if (info.pk.length === 0) {
          await client.query("ROLLBACK");
          return fail(`${displayName(info)} has no primary key, so Retrace can't undo changes to it. Nothing was changed.`);
        }
        tables[oid] = info;
      }
      if (n > MAX_TRACKED_ROWS) {
        await client.query("ROLLBACK");
        return fail(`This would change ${n} rows; Retrace tracks at most ${MAX_TRACKED_ROWS} per statement. Nothing was changed.`);
      }

      const where = Object.values(tables).map(displayName).join(", ") || "no table";
      const label = `${command} ${plural(n)}${n ? ` in ${where}` : ""}`;

      if (opts.dryRun) {
        await client.query("ROLLBACK");
        journal.record({ runId, tool: "execute", args: { sql }, reversibility: "reversible", before: null, after: null, isError: false, planned: true });
        const sample = res.rows.slice(0, 3).map((r) => `  ${r.__old ?? r.__new}`).join("\n");
        return ok(`${DRY} Would ${label}.${n ? `\nSample of affected rows:\n${sample}` : ""}`);
      }

      await client.query("COMMIT");
      if (n > 0) {
        const before: PgBefore = {
          kind: "postgres", url: safeUrl, command, tables,
          rows: res.rows.map((r) => ({ t: String(r.__t), old: r.__old, new: r.__new })),
        };
        journal.record({ runId, tool: "execute", args: { sql }, reversibility: "reversible", before, after: { kind: "postgres", rowCount: n }, isError: false });
      }
      return ok(`${label}.`);
    } catch (err: any) {
      await client.query("ROLLBACK").catch(() => {});
      return fail(`SQL error: ${err.message}. Nothing was changed.`);
    } finally {
      client.release();
    }
  }

  async function readOnly(sql: string, params: unknown[] = []) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN READ ONLY");
      await client.query("SET LOCAL statement_timeout = '30s'");
      return (await client.query({ text: sql, values: params, queryMode: "extended" } as any)) as pg.QueryResult<any>;
    } finally {
      await client.query("ROLLBACK").catch(() => {});
      client.release();
    }
  }

  const server = new Server({ name: "retrace-postgres", version: VERSION }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
  server.setRequestHandler(CallToolRequestSchema, async (req): Promise<any> => {
    const args = (req.params.arguments ?? {}) as Record<string, string>;
    try {
      switch (req.params.name) {
        case "list_tables": {
          const r = await readOnly(`SELECT n.nspname || '.' || c.relname AS "table", GREATEST(c.reltuples, 0)::bigint AS approx_rows
            FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE c.relkind IN ('r', 'p') AND n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg_toast%'
            ORDER BY 1`);
          return ok(JSON.stringify(r.rows, null, 2));
        }
        case "describe_table": {
          const r = await readOnly(`SELECT a.attname AS column, format_type(a.atttypid, a.atttypmod) AS type, NOT a.attnotnull AS nullable,
              COALESCE(a.attnum = ANY(i.indkey), false) AS primary_key
            FROM pg_attribute a LEFT JOIN pg_index i ON i.indrelid = a.attrelid AND i.indisprimary
            WHERE a.attrelid = $1::regclass AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum`, [args.table]);
          return ok(JSON.stringify(r.rows, null, 2));
        }
        case "query": {
          const r = await readOnly(args.sql);
          const shown = r.rows.slice(0, MAX_RESULT_ROWS);
          const more = r.rows.length > MAX_RESULT_ROWS ? `\n(${r.rows.length - MAX_RESULT_ROWS} more rows not shown; add a LIMIT or filter)` : "";
          return ok(JSON.stringify(shown, null, 2) + more);
        }
        case "execute":
          return await execute(args.sql);
        default:
          return fail(`Unknown tool ${req.params.name}`);
      }
    } catch (err: any) {
      return fail(`Error: ${err.message}`);
    }
  });

  const shutdown = async () => {
    await pool.end().catch(() => {});
    journal.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  server.onclose = shutdown;

  await server.connect(new StdioServerTransport());
  process.stderr.write(`[retrace] postgres ${v.s} at ${safeUrl}, run ${runId.slice(0, 8)}${opts.dryRun ? " (DRY RUN: nothing will be changed)" : ""}\n`);
}
