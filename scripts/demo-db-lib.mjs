// Starts a throwaway Postgres 18 (no install needed) and seeds the demo `customers` table.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";

export const SEED_SQL = `
CREATE TABLE customers (
  id         serial PRIMARY KEY,
  name       text NOT NULL,
  email      text NOT NULL UNIQUE,
  plan       text NOT NULL,
  mrr        numeric(10,2) NOT NULL,
  active     boolean NOT NULL,
  last_seen  date NOT NULL
);
-- 500 customers. 88 logged in this month. 412 haven't, but many of those still pay.
INSERT INTO customers (name, email, plan, mrr, active, last_seen)
SELECT 'Customer ' || g,
       'customer' || g || '@example.com',
       (ARRAY['free','pro','team','enterprise'])[1 + g % 4],
       CASE g % 4 WHEN 0 THEN 0 WHEN 1 THEN 29 WHEN 2 THEN 99 ELSE 499 END,
       g <= 88 OR g % 3 = 0,
       CASE WHEN g <= 88 THEN DATE '2026-11-01' + (g % 9) ELSE DATE '2026-09-01' - (g % 300) END
FROM generate_series(1, 500) g;
`;

export async function startDemoDb({ port = 54000 + Math.floor(Math.random() * 1000), seed = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "retrace-demo-db-"));
  const db = new EmbeddedPostgres({
    databaseDir: dir,
    user: "retrace",
    password: "retrace",
    port,
    persistent: false,
    createPostgresUser: process.getuid?.() === 0,
    onLog: () => {},
    onError: () => {},
  });
  await db.initialise();
  await db.start();
  await db.createDatabase("demo");
  const url = `postgres://retrace:retrace@localhost:${port}/demo`;
  if (seed) {
    const c = new pg.Client({ connectionString: url });
    await c.connect();
    await c.query(SEED_SQL);
    await c.end();
  }
  return { url, stop: () => db.stop() };
}
