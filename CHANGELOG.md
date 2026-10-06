# Changelog

## 0.1.0 (2026-10-07)

First public release.

- **MCP server** (`@pilot-browser/mcp`) with 15 `browser_*` tools.
- **Attach** to your running Chrome, Brave or Edge through Chromium 144+ approval mode, or use a **managed** browser on a dedicated profile.
- **Observations:** viewport-clipped accessibility snapshots with refs, an `observationId` on every action, and stale-ref protection.
- **In-tab overlay:** live cursor and status pill with **Pause / Hand back / Stop**. The agent is blind while you have control.
- **Handoff** for logins, 2FA and CAPTCHAs (`browser_handoff`, `browser_wait_for_user`).
- **Approvals** for consequential actions (POST form submits, risky wording, uploads, typing text copied from another site), bound to the page and single-use.
- **Origin allowlist:** checked before navigation, before clicks with a known destination (live DOM), and after every action.
- **Untrusted-content marking** that page text can't break out of. Upload folder jail.
- **Prompt-injection suite:** 11 attacks played by a compromised scripted agent against real Chrome in CI. See [docs/SECURITY.md](docs/SECURITY.md) for results and known limits.
