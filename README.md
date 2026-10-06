# pilot-browser

**Let AI agents drive your real, logged-in browser — with a visible cursor, approvals, and human takeover. MCP-native.**

> Status: early development. The day-1 spike passes against a real Chrome 154 ([results](spike/RESULTS.md)); the packages are being built now. Not ready for use.

Most browser agents either run a fresh headless browser that has none of your logins, or require a forked browser. pilot-browser attaches to the Chrome, Brave or Edge you already use through the browser's own consent prompt (Chromium 144+ approval mode). The agent works in a tab of its own, and you watch it move.

- **Your browser, your sessions:** no fork, no profile copying.
- **Visible:** a live cursor and a status pill show every action; pause or take over at any time.
- **Safe by construction:** origin policy, approvals for consequential actions and verification are enforced outside the model.
- **MCP-native:** use it from Claude Code, Cursor, Gemini CLI, or your own agent.
- **Unattended mode:** a managed browser on a dedicated profile for scheduled or untrusted work.

## Supported

| | Chrome / Brave / Edge | Firefox |
|---|---|---|
| Linux / macOS / Windows | attach + managed | managed (planned, WebDriver BiDi) |

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the design, platform notes (including WSL) and roadmap.

## Use it from Claude Code (from source, until the first npm release)

```bash
git clone https://github.com/ajstars1/pilot-browser && cd pilot-browser
npm install && npm run build
claude mcp add pilot-browser -- node "$PWD/packages/mcp/dist/bin.js"
```

Then:

1. Open Chrome (or Brave/Edge), visit `chrome://inspect/#remote-debugging`, and tick **Allow remote debugging for this browser instance**.
2. Ask Claude something like *"Using pilot-browser, open github.com/notifications and summarize my unread notifications"*.
3. Claude calls `browser_connect` with the sites it needs. Your browser shows an **Allow** dialog; click it.
4. Watch the agent work in its own tab. The purple cursor and status pill show each step.

On native Windows, use `node` with the full path to `bin.js` as above. On WSL with a Windows browser, you need [mirrored networking](docs/ARCHITECTURE.md#platform-support).

| Env var | Effect |
|---|---|
| `PILOT_UPLOAD_DIR` | Folder the agent may upload files from. Uploads are disabled when unset. |
| `PILOT_PROFILE_DIR` | Where managed-mode profiles live (default `~/.pilot-browser/profiles`). |
| `PILOT_CHROME` | Browser binary for managed mode. |

### Tools

`browser_connect`, `browser_disconnect`, `browser_navigate`, `browser_read_page`, `browser_click`, `browser_type`, `browser_select`, `browser_check`, `browser_press_key`, `browser_scroll`, `browser_upload`, `browser_dialog`, `browser_screenshot`.

- **Fresh pages only:** every action quotes the `observationId` of the page it was planned on, so the agent can't click based on a stale page.
- **Allowed origins:** navigation is limited to the `allowedOrigins` given at connect. A click that lands elsewhere resets the tab.
- **Untrusted content:** page text reaches the model wrapped as untrusted content.

## Packages

| Package | What it is |
|---|---|
| `@pilot-browser/core` | Engine-neutral driver contract, endpoint discovery, snapshot parsing, origin policy, overlay |
| `@pilot-browser/driver-agent-browser` | Chromium driver built on agent-browser (CDP) |
| `@pilot-browser/mcp` | The MCP server (`pilot-browser-mcp`) |

## Development

```bash
npm install
npm run build && npm run typecheck && npm test
npm run test:e2e                 # real headless Chrome: driver + MCP over stdio
npm run spike:attach -- chrome   # your real browser; needs the remote-debugging switch, click Allow
```

Requires Node 22+.

## Acknowledgements

The browser engine is [vercel-labs/agent-browser](https://github.com/vercel-labs/agent-browser) (Apache-2.0).

## License

[Apache-2.0](LICENSE)
