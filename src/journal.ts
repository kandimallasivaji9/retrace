import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export type Reversibility = "reversible" | "untracked";
export type Status = "applied" | "failed" | "undone" | "untracked";

export interface Entry {
  id: number;
  run_id: string;
  step: number;
  ts: string;
  tool: string;
  args: string;
  reversibility: Reversibility;
  before: string | null;
  after: string | null;
  is_error: number;
  status: Status;
  prev_hash: string;
  hash: string;
}

export interface NewEntry {
  runId: string;
  tool: string;
  args: unknown;
  reversibility: Reversibility;
  before: unknown;
  after: unknown;
  isError: boolean;
}

export interface RunSummary {
  run_id: string;
  actions: number;
  undoable: number;
  started: string;
  ended: string;
}

const GENESIS = "0".repeat(64);

export const defaultJournalPath = () =>
  process.env.RETRACE_JOURNAL ?? path.join(os.homedir(), ".retrace", "journal.db");

type Hashed = Pick<Entry, "run_id" | "step" | "ts" | "tool" | "args" | "reversibility" | "before" | "after" | "is_error">;

/** Status is left out on purpose: it changes on undo. Everything the agent did is covered. */
function entryHash(prev: string, e: Hashed): string {
  return createHash("sha256")
    .update(prev + JSON.stringify([e.run_id, e.step, e.ts, e.tool, e.args, e.reversibility, e.before, e.after, e.is_error]))
    .digest("hex");
}

/** Append-only, hash-chained log of every action an agent took. */
export class Journal {
  private db: Database.Database;

  constructor(file = defaultJournalPath()) {
    mkdirSync(path.dirname(file), { recursive: true });
    this.db = new Database(file);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS actions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL, step INTEGER NOT NULL, ts TEXT NOT NULL,
        tool TEXT NOT NULL, args TEXT NOT NULL, reversibility TEXT NOT NULL,
        before TEXT, after TEXT, is_error INTEGER NOT NULL, status TEXT NOT NULL,
        prev_hash TEXT NOT NULL, hash TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_actions_run ON actions(run_id, step);
    `);
  }

  record(n: NewEntry): Entry {
    const insert = this.db.transaction(() => {
      const last = this.db.prepare("SELECT hash FROM actions ORDER BY id DESC LIMIT 1").get() as { hash: string } | undefined;
      const prev = last?.hash ?? GENESIS;
      const { s: step } = this.db
        .prepare("SELECT COALESCE(MAX(step), 0) + 1 AS s FROM actions WHERE run_id = ?")
        .get(n.runId) as { s: number };
      const row: Hashed = {
        run_id: n.runId,
        step,
        ts: new Date().toISOString(),
        tool: n.tool,
        args: JSON.stringify(n.args ?? {}),
        reversibility: n.reversibility,
        before: n.before == null ? null : JSON.stringify(n.before),
        after: n.after == null ? null : JSON.stringify(n.after),
        is_error: n.isError ? 1 : 0,
      };
      const status: Status = n.reversibility === "untracked" ? "untracked" : n.isError ? "failed" : "applied";
      const info = this.db
        .prepare(`INSERT INTO actions (run_id, step, ts, tool, args, reversibility, before, after, is_error, status, prev_hash, hash)
                  VALUES (@run_id, @step, @ts, @tool, @args, @reversibility, @before, @after, @is_error, @status, @prev_hash, @hash)`)
        .run({ ...row, status, prev_hash: prev, hash: entryHash(prev, row) });
      return Number(info.lastInsertRowid);
    });
    return this.get(insert())!;
  }

  get(id: number): Entry | undefined {
    return this.db.prepare("SELECT * FROM actions WHERE id = ?").get(id) as Entry | undefined;
  }

  entries(runId: string): Entry[] {
    return this.db.prepare("SELECT * FROM actions WHERE run_id = ? ORDER BY step").all(runId) as Entry[];
  }

  lastRunId(): string | undefined {
    const r = this.db.prepare("SELECT run_id FROM actions ORDER BY id DESC LIMIT 1").get() as { run_id: string } | undefined;
    return r?.run_id;
  }

  /** Accepts a full run id or a unique prefix (like the 8 chars `retrace log` prints). */
  resolveRun(prefix: string): string | undefined {
    const rows = this.db
      .prepare("SELECT DISTINCT run_id FROM actions WHERE run_id LIKE ? LIMIT 2")
      .all(`${prefix}%`) as { run_id: string }[];
    return rows.length === 1 ? rows[0].run_id : undefined;
  }

  runs(limit = 10): RunSummary[] {
    return this.db
      .prepare(`SELECT run_id, COUNT(*) AS actions,
                  SUM(status IN ('applied','failed')) AS undoable,
                  MIN(ts) AS started, MAX(ts) AS ended
                FROM actions GROUP BY run_id ORDER BY MAX(id) DESC LIMIT ?`)
      .all(limit) as RunSummary[];
  }

  setStatus(id: number, status: Status): void {
    this.db.prepare("UPDATE actions SET status = ? WHERE id = ?").run(status, id);
  }

  /** Walks the hash chain. Any edited or deleted entry breaks it. */
  verify(): { ok: true; count: number } | { ok: false; brokenAt: number } {
    let prev = GENESIS;
    let count = 0;
    for (const row of this.db.prepare("SELECT * FROM actions ORDER BY id").iterate() as Iterable<Entry>) {
      if (row.prev_hash !== prev || row.hash !== entryHash(prev, row)) return { ok: false, brokenAt: row.id };
      prev = row.hash;
      count++;
    }
    return { ok: true, count };
  }

  close(): void {
    this.db.close();
  }
}
