#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { runConfigCommand } from './config-cli.js';
import { createPilotServer } from './server.js';

if (process.argv[2] === 'config') {
  process.exitCode = await runConfigCommand(process.argv.slice(3));
} else {
  // Mode, upload folder, timeouts and profile folder come from ~/.pilot-browser/config.json and
  // PILOT_* env vars, re-read on every browser_connect.
  const server = createPilotServer({
    ...(process.env.PILOT_CHROME ? { executablePath: process.env.PILOT_CHROME } : {}),
  });

  let closing = false;
  const shutdown = async (): Promise<void> => {
    if (closing) return;
    closing = true;
    // Detach from the user's browser (never close it) before exiting.
    await server.close().catch(() => undefined);
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
  process.stdin.on('close', () => void shutdown());

  await server.connect(new StdioServerTransport());
}
