# Good first issues

Paste each one into GitHub as a new issue and add the `good first issue` label.

---

## 1. `retrace log --json`

**Context:** `retrace log` prints a human-readable table. Scripts and future UIs need structured output.

**Done when:** `retrace log --json` prints the run's entries as a JSON array (id, step, ts, tool, status, target), and a test covers it.

---

## 2. Show relative paths when log is run outside the agent's folder

**Context:** `retrace log` shortens paths only when you run it inside the folder the agent worked in. Elsewhere you get long absolute paths.

**Done when:** paths are shown relative to the common folder of the run's entries, with the folder printed once in the header.

---

## 3. Forward MCP roots from the client to the wrapped server

**Context:** The filesystem server logs "Client does not support MCP Roots" when wrapped, because Retrace's client doesn't advertise roots.

**Done when:** Retrace passes the agent's roots through to the upstream server, and the warning disappears when the agent supports roots.

---

## 4. `retrace undo --dry-run`

**Context:** Before undoing, it's useful to see what would be restored.

**Done when:** `retrace undo --run --dry-run` lists each action it would undo and any conflicts, without changing anything.

---

## 5. Test with Claude Code and Cursor

**Context:** Retrace is tested with Claude Desktop. Other MCP clients should work but haven't been verified.

**Done when:** setup instructions for Claude Code and/or Cursor are added to the README, tested by you, with a screenshot in the PR.

---

## 6. Friendlier error when Postgres is older than 18

**Context:** Retrace refuses to start on Postgres < 18, which is correct, but users may not know how to upgrade.

**Done when:** the error links to upgrade docs and suggests `npm run demo-db` for trying Retrace.
