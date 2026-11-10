// End-to-end: an MCP client runs SQL through `retrace postgres` against a real Postgres 18.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import pg from "pg";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { startDemoDb } from "../scripts/demo-db-lib.mjs";

const { url, stop } = await startDemoDb();
const journal = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "retrace-db-")), "journal.db");
// The journal never stores passwords, so undo gets the connection string from RETRACE_PG_URL.
const env = { ...process.env, RETRACE_JOURNAL: journal, RETRACE_PG_URL: url };
const cli = path.resolve("dist/cli.js");
const retrace = (...args) => execFileSync("node", [cli, ...args], { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const db = new pg.Client({ connectionString: url });
await db.connect();
const count = async () => Number((await db.query("SELECT count(*) FROM customers")).rows[0].count);
const fingerprint = async () => (await db.query("SELECT md5(string_agg(c::text, '|' ORDER BY id)) AS h FROM customers c")).rows[0].h;

async function agent(calls, flags = []) {
  const client = new Client({ name: "test-agent", version: "0" });
  await client.connect(new StdioClientTransport({ command: "node", args: [cli, "postgres", "--url", url, ...flags], env, stderr: "ignore" }));
  const out = [];
  for (const [name, args] of calls) {
    const r = await client.callTool({ name, arguments: args });
    out.push({ text: r.content.map((c) => c.text).join("\n"), isError: !!r.isError });
  }
  await client.close();
  return out;
}

try {
  const original = await fingerprint();
  assert.equal(await count(), 500);

  // 1. The demo story: "archive inactive customers" deletes 412, including paying ones.
  const r = await agent([
    ["list_tables", {}],
    ["query", { sql: "SELECT count(*) FROM customers" }],
    ["execute", { sql: "DELETE FROM customers WHERE last_seen < DATE '2026-10-01';" }],
    ["execute", { sql: "UPDATE customers SET plan = 'free', mrr = 0 WHERE id <= 5" }],
    ["execute", { sql: "INSERT INTO customers (name, email, plan, mrr, active, last_seen) VALUES ('New Co', 'new@example.com', 'pro', 29, true, '2026-11-10')" }],
    ["execute", { sql: "DROP TABLE customers" }],
    ["execute", { sql: "DELETE FROM customers WHERE id = 1; DROP TABLE customers" }],
  ]);
  r.forEach((x) => console.log((x.isError ? "✗ " : "→ ") + x.text.split("\n")[0]));
  assert.match(r[2].text, /DELETE 412 rows/);
  assert.ok(r[5].isError && /Blocked by Retrace/.test(r[5].text));
  assert.ok(r[6].isError && /One statement at a time/.test(r[6].text));
  assert.equal(await count(), 89);
  console.log("\n" + retrace("log"));

  console.log(retrace("undo", "--run"));
  assert.equal(await count(), 500);
  assert.equal(await fingerprint(), original, "every row must be byte-for-byte identical");
  console.log("✓ 500 → 89 → 500, every row identical (types, numerics, dates)\n");

  // 2. Conflict: a human edits the row after the agent, undo must refuse and keep it.
  await agent([["execute", { sql: "UPDATE customers SET name = 'Agent was here' WHERE id = 7" }]]);
  await db.query("UPDATE customers SET name = 'Fixed by a human' WHERE id = 7");
  let refused = false;
  try { retrace("undo", "--run"); } catch (e) { refused = true; console.log(e.stdout); }
  assert.ok(refused);
  assert.equal((await db.query("SELECT name FROM customers WHERE id = 7")).rows[0].name, "Fixed by a human");
  console.log("✓ conflict detected, human's change kept\n");
  await db.query("UPDATE customers SET name = 'Customer 7' WHERE id = 7");

  // 3. Dry run: exact numbers, nothing changes.
  const before = await fingerprint();
  const d = await agent([["execute", { sql: "DELETE FROM customers WHERE last_seen < DATE '2026-10-01'" }]], ["--dry-run"]);
  console.log(d[0].text.split("\n").slice(0, 3).join("\n") + "\n");
  assert.match(d[0].text, /Would DELETE 412 rows/);
  assert.equal(await fingerprint(), before);
  console.log("✓ dry run reported 412 rows, database untouched\n");

  // 4. Tables without a primary key are refused, not silently untracked.
  await db.query("CREATE TABLE notes (body text)");
  const n = await agent([["execute", { sql: "INSERT INTO notes VALUES ('hi')" }]]);
  assert.ok(n[0].isError && /no primary key/.test(n[0].text));
  assert.equal(Number((await db.query("SELECT count(*) FROM notes")).rows[0].count), 0);
  console.log("✓ no-primary-key table refused, nothing written\n");

  console.log(retrace("verify"));
  console.log("Postgres tests passed.");
} finally {
  await db.end();
  await stop();
}
