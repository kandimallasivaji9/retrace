// npm run demo-db → a seeded Postgres 18 you can point Claude Desktop at. Ctrl+C to stop (data is thrown away).
import { startDemoDb } from "./demo-db-lib.mjs";

const port = Number(process.env.PORT ?? 54329);
const { url, stop } = await startDemoDb({ port });
console.log(`\nDemo database running (Postgres 18, 500 customers):\n\n  ${url}\n`);
console.log("Ctrl+C to stop. Everything is deleted when it stops.\n");
const quit = async () => { await stop(); process.exit(0); };
process.on("SIGINT", quit);
process.on("SIGTERM", quit);
setInterval(() => {}, 1 << 30);
