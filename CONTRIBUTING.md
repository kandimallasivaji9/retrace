# Contributing to Retrace

Thanks for helping make AI agents safer to use. New here? Pick an issue labeled [`good first issue`](https://github.com/kandimallasivaji9/retrace/labels/good%20first%20issue). Each one has context and a clear definition of done.

## Setup

```bash
git clone https://github.com/kandimallasivaji9/retrace.git && cd retrace
npm install
npm test
```

`npm test` runs everything end to end: a real MCP client, the real filesystem server, and a throwaway Postgres 18 that downloads with `npm install`. You don't need to install a database.

## How the code is laid out

| File | What it does |
|---|---|
| `src/proxy.ts` | Wraps any MCP server and snapshots files before and after each change |
| `src/adapters/filesystem.ts` | Decides which filesystem tool calls change files |
| `src/pg-server.ts` | Retrace's own Postgres MCP server |
| `src/journal.ts` | The hash-chained SQLite log |
| `src/undo.ts`, `src/pg-undo.ts` | Undo, with conflict checks |
| `src/preview.ts` | Dry-run previews |

## Making a change

1. Comment on the issue so nobody duplicates work.
2. Keep each PR focused on one thing.
3. Add or update a test in `tests/`. Undo bugs are the worst kind of bug here, so every change to what gets recorded or restored needs a test.
4. Run `npm test` before pushing.

## Ground rules for undo

- Never overwrite a change made after the agent. Detect it and report a conflict.
- If Retrace can't undo something, refuse or say so clearly. Never record an action as undoable when it isn't.

## Reporting bugs

Use the issue templates. For security issues, see [SECURITY.md](SECURITY.md) instead of opening a public issue.
