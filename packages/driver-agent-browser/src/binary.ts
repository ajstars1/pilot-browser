import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

export interface Invocation {
  readonly command: string;
  /** Arguments that must precede agent-browser's own arguments. */
  readonly prefixArgs: readonly string[];
}

const isMusl = (): boolean => {
  if (process.platform !== 'linux') return false;
  try {
    return !readFileSync('/usr/bin/ldd', 'utf8').includes('GNU C Library');
  } catch {
    return existsSync('/lib/ld-musl-x86_64.so.1') || existsSync('/lib/ld-musl-aarch64.so.1');
  }
};

/** Binary file name agent-browser ships for a platform, e.g. `agent-browser-win32-x64.exe`. */
export const nativeBinaryName = (platform: NodeJS.Platform, arch: string, musl: boolean): string | null => {
  const cpu = arch === 'x64' ? 'x64' : arch === 'arm64' ? 'arm64' : null;
  if (!cpu) return null;
  switch (platform) {
    case 'linux':
      return `agent-browser-linux-${musl ? 'musl-' : ''}${cpu}`;
    case 'darwin':
      return `agent-browser-darwin-${cpu}`;
    case 'win32':
      // agent-browser ships x64 only on Windows; ARM64 Windows runs it under emulation.
      return 'agent-browser-win32-x64.exe';
    default:
      return null;
  }
};

/**
 * Resolve how to run agent-browser. Prefers the native binary (no Node hop, no `.cmd`
 * shim on Windows); falls back to `node <launcher>`. `PILOT_AGENT_BROWSER_BIN` overrides.
 */
export const resolveAgentBrowser = (override = process.env.PILOT_AGENT_BROWSER_BIN): Invocation => {
  if (override) return { command: override, prefixArgs: [] };
  const require = createRequire(import.meta.url);
  const launcher = require.resolve('agent-browser/bin/agent-browser.js');
  const name = nativeBinaryName(process.platform, process.arch, isMusl());
  const native = name ? path.join(path.dirname(launcher), name) : null;
  if (native && existsSync(native)) return { command: native, prefixArgs: [] };
  return { command: process.execPath, prefixArgs: [launcher] };
};
