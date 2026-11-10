import pg from "pg";
import { displayName, qualified, quoteIdent as q, type PgBefore } from "./pg-util.js";

export type PgUndoResult = { ok: true } | { ok: false; conflict: boolean; reason: string };

/**
 * Reverses one journaled statement inside a single transaction, newest row first.
 * Row images are rebuilt with jsonb_populate_record, so every column keeps its real type.
 */
export async function undoPostgres(b: PgBefore, urlOverride?: string, force = false): Promise<PgUndoResult> {
  const client = new pg.Client({ connectionString: urlOverride ?? process.env.RETRACE_PG_URL ?? b.url });
  try {
    await client.connect();
  } catch (err: any) {
    return { ok: false, conflict: false, reason: `can't connect to Postgres (${err.message}). Pass --url or set RETRACE_PG_URL.` };
  }
  try {
    await client.query("BEGIN");
    for (const r of [...b.rows].reverse()) {
      const info = b.tables[r.t];
      const tbl = qualified(info);
      const shown = displayName(info);
      const rec = (param: string) => `jsonb_populate_record(NULL::${tbl}, ${param}::jsonb)`;
      const pk = (alias: string) => info.pk.map((c) => `${alias}.${q(c)}`).join(", ");
      const key = (img: string) => info.pk.map((c) => `${c}=${JSON.parse(img)[c]}`).join(", ");

      if (!force) {
        if (r.new !== null) {
          const cur = await client.query(`SELECT to_jsonb(t) = $1::jsonb AS same FROM ${tbl} t, ${rec("$1")} n WHERE (${pk("t")}) = (${pk("n")})`, [r.new]);
          if (cur.rowCount === 0 || !cur.rows[0].same) {
            await client.query("ROLLBACK");
            return { ok: false, conflict: true, reason: `${shown} row ${key(r.new)} changed after the agent touched it (use --force to overwrite)` };
          }
        } else {
          const cur = await client.query(`SELECT 1 FROM ${tbl} t, ${rec("$1")} o WHERE (${pk("t")}) = (${pk("o")})`, [r.old]);
          if (cur.rowCount) {
            await client.query("ROLLBACK");
            return { ok: false, conflict: true, reason: `${shown} row ${key(r.old!)} was re-created after the agent deleted it (use --force to overwrite)` };
          }
        }
      }

      if (r.old === null) {
        // agent inserted it → delete it
        await client.query(`DELETE FROM ${tbl} t USING ${rec("$1")} n WHERE (${pk("t")}) = (${pk("n")})`, [r.new]);
      } else if (r.new === null) {
        // agent deleted it → put it back exactly
        const cols = info.insertable;
        if (force) await client.query(`DELETE FROM ${tbl} t USING ${rec("$1")} o WHERE (${pk("t")}) = (${pk("o")})`, [r.old]);
        await client.query(
          `INSERT INTO ${tbl} (${cols.map(q).join(", ")}) OVERRIDING SYSTEM VALUE SELECT ${cols.map((c) => `o.${q(c)}`).join(", ")} FROM ${rec("$1")} o`,
          [r.old],
        );
      } else {
        // agent updated it → restore old values
        const cols = info.updatable;
        await client.query(
          `UPDATE ${tbl} t SET (${cols.map(q).join(", ")}) = ROW(${cols.map((c) => `o.${q(c)}`).join(", ")})
           FROM ${rec("$1")} o, ${rec("$2")} n WHERE (${pk("t")}) = (${pk("n")})`,
          [r.old, r.new],
        );
      }
    }
    await client.query("COMMIT");
    return { ok: true };
  } catch (err: any) {
    await client.query("ROLLBACK").catch(() => {});
    return { ok: false, conflict: false, reason: err.message };
  } finally {
    await client.end().catch(() => {});
  }
}
