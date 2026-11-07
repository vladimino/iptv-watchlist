---
name: cloudflare-access-read
description: How a session reads the Access-protected production Worker (for example GET /api/monitor/status) with cloudflared and an owner-approved Access login, without printing the token. Use whenever a check needs an HTTP read of https://iptv.vladimino.workers.dev that no MCP tool covers.
---

# Reading the Access-protected Worker from a session

The whole Worker (not only `/mcp`) sits behind Cloudflare Access. A session has no Access token by default, so a plain `curl` gets a redirect or 302. The owner signs in once per session; the token then lives in the container for about 24 hours.

## What is authorized

- **Read-only GETs whose side effects are proven none.** `GET /api/monitor/status` is one (see `tests/get-side-effects.mjs`). `GET /api/programme` and `GET /api/watchlist` can repair mirrors in D1 EPG mode and are **not** safe reads. `GET /api/events` is not a presumed read-only probe either. Check `tests/get-side-effects.mjs` before any other path; a path that is not listed there is L2/L3 until verified and approved.
- The login itself changes nothing in Cloudflare. Everything else (POST routes such as `/api/monitor/test`, flags, secrets) still needs its own action-specific owner approval.

## Procedure

1. `cloudflared` is normally installed (`cloudflared --version`); if not, install the release binary for the container architecture. The container proxy needs `SSL_CERT_FILE=/root/.ccr/ca-bundle.crt`.
2. Start the login **in the background with its output in a file**, and read only the link line. `cloudflared` prints the issued token to stdout after the owner signs in, so the log file is a credential: never `cat`, `tail` or `head` it.

   ```bash
   LOG="$SCRATCH/access-login.log"   # the session scratchpad
   (SSL_CERT_FILE=/root/.ccr/ca-bundle.crt cloudflared access login --no-verbose https://iptv.vladimino.workers.dev/ > "$LOG" 2>&1 &)
   sleep 8; grep -m1 '^https://' "$LOG"
   ```

3. Give the owner that one link. It is single use and opens the standard Cloudflare Access page for the CLI; the owner signs in as for the Worker. Leave `cloudflared` running; the token arrives in `~/.cloudflared/` by itself.
4. When the owner says they signed in, **delete the log at once** (`shred -u "$LOG"`), then read with the token passed in a header and never printed:

   ```bash
   export SSL_CERT_FILE=/root/.ccr/ca-bundle.crt
   T=$(cloudflared access token -app=https://iptv.vladimino.workers.dev/ 2>/dev/null)
   curl -sS --max-time 30 -H "cf-access-token: $T" https://iptv.vladimino.workers.dev/api/monitor/status; unset T
   ```

5. A 302 or an Access HTML page instead of JSON means the token is missing or expired: repeat from step 2.

## Never

- Print, log, commit or paste the token, the login log or the full `cf-access-token` header into chat, Trello, GitHub or evidence. A leak is reported to the owner at once (the token expires, but say so and remove the file).
- Send any request that writes or starts work (POST, a repair-capable GET) without an action-specific owner approval given in chat.
- Weaken or bypass Access, or point the token at another host.
