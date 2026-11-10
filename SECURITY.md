# Security

Retrace sits between AI agents and your data, so security reports matter a lot.

Please report vulnerabilities privately through GitHub: **Security → Report a vulnerability** on this repo. Don't open a public issue.

Useful things to include: what an agent (or a malicious prompt) could make Retrace do, and the steps to reproduce it.

## What Retrace stores

The journal at `~/.retrace/journal.db` contains before-state snapshots: file contents and database rows the agent changed. Treat it like the data it protects. Database passwords are never written to it.
