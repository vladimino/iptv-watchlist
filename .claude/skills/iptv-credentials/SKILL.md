---
name: iptv-credentials
description: Where the owner's local credentials for IPTV Watchlist operations live (R2 read-only export, R2 install writer, D1 backfill, metadata cache production operator) and how a session loads them. Use before any script that needs R2_SNAPSHOT_*, R2_INSTALL_* or D1_BACKFILL_* so the session never asks the owner for a key again and never prints one.
---

# Credentials: one env file per credential, known to both sides

The owner keeps each credential in a file under `~/.config/iptv/` on their machine and edits that file; the agent never asks for a value in chat and never writes a value anywhere else. Values are never printed, logged, committed or pasted into Trello, GitHub or evidence; only the variable **names** and `set`/`missing` are reported.

| File | Variables | Used by |
| --- | --- | --- |
| `~/.config/iptv/r2-snapshot.env` | `R2_SNAPSHOT_ACCOUNT_ID`, `R2_SNAPSHOT_ACCESS_KEY_ID`, `R2_SNAPSHOT_SECRET_ACCESS_KEY` (optional `R2_SNAPSHOT_BUCKET`, default `iptv`) | `scripts/r2-snapshot-export.mjs`, `discovery-ledger-split.mjs`, `discovery-ledger-install.mjs --dry-run` (bucket-scoped **Object Read only** token) |
| `~/.config/iptv/r2-install.env` | `R2_INSTALL_ACCESS_KEY_ID`, `R2_INSTALL_SECRET_ACCESS_KEY` (optional `R2_INSTALL_ACCOUNT_ID`, otherwise `R2_SNAPSHOT_ACCOUNT_ID`) | `scripts/discovery-ledger-install.mjs --apply` (bucket-scoped **Object Read & Write** token; a separate token from the read-only one) |
| `~/.config/iptv/d1-backfill.env` | `D1_BACKFILL_ACCOUNT_ID`, `D1_BACKFILL_API_TOKEN`, `D1_BACKFILL_SCRATCH_DATABASE_ID` | `scripts/d1-backfill.mjs`, `scripts/d1-scratch-g4.mjs` |
| `~/.config/iptv/d1-backfill.env` and `~/.config/iptv/r2-snapshot.env` | `D1_BACKFILL_ACCOUNT_ID`, `D1_BACKFILL_API_TOKEN`, optional `D1_BACKFILL_DATABASE_ID` (the production uuid, or empty); from the snapshot file, `R2_SNAPSHOT_ACCOUNT_ID`, `R2_SNAPSHOT_ACCESS_KEY_ID`, `R2_SNAPSHOT_SECRET_ACCESS_KEY` (optional `R2_SNAPSHOT_BUCKET`, default `iptv`) | `scripts/metadata-cache-production.mjs` only. It does not read `D1_BACKFILL_SCRATCH_DATABASE_ID`. A value left in the environment is ignored. The scratch id stays required for the two scripts in the row above. |

## Procedure

1. If the file is missing, create it with placeholders (empty values, one `NAME=` per line, mode `600`) and tell the owner which file to fill. Do not wait in chat for values.
2. Load it into the command's environment only, never into the shell profile: `set -a; . ~/.config/iptv/<file>.env; set +a; node scripts/<script>.mjs …` in one command.
3. Before running, report presence only: `for v in …; do [ -n "${!v}" ] && echo "$v set" || echo "$v missing"; done`.
4. Behind an HTTPS proxy (a cloud container) add `NODE_USE_ENV_PROXY=1`, or Node's `fetch` ignores the proxy and the run fails as `network`.
5. In a cloud session the owner sets the same variable names in the environment settings instead of a file; a new session is needed for new variables to appear. Check the environment first, the file second.
6. `R2_SNAPSHOT_ACCOUNT_ID` and `D1_BACKFILL_ACCOUNT_ID` are the same account id; either may be copied from the other.

Each production run still needs its own owner approval (export, install, backfill): the file holds the key, not the permission.
