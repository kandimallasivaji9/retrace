# Retrace demo script

**Goal:** a 15–20 second GIF for the top of the README. One story: the agent makes a mistake, one command fixes it.

## The story

The agent is asked to "archive inactive customers." It deletes **412 rows** instead, including active ones. `retrace undo` brings them all back.

This is a staged reenactment, so label it that way in the launch post. Don't present it as a real incident.

## Setup (before recording)

1. `npm run demo-db` in one terminal: a throwaway Postgres 18 with 500 customers (88 active this month).
2. Claude Desktop pointed at `retrace postgres --url postgres://retrace:retrace@localhost:54329/demo`.
3. `export RETRACE_PG_URL=postgres://retrace:retrace@localhost:54329/demo` in the terminal you record.
3. A large terminal font (18–20pt), dark theme, about 100×28 columns.

## Shot list

| Time | On screen | Why |
|---|---|---|
| 0–3s | `SELECT count(*) FROM customers;` → **500** | Sets the baseline |
| 3–7s | Agent prompt: *"Clean up customers who haven't logged in since October."* Agent runs a `DELETE`. | The mistake (it deletes paying customers too) |
| 7–9s | Count again → **88**. Pause one beat. | The "oh no" moment |
| 9–12s | `retrace log` shows one red `DELETE … 412 rows` line | Shows Retrace saw it |
| 12–15s | `retrace undo --run` → `✓ restored 412 rows` | The payoff |
| 15–18s | Count again → **500** | Proof |

## Recording with vhs

Save as `demo.tape`, then run `vhs demo.tape`:

```
Output docs/demo.gif
Set FontSize 20
Set Width 1200
Set Height 600
Set Theme "Catppuccin Mocha"

Type "psql -c 'SELECT count(*) FROM customers;'" Enter
Sleep 2s
Type "# agent: archive inactive customers" Enter
Sleep 1s
Type "./agent-run.sh" Enter
Sleep 3s
Type "psql -c 'SELECT count(*) FROM customers;'" Enter
Sleep 2s
Type "retrace log" Enter
Sleep 2s
Type "retrace undo --run" Enter
Sleep 2s
Type "psql -c 'SELECT count(*) FROM customers;'" Enter
Sleep 3s
```

`agent-run.sh` replays a recorded agent session so the GIF is deterministic. No live model call during recording.

## Checklist

- [ ] Under 5 MB, under 20 seconds
- [ ] Readable on a phone screen
- [ ] The numbers 500 → 88 → 500 are visible without zooming
- [ ] Same clip as an MP4 for X and LinkedIn, where GIFs get compressed
