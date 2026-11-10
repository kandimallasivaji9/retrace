import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { classify } from "./adapters/filesystem.js";
import { readState } from "./fs-state.js";
import { Journal } from "./journal.js";
import { allowedDirectories, previewCall } from "./preview.js";
import { VERSION } from "./version.js";

const log = (msg: string) => process.stderr.write(`[retrace] ${msg}\n`);

/**
 * Sits between the agent and a real MCP server.
 * The agent sees the same tools; every change gets a before/after snapshot in the journal.
 */
export async function startProxy(command: string, args: string[], opts: { journal?: string; dryRun?: boolean } = {}) {
  const journal = new Journal(opts.journal);
  const runId = randomUUID();

  const upstream = new Client({ name: "retrace", version: VERSION });
  await upstream.connect(
    new StdioClientTransport({ command, args, env: process.env as Record<string, string>, stderr: "inherit" }),
  );
  const upstreamName = upstream.getServerVersion()?.name ?? command;
  const allowed = opts.dryRun ? await allowedDirectories(upstream) : [];

  const server = new Server(
    { name: `retrace(${upstreamName})`, version: VERSION },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async (req) => upstream.listTools(req.params));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: toolArgs = {} } = req.params;
    const plan = classify(name, toolArgs);

    if (plan.kind === "read") return (await upstream.callTool(req.params)) as any;

    if (opts.dryRun) {
      const text = await previewCall(upstream, name, toolArgs, plan, allowed);
      journal.record({
        runId, tool: name, args: toolArgs,
        reversibility: plan.kind === "tracked" ? "reversible" : "untracked",
        before: null, after: null, isError: false, planned: true,
      });
      return { content: [{ type: "text", text }] };
    }

    if (plan.kind === "untracked") {
      const result = await upstream.callTool(req.params);
      journal.record({ runId, tool: name, args: toolArgs, reversibility: "untracked", before: null, after: null, isError: !!result.isError });
      return result as any;
    }

    const before = await Promise.all(plan.paths.map((p) => readState(p)));
    let result: any;
    let failure: unknown;
    try {
      result = await upstream.callTool(req.params);
    } catch (err) {
      failure = err;
    }
    const after = await Promise.all(plan.paths.map((p) => readState(p, false)));

    // Only journal calls that actually changed something.
    if (after.some((s, i) => s.hash !== before[i].hash)) {
      journal.record({ runId, tool: name, args: toolArgs, reversibility: "reversible", before, after, isError: !!failure || !!result?.isError });
    }
    if (failure) throw failure;
    return result;
  });

  const shutdown = async () => {
    await upstream.close().catch(() => {});
    journal.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  server.onclose = shutdown;

  await server.connect(new StdioServerTransport());
  log(`wrapping ${upstreamName}, run ${runId.slice(0, 8)}${opts.dryRun ? " (DRY RUN: nothing will be changed)" : ""}`);
}
