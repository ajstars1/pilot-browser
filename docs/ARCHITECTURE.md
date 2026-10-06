# Architecture

pilot-browser lets an AI agent drive a browser the way a person does: it reads the page, clicks, types and uploads. The engine is exposed over MCP, so any MCP client (Claude Code, Cursor, Gemini CLI, your own agent) can use it.

## Principles

1. **Use the browser you already have.** No Chromium fork. Attach to the user's running, logged-in browser through the browser's own consent mechanism.
2. **The model proposes; the runtime decides.** Policy, approvals and verification are enforced in code, outside the model.
3. **Visible and interruptible.** A cursor and status pill show what the agent is doing, and the user can pause or take over at any time.
4. **Engine-neutral core.** No CDP or WebDriver BiDi types cross the `BrowserDriver` boundary.

## Two ways to connect

| Mode | When | How |
|---|---|---|
| **attach** | Supervised work in your real browser, with your logins | Chromium 144+ approval mode. You enable it once at `chrome://inspect/#remote-debugging` (also `brave://` and `edge://`). The browser writes `DevToolsActivePort` and asks Allow/Deny for each new connection. |
| **managed** | Unattended, scheduled, or untrusted sites | A dedicated browser on its own persistent profile. Log in once inside it. Supports a network allowlist. |

Never use `--remote-debugging-port` on a real profile:
- Google Chrome refuses it since version 136.
- Other Chromium builds, such as Brave, still accept it. They then expose the whole browser to any local process **without a prompt**.

## Layers

```
 MCP clients (Claude Code, Cursor, …)        your agent
          │ stdio                                │ in-process
          ▼                                      ▼
 @pilot-browser/mcp ───────────────► agent loop · policy · approvals · verifier · overlay · handoff
                                             │
                                     BrowserDriver (engine-neutral, capability flags)
                          ┌──────────────────┼────────────────────────┐
                AgentBrowserDriver      BidiDriver (planned)      ExtensionRelay (planned)
                (CDP via agent-browser)  (Firefox, WebDriver BiDi)  (chrome.debugger + native messaging)
                          │                  │                        │
                 Chrome / Brave / Edge     Firefox                Chrome / Brave / Edge
```

## Observations and refs

- **Observation:** an accessibility snapshot with a ref on each actionable element:
  - roles and names;
  - role-less clickable elements, such as `<div onclick>`, which a plain accessibility tree misses;
  - cross-origin iframe content, inlined.
- **Every action quotes its `observationId`.** If the page has changed since, the driver returns `stale_ref` instead of clicking the wrong thing.
- **The rendered tree is the source of truth** for names. In the spike, agent-browser's JSON ref map dropped names for role-less elements.
- **Snapshots are clipped to the viewport by default** and report how many elements were omitted. In the spike fixture, 163 refs were emitted while only 5 interactive elements were in the viewport. The driver fetches every ref's box in one batched round-trip (~0.2 s for 160 refs). Main-frame boxes are viewport-relative; iframe children are frame-relative and get the iframe's offset.

## Safety model

- **Tab ownership:** the agent acts only in tabs it opened, and never adopts yours.
- **Origin policy:** every navigation and the resulting URL after every action are checked against a per-task allowlist. In attach mode the engine itself has no network allowlist, so pilot-browser enforces this.
- **Consequential actions** (submit, send, purchase, upload, delete) need an approval bound to a hash of the payload.
- **Cross-origin rule:** data read on origin A can't be sent to origin B without approval.
- **Model input:**
  - Page content is data, never instructions.
  - Secrets are passed by reference, and files by artifact id.
  - No `eval` or cookie tools by default.
- **Disconnect after every run.** Attach mode grants whole-browser control while connected.

## Platform support

| Platform | attach | managed | Notes |
|---|---|---|---|
| Linux | ✅ verified (Chrome 154) | ✅ verified | |
| macOS | expected | expected | Not yet tested |
| Windows (native) | expected | expected | agent-browser ships win32 builds and CI. Discovery covers Chrome, Brave and Edge under `%LOCALAPPDATA%`. Spawn the `.exe` directly, never a `.cmd` shim. |
| WSL2 + Windows browser | needs `networkingMode=mirrored` | Chrome inside WSL works | In the default NAT mode, WSL cannot reach Windows `127.0.0.1`. |

### MCP client config on Windows

Prefer calling `node` directly so that no `.cmd` shim is involved:

```json
{ "mcpServers": { "pilot-browser": { "command": "node", "args": ["C:\\path\\to\\node_modules\\@pilot-browser\\mcp\\dist\\server.js"] } } }
```

If you launch it with `npx` on native Windows, wrap it:

```json
"command": "cmd", "args": ["/c", "npx", "-y", "@pilot-browser/mcp"]
```

## Firefox

| | Status |
|---|---|
| Protocol | Firefox removed CDP (fully gone in 141). It speaks **WebDriver BiDi**, so it needs a separate `BidiDriver`. |
| managed mode | Feasible. Verified on Firefox 158 over raw BiDi: trusted input, file upload, cross-origin frames, screenshots, network interception, and preload scripts. |
| Limits | BiDi exposes **no accessibility tree**, so it has to be computed in the page. Only **one BiDi session** is allowed per browser. |
| attach mode | Today it needs a restart with `--remote-debugging-port`, and there's no consent prompt. A consent-based "remote control for AI assistants" path exists behind a pref in Firefox 158 source, but it is unreleased. |
| Extensions | Firefox has no `chrome.debugger`, so an extension relay isn't viable there. |

## Roadmap

1. ✅ `AgentBrowserDriver` and `@pilot-browser/mcp` (attach + managed, viewport-clipped observations, origin policy, upload jail, overlay status pill).
2. Interaction lease and human handoff (pause when the user touches the tab; `browser_handoff`).
3. Managed mode, policy engine, injection test suite.
4. `BidiDriver` for Firefox (managed first).
5. Optional extension relay transport.
