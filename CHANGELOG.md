# Changelog

## Unreleased

- **Hung browsers no longer poison later sessions.**
  - A command that never returns used to block every later command in its session. The driver now checks after a timeout. If the session no longer answers, it closes the session's daemon and (managed mode) its browser, and reports "The browser stopped responding".
  - `browser_disconnect` now always stops the session's agent-browser daemon. The daemon used to outlive `close`, and a stuck one kept the managed profile locked, so every later launch failed with "Chrome exited early".
  - Managed `browser_connect` takes back a profile held by a hung or orphaned pilot-browser session. It never takes a profile from a session that still answers, or from a browser it didn't start; those get a clear error instead.

## 0.2.0 (2026-10-07)

- **Approval modes:** `manual`, `supervised` (default), `auto` and `full-auto`.
  - Risks are now graded `write` (submit, upload, send) or `high` (pay, delete, transfer, destructive dialogs, cross-site copies).
  - `auto` lets submits and uploads run unattended and still asks for high-risk steps.
- **Settings file** `~/.pilot-browser/config.json` with `npx @pilot-browser/mcp config [set|unset] …`.
  - Re-read on every `browser_connect`, so no client restart is needed.
  - Env vars still override it. `PILOT_APPROVALS=off` maps to `full-auto`.
- **`uploadDir` can now be set in the config file,** so uploads work without re-registering the MCP server.
- **The server now reports its real package version** to MCP clients.
- **README demo GIF,** recorded by `npm run demo:record` against a fictional job form.

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
