# @pilot-browser/core

Engine-neutral building blocks of [pilot-browser](https://github.com/ajstars1/pilot-browser):

- `BrowserDriver` contract with capability flags
- endpoint discovery for Chrome / Brave / Edge / Chromium (Linux, macOS, Windows, WSL) and Firefox
- snapshot parsing, the `InteractionLease` state machine, and the in-page overlay
- origin policy, action risk assessment and cross-origin taint tracking

Most users want the MCP server: [`@pilot-browser/mcp`](https://www.npmjs.com/package/@pilot-browser/mcp). Apache-2.0.
