# @pilot-browser/driver-agent-browser

[pilot-browser](https://github.com/ajstars1/pilot-browser) driver for Chromium browsers (Chrome, Brave, Edge), built on [agent-browser](https://github.com/vercel-labs/agent-browser).

- **attach**: drive the user's running browser through Chromium 144+ approval mode, in a tab of its own.
- **managed**: launch a browser on a dedicated persistent profile.

It provides:
- viewport-clipped accessibility observations with stale-ref protection;
- the in-page overlay and interaction lease (Pause / Hand back / Stop);
- handoff and approvals.

```ts
import { AgentBrowserDriver } from '@pilot-browser/driver-agent-browser';
import { discoverEndpoints } from '@pilot-browser/core';

const [endpoint] = await discoverEndpoints({ platform: process.platform, home: os.homedir(), env: process.env });
const driver = new AgentBrowserDriver();
await driver.connect({ kind: 'attach', endpoint });
const page = await driver.act('', { type: 'navigate', url: 'https://example.com' });
```

Most users want the MCP server: [`@pilot-browser/mcp`](https://www.npmjs.com/package/@pilot-browser/mcp). Apache-2.0.
