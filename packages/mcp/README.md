# @pilot-browser/mcp

MCP server that lets AI agents drive **your real, logged-in browser** (Chrome, Brave, Edge), with a visible cursor, human takeover, handoff for logins and 2FA, and approvals for anything consequential.

```bash
claude mcp add pilot-browser -- npx -y @pilot-browser/mcp
```

1. In your browser, open `chrome://inspect/#remote-debugging` and tick **Allow remote debugging for this browser instance** (one time).
2. Ask your agent to use pilot-browser; click **Allow** when the browser asks.

Configuration (env): `PILOT_UPLOAD_DIR`, `PILOT_APPROVALS`, `PILOT_APPROVAL_TIMEOUT`, `PILOT_PROFILE_DIR`, `PILOT_CHROME`.

Full docs, tool list and security model: https://github.com/ajstars1/pilot-browser

Apache-2.0.
