import { resolvePath } from "../fs-state.js";

/**
 * Adapter for @modelcontextprotocol/server-filesystem.
 * Tells the proxy which tool calls change files, and which paths they touch.
 */
export type Plan =
  | { kind: "read" }
  | { kind: "untracked" }
  | { kind: "tracked"; paths: string[] };

const READ_ONLY = new Set([
  "read_file", "read_text_file", "read_media_file", "read_multiple_files",
  "list_directory", "list_directory_with_sizes", "directory_tree",
  "search_files", "get_file_info", "list_allowed_directories",
]);

const MUTATING: Record<string, (args: any) => unknown[]> = {
  write_file: (a) => [a.path],
  edit_file: (a) => (a.dryRun ? [] : [a.path]),
  create_directory: (a) => [a.path],
  move_file: (a) => [a.source, a.destination],
};

export function classify(tool: string, args: any): Plan {
  if (READ_ONLY.has(tool)) return { kind: "read" };
  const pick = MUTATING[tool];
  if (!pick) return { kind: "untracked" };
  const paths = pick(args ?? {})
    .filter((p): p is string => typeof p === "string" && p.length > 0)
    .map(resolvePath);
  return paths.length ? { kind: "tracked", paths } : { kind: "read" };
}
