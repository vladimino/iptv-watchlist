# Historical AIR-62 MCP unattended-authorization checklist

> **Historical criteria only.** AIR-62 has already been accepted; these checks are not a command to rerun probes, revoke sessions or write production R2. Consult the card's recorded evidence and current task status.

## Historical AIR-62 unattended authorization checklist

The checklist below was originally drafted when only interactive MCP sign-in was proven. **It is historical acceptance material, not instructions to enable or rerun production Tasks.** [AIR-62](https://trello.com/c/CU71gW4c) was accepted on 21 October after actual scheduled EPG and prediction work. Consult the card's evidence before claiming that any specific revocation, lease or refresh test passed; this document update does not repeat those tests. Creating or modifying Tasks, calling writers, and revoking credentials still require owner approval.

Original verification requirements:

1. A dedicated probe-only Scheduled Task calls `probe_read`, then `probe_echo` with a per-run marker such as the run timestamp. Several consecutive real scheduled runs return matching results, with no confirmation prompt and no sign-in.
2. The runs span longer than the Access token lifetime. ChatGPT must then renew the access token with its refresh token, unattended. Access re-evaluates the `IPTV MCP` policy on every refresh.
3. Throughout the same period, an anonymous request (procedure step 1) still gets `401` from Access.
4. Revocation, with separate approval: remove the owner from the `IPTV MCP` policy or revoke the owner's Access sessions. Once the current access token expires, the next scheduled run must fail to authorize. Restoring access must require a new interactive sign-in. Also record what happens when the grant session expires.
5. Disable or delete the probe tasks afterwards unless their continued schedule is approved.

`probe_echo` proves an authenticated MCP HTTP POST round trip. It does not prove a write to storage followed by a read back. At that time, an isolated write/read/cleanup test was an independent owner approval gate. It must target an isolated temporary key, for example under a dedicated prefix, clean up explicitly, and leave production state untouched. That test needs its own design and approval. A key in bucket `iptv` is still a production R2 write, and this change adds no such tool.

