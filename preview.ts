import { promises as fs } from "node:fs";
import path from "node:path";
import { createTwoFilesPatch } from "diff";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Plan } from "./adapters/filesystem.js";
import { readState, resolvePath } from "./fs-state.js";

const TAG = "[retrace dry-run] Nothing was changed.";

/** Asks the upstream server which directories it allows, so previews never read outside them. */
export async function allowedDirectories(upstream: Client): Promise<string[]> {
  try {
    const res: any = await upstream.callTool({ name: "list_allowed_directories", arguments: {} });
    const text = (res.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n");
    const dirs = text.split("\n").map((l: string) => l.trim()).filter((l: string) => l.startsWith("/") || /^[A-Za-z]:\\/.test(l));
    return Promise.all(dirs.map((d: string) => fs.realpath(d).catch(() => d)));
  } catch {
    return [];
  }
}

/** Resolves symlinks on the deepest part of the path that exists. */
async function realish(p: string): Promise<string> {
  let cur = p;
  const tail: string[] = [];
  for (;;) {
    try {
      return path.join(await fs.realpath(cur), ...tail);
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return p;
      tail.unshift(path.basename(cur));
      cur = parent;
    }
  }
}

async function isAllowed(p: string, allowed: string[]): Promise<boolean> {
  const real = await realish(p);
  return allowed.some((d) => real === d || real.startsWith(d + path.sep));
}

function textOf(res: any): string {
  return (res?.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n");
}

/** Describes what a tool call would do, without doing it. */
export async function previewCall(
  upstream: Client,
  tool: string,
  args: Record<string, unknown>,
  plan: Plan,
  allowed: string[],
): Promise<string> {
  if (plan.kind !== "tracked") {
    return `${TAG} Blocked "${tool}": Retrace can't preview this tool yet, so it wasn't run.`;
  }
  for (const p of plan.paths) {
    if (!(await isAllowed(p, allowed))) return `${TAG} Would fail: ${p} is outside the allowed directories.`;
  }

  switch (tool) {
    case "edit_file": {
      // The filesystem server can preview edits itself and returns a diff.
      const res = await upstream.callTool({ name: tool, arguments: { ...args, dryRun: true } });
      return res.isError ? `${TAG} Would fail: ${textOf(res)}` : `${TAG} Planned edit:\n${textOf(res)}`;
    }
    case "write_file": {
      const [p] = plan.paths;
      const before = await readState(p);
      if (before.kind === "dir") return `${TAG} Would fail: ${p} is a directory.`;
      if (before.tooLarge) return `${TAG} Would overwrite ${p} (too large to diff).`;
      const old = before.kind === "file" ? Buffer.from(before.content!, "base64").toString("utf8") : "";
      const verb = before.kind === "absent" ? "create" : "overwrite";
      const patch = createTwoFilesPatch(p, p, old, String(args.content ?? ""), verb === "create" ? "(new file)" : "current", "planned");
      return `${TAG} Would ${verb} ${p}:\n${patch}`;
    }
    case "move_file": {
      const [src, dest] = plan.paths;
      if ((await readState(src, false)).kind === "absent") return `${TAG} Would fail: ${src} doesn't exist.`;
      if ((await readState(dest, false)).kind !== "absent") return `${TAG} Would fail: ${dest} already exists.`;
      return `${TAG} Would move ${src} → ${dest}.`;
    }
    case "create_directory": {
      const [p] = plan.paths;
      const s = await readState(p, false);
      if (s.kind === "dir") return `${TAG} ${p} already exists, no change.`;
      if (s.kind === "file") return `${TAG} Would fail: ${p} is a file.`;
      return `${TAG} Would create directory ${p}.`;
    }
    default:
      return `${TAG} Would run "${tool}" on ${plan.paths.map(resolvePath).join(", ")}.`;
  }
}
