#!/usr/bin/env node
import path from "node:path";
import { Command } from "commander";
import { Journal, type Entry } from "./journal.js";
import { startProxy } from "./proxy.js";
import { undoEntry, undoRun, type UndoOutcome } from "./undo.js";
import { VERSION } from "./version.js";

const program = new Command()
  .name("retrace")
  .description("Ctrl+Z for AI agents. Undo any tool call your agent regrets.")
  .version(VERSION)
  .enablePositionalOptions();

const short = (id: string) => id.slice(0, 8);

/** Show paths relative to where you run the command, so the log stays readable. */
function rel(p: string): string {
  const r = path.relative(process.cwd(), p);
  return r && !r.startsWith("..") && !path.isAbsolute(r) ? r : p;
}

function target(e: Entry): string {
  const a = JSON.parse(e.args);
  if (a.source && a.destination) return `${rel(a.source)} → ${rel(a.destination)}`;
  if (a.path) return rel(a.path);
  return e.args.length > 60 ? e.args.slice(0, 57) + "..." : e.args;
}

function printEntry(e: Entry) {
  const time = e.ts.slice(11, 19);
  console.log(`  #${String(e.id).padEnd(5)}${time}  ${e.tool.padEnd(18)}${e.status.padEnd(11)}${target(e)}`);
}

function printOutcomes(outcomes: UndoOutcome[]): boolean {
  if (outcomes.length === 0) console.log("Nothing to undo.");
  let ok = true;
  for (const o of outcomes) {
    const mark = { undone: "✓", skipped: "·", conflict: "!", error: "✗" }[o.result];
    console.log(`${mark} #${o.id} ${o.tool} ${o.result}${o.reason ? `: ${o.reason}` : ""}`);
    if (o.result === "conflict" || o.result === "error") ok = false;
  }
  return ok;
}

function findRun(j: Journal, id?: string | true): string {
  const runId = typeof id === "string" ? j.resolveRun(id) : j.lastRunId();
  if (!runId) {
    console.error(typeof id === "string" ? `No single run matches "${id}".` : "No runs recorded yet.");
    process.exit(1);
  }
  return runId;
}

program
  .command("wrap")
  .description("run an MCP server behind Retrace, e.g. retrace wrap -- npx @modelcontextprotocol/server-filesystem ./project")
  .option("--journal <path>", "journal file (default ~/.retrace/journal.db)")
  .argument("<command...>", "the MCP server command to wrap")
  .passThroughOptions()
  .action(async (command: string[], opts) => {
    const [cmd, ...args] = command;
    await startProxy(cmd, args, { journal: opts.journal });
  });

program
  .command("log")
  .description("show what an agent did")
  .option("--run <id>", "a specific run (default: latest)")
  .option("--runs", "list recent runs instead")
  .option("--journal <path>")
  .action((opts) => {
    const j = new Journal(opts.journal);
    if (opts.runs) {
      for (const r of j.runs()) {
        console.log(`${short(r.run_id)}  ${r.started.slice(0, 19).replace("T", " ")}  ${r.actions} actions, ${r.undoable} undoable`);
      }
      return;
    }
    const runId = findRun(j, opts.run);
    const entries = j.entries(runId);
    console.log(`Run ${short(runId)} (${entries.length} actions)`);
    entries.forEach(printEntry);
    const untracked = entries.filter((e) => e.status === "untracked").length;
    if (untracked) console.log(`\n  ${untracked} action(s) went to tools Retrace can't undo yet.`);
  });

program
  .command("undo")
  .description("undo one action, or a whole run with --run")
  .argument("[id]", "action id from `retrace log`")
  .option("--run [runId]", "undo a whole run, newest step first (default: latest run)")
  .option("--force", "undo even if something changed after the agent")
  .option("--journal <path>")
  .action(async (id: string | undefined, opts) => {
    const j = new Journal(opts.journal);
    let outcomes: UndoOutcome[];
    if (opts.run) {
      outcomes = await undoRun(j, findRun(j, opts.run), opts.force);
    } else if (id) {
      const e = j.get(Number(id.replace(/^#/, "")));
      if (!e) {
        console.error(`No action #${id}.`);
        process.exit(1);
      }
      outcomes = [await undoEntry(j, e, opts.force)];
    } else {
      console.error("Pass an action id (retrace undo 12) or --run.");
      process.exit(1);
    }
    if (!printOutcomes(outcomes)) process.exit(1);
  });

program
  .command("verify")
  .description("check the journal's hash chain for tampering")
  .option("--journal <path>")
  .action((opts) => {
    const result = new Journal(opts.journal).verify();
    if (result.ok) console.log(`✓ Journal intact (${result.count} actions).`);
    else {
      console.error(`✗ Hash chain broken at action #${result.brokenAt}.`);
      process.exit(1);
    }
  });

program.parseAsync();
