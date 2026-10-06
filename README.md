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

## Development

```bash
npm install
npm run typecheck && npm test
npm run spike:managed            # engine checks in a throwaway browser
npm run spike:attach -- chrome   # needs chrome://inspect/#remote-debugging enabled; click Allow
```

Requires Node 22+.

## Acknowledgements

The browser engine is [vercel-labs/agent-browser](https://github.com/vercel-labs/agent-browser) (Apache-2.0).

## License

[Apache-2.0](LICENSE)
