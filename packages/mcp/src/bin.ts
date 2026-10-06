#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createPilotServer } from './server.js';

const server = createPilotServer({
  ...(process.env.PILOT_UPLOAD_DIR ? { uploadRoot: process.env.PILOT_UPLOAD_DIR } : {}),
  ...(process.env.PILOT_PROFILE_DIR ? { profileRoot: process.env.PILOT_PROFILE_DIR } : {}),
  ...(process.env.PILOT_CHROME ? { executablePath: process.env.PILOT_CHROME } : {}),
  ...(process.env.PILOT_APPROVALS === 'off' ? { approvals: 'off' as const } : {}),
  ...(process.env.PILOT_APPROVAL_TIMEOUT ? { approvalTimeoutSeconds: Number(process.env.PILOT_APPROVAL_TIMEOUT) } : {}),
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
