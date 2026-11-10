import { readState, restoreState, type PathState } from "./fs-state.js";
import type { Entry, Journal } from "./journal.js";

export interface UndoOutcome {
  id: number;
  step: number;
  tool: string;
  result: "undone" | "skipped" | "conflict" | "error";
  reason?: string;
}

export async function undoEntry(journal: Journal, e: Entry, force = false): Promise<UndoOutcome> {
  const base = { id: e.id, step: e.step, tool: e.tool };
  if (e.status === "undone") return { ...base, result: "skipped", reason: "already undone" };
  if (e.reversibility !== "reversible" || !e.before || !e.after) {
    return { ...base, result: "skipped", reason: "not tracked, can't undo" };
  }

  const before = JSON.parse(e.before) as PathState[];
  const after = JSON.parse(e.after) as PathState[];

  // Conflict check: never overwrite a change someone made after the agent.
  if (!force) {
    for (const s of after) {
      const now = await readState(s.path, false);
      if (now.hash !== s.hash) {
        return { ...base, result: "conflict", reason: `${s.path} changed after the agent touched it (use --force to overwrite)` };
      }
    }
  }

  try {
    for (const s of [...before].reverse()) await restoreState(s);
  } catch (err: any) {
    return { ...base, result: "error", reason: err.message };
  }
  journal.setStatus(e.id, "undone");
  return { ...base, result: "undone" };
}

/** Undo a whole run, newest step first. Stops at the first conflict so later steps stay consistent. */
export async function undoRun(journal: Journal, runId: string, force = false): Promise<UndoOutcome[]> {
  const steps = journal
    .entries(runId)
    .filter((e) => e.status === "applied" || e.status === "failed")
    .reverse();
  const outcomes: UndoOutcome[] = [];
  for (const e of steps) {
    const o = await undoEntry(journal, e, force);
    outcomes.push(o);
    if (o.result === "conflict" || o.result === "error") break;
  }
  return outcomes;
}
