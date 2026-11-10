import { promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";

/** A snapshot of one path, before or after an agent touched it. */
export interface PathState {
  path: string;
  kind: "absent" | "file" | "dir";
  hash: string;
  /** base64 file contents; only stored in "before" snapshots */
  content?: string;
  tooLarge?: boolean;
}

const MAX_SNAPSHOT_BYTES = 10 * 1024 * 1024;

export const sha256 = (data: Buffer | string) =>
  createHash("sha256").update(data).digest("hex");

export function resolvePath(p: string): string {
  if (p === "~" || p.startsWith("~/")) p = path.join(os.homedir(), p.slice(1));
  return path.resolve(p);
}

export async function readState(p: string, withContent = true): Promise<PathState> {
  try {
    const st = await fs.stat(p);
    if (st.isDirectory()) return { path: p, kind: "dir", hash: "dir" };
    if (st.size > MAX_SNAPSHOT_BYTES) {
      return { path: p, kind: "file", hash: `large:${st.size}:${st.mtimeMs}`, tooLarge: true };
    }
    const buf = await fs.readFile(p);
    return {
      path: p,
      kind: "file",
      hash: sha256(buf),
      content: withContent ? buf.toString("base64") : undefined,
    };
  } catch (err: any) {
    if (err.code === "ENOENT") return { path: p, kind: "absent", hash: "absent" };
    throw err;
  }
}

/** Put a path back exactly the way a "before" snapshot recorded it. */
export async function restoreState(s: PathState): Promise<void> {
  if (s.kind === "file") {
    if (s.tooLarge || s.content === undefined) {
      throw new Error(`${s.path} was too large to snapshot, can't restore it`);
    }
    await fs.mkdir(path.dirname(s.path), { recursive: true });
    await fs.writeFile(s.path, Buffer.from(s.content, "base64"));
  } else if (s.kind === "absent") {
    const current = await readState(s.path, false);
    if (current.kind === "file") await fs.unlink(s.path);
    else if (current.kind === "dir") await fs.rmdir(s.path); // only if empty, on purpose
  } else {
    await fs.mkdir(s.path, { recursive: true });
  }
}
