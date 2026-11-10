// End-to-end: a real MCP client talks to the real filesystem server through Retrace.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "retrace-work-")));
const journal = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "retrace-db-")), "journal.db");
const env = { ...process.env, RETRACE_JOURNAL: journal };
const cli = path.resolve("dist/cli.js");
const fsServer = path.resolve("node_modules/@modelcontextprotocol/server-filesystem/dist/index.js");
const retrace = (...args) => execFileSync("node", [cli, ...args], { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const f = (name) => path.join(work, name);

async function agentSession(actions, wrapFlags = []) {
  const client = new Client({ name: "test-agent", version: "0" });
  await client.connect(new StdioClientTransport({ command: "node", args: [cli, "wrap", ...wrapFlags, "--", "node", fsServer, work], env, stderr: "ignore" }));
  const texts = [];
  for (const [name, args] of actions) {
    const res = await client.callTool({ name, arguments: args });
    texts.push(res.content.filter((c) => c.type === "text").map((c) => c.text).join("\n"));
  }
  await client.close();
  return texts;
}

// 1. Agent overwrites a file, creates one, moves one, makes a dir, and reads (not journaled).
fs.writeFileSync(f("notes.txt"), "original notes\n");
fs.writeFileSync(f("plan.md"), "the plan\n");
await agentSession([
  ["write_file", { path: f("notes.txt"), content: "agent overwrote this\n" }],
  ["write_file", { path: f("new.txt"), content: "agent made this\n" }],
  ["move_file", { source: f("plan.md"), destination: f("plan-old.md") }],
  ["create_directory", { path: f("build") }],
  ["edit_file", { path: f("new.txt"), edits: [{ oldText: "agent made this", newText: "agent edited this" }] }],
  ["read_text_file", { path: f("notes.txt") }],
]);
console.log(retrace("log"));
assert.equal(fs.readFileSync(f("notes.txt"), "utf8"), "agent overwrote this\n");

console.log(retrace("undo", "--run"));
assert.equal(fs.readFileSync(f("notes.txt"), "utf8"), "original notes\n");
assert.equal(fs.readFileSync(f("plan.md"), "utf8"), "the plan\n");
assert.ok(!fs.existsSync(f("new.txt")));
assert.ok(!fs.existsSync(f("plan-old.md")));
assert.ok(!fs.existsSync(f("build")));
console.log("✓ whole run undone, workspace back to original\n");

// 2. Conflict: a human edits the file after the agent, so undo must refuse.
await agentSession([["write_file", { path: f("notes.txt"), content: "agent v2\n" }]]);
fs.writeFileSync(f("notes.txt"), "human fixed it by hand\n");
let refused = false;
try { retrace("undo", "--run"); } catch (e) { refused = true; console.log(e.stdout); }
assert.ok(refused);
assert.equal(fs.readFileSync(f("notes.txt"), "utf8"), "human fixed it by hand\n");
console.log("✓ conflict detected, human's change kept\n");

// 3. Dry run: the agent "does" everything, nothing on disk changes.
fs.writeFileSync(f("todo.txt"), "Buy milk\nCall mom\n");
const snapshot = () => fs.readdirSync(work).sort().map((n) => [n, fs.statSync(f(n)).isFile() ? fs.readFileSync(f(n), "utf8") : "<dir>"]);
const beforeDry = JSON.stringify(snapshot());
const previews = await agentSession([
  ["write_file", { path: f("todo.txt"), content: "Buy grog\nCall the captain\n" }],
  ["write_file", { path: f("brand-new.txt"), content: "hello\n" }],
  ["move_file", { source: f("notes.txt"), destination: f("old-notes.txt") }],
  ["create_directory", { path: f("archive") }],
  ["edit_file", { path: f("todo.txt"), edits: [{ oldText: "Buy milk", newText: "Buy oat milk" }] }],
  ["write_file", { path: "/etc/hosts", content: "pwned" }],
], ["--dry-run"]);
previews.forEach((t) => console.log(t + "\n"));
assert.equal(JSON.stringify(snapshot()), beforeDry, "dry run must not touch the disk");
assert.match(previews[0], /Would overwrite[\s\S]*-Buy milk[\s\S]*\+Buy grog/);
assert.match(previews[1], /Would create/);
assert.match(previews[2], /Would move/);
assert.match(previews[3], /Would create directory/);
assert.match(previews[4], /Planned edit[\s\S]*\+Buy oat milk/);
assert.match(previews[5], /outside the allowed directories/);
assert.ok(!previews[5].includes("localhost"), "must not leak files outside allowed dirs");
const dryLog = retrace("log");
console.log(dryLog);
assert.match(dryLog, /dry run/);
assert.match(retrace("undo", "--run"), /Nothing to undo/);
console.log("✓ dry run previewed 6 actions, disk untouched, no leaks outside allowed dirs\n");

// 4. Tamper check: the chain is intact, then someone rewrites history.
console.log(retrace("verify"));
const { default: Database } = await import("better-sqlite3");
const db = new Database(journal);
db.prepare("UPDATE actions SET tool = 'read_file' WHERE id = 1").run();
db.close();
let caught = false;
try { retrace("verify"); } catch (e) { caught = true; console.log(e.stderr); }
assert.ok(caught);
console.log("✓ tampering detected\n");
console.log("All tests passed.");
