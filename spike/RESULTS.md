# Day-1 spike results (2026-10-06)

- **Setup:** Linux x64, Node 24.11.1, Google Chrome 154.0.8037.97, agent-browser 0.38.2 (pinned).
- **Re-run it:** `npm run spike:managed`, and `npm run spike:attach -- chrome` after enabling `chrome://inspect/#remote-debugging`.
- Raw JSON lands in `spike/out/` (git-ignored).

## Part 1: managed browser (throwaway profile), 15/15 passing

| Check | Result |
|---|---|
| Launch + open fixture | 947 ms cold start |
| Interactive snapshot | 7,221 chars, 163 refs, 165 ms |
| Trusted click | `isTrusted=true` |
| Role-less `<div onclick>` found and clicked | ref `e3`, `isTrusted=true` |
| File upload (`DOM.setFileInputFiles`) | ✅ |
| Native `<select>` | ✅ |
| Cross-origin iframe: fill + click | ✅ |
| `confirm()` dialog | Surfaced as `hasDialog: true`, not silently accepted; dismissed it on purpose |
| Cursor overlay | Visible in the screenshot, absent from the accessibility snapshot |
| Hidden prompt-injection text | **Reaches the model** in a full snapshot, so the policy layer is required |
| Delta snapshot with no change | ~50 chars |
| Viewport | 163 refs emitted; only 5 interactive elements actually in the viewport |
| MCP server (`agent-browser mcp --tools core`) | Protocol 2025-11-25, 29 tools, open + snapshot via `tools/call` |

## Part 2: attach to the real, running Chrome (approval mode), 8/9 passing

| Check | Result |
|---|---|
| Endpoint discovery | Read from `DevToolsActivePort` (port 9222) |
| Attach + open fixture in a **new** tab (`--pin-tab`) | 6 s, including the human clicking **Allow** |
| Snapshot / trusted click / upload / cross-origin iframe | All ✅ in the real profile |
| Follow-up commands | Reuse the daemon's single connection (52 ms), no second prompt |
| `close` | Detaches only; the browser stays open |
| Read-only login check on github.com/notifications | ❌ A sign-in prompt was visible. Either that Chrome profile isn't logged in to GitHub, or the heuristic is too crude. Re-run with a site you're logged into. |

## Findings that change the design

1. **Parse the rendered tree, not the JSON ref map.** agent-browser 0.38.2's `refs` JSON gives role-less clickable elements an empty `name`. `@pilot-browser/core` `parseSnapshotTree` handles this, and is tested against the captured snapshot.
2. **Viewport clipping is mandatory.** Whole-page snapshots carried 163 refs when 5 were on screen.
3. **The overlay must be top-frame aware.** The first prototype drew a second status pill inside the iframe. Fixed: subframes get a cursor only, which fades after 1.2 s.
4. **Never block the event loop while driving the browser.** The first run deadlocked: synchronous `execFileSync` stalled the in-process fixture server, so `Page.navigate` timed out. Drivers must be fully async.
5. **Use `open` with `--pin-tab` for attach.** With pinning, the first attach opens a fresh tab instead of adopting one of the user's tabs.
6. **The approval prompt is per connection, not per command.** One long-lived daemon connection gives one prompt per run.
