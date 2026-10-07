import { spawn } from 'node:child_process';
import type { Invocation } from './binary.js';

/** agent-browser's `--json` envelope for a single command. */
export interface Envelope {
  readonly success: boolean;
  readonly data: Record<string, unknown>;
  readonly error: string | null;
  readonly code: string | null;
}

/** One entry of `batch --json` output. */
export interface BatchEntry {
  readonly command: readonly string[];
  readonly result: Record<string, unknown>;
  readonly error: string | null;
}

export interface RunOptions {
  readonly timeoutMs: number;
  readonly stdin?: string;
}

export const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

const lastJsonLine = (stdout: string): unknown => {
  const trimmed = stdout.trim();
  // Batch output is a (possibly multi-line) JSON array; single commands print one JSON line.
  if (trimmed.startsWith('[')) return JSON.parse(trimmed);
  const line = trimmed
    .split(/\r?\n/)
    .filter((l) => l.startsWith('{'))
    .pop();
  return line === undefined ? undefined : JSON.parse(line);
};

const toEnvelope = (value: unknown, fallbackError: string): Envelope => {
  const rec = asRecord(value);
  if (typeof rec.success !== 'boolean') return { success: false, data: {}, error: fallbackError || 'agent-browser returned no JSON', code: null };
  return {
    success: rec.success,
    data: asRecord(rec.data),
    error: typeof rec.error === 'string' ? rec.error : null,
    code: typeof rec.code === 'string' ? rec.code : null,
  };
};

/**
 * Runs agent-browser commands. Always async: a synchronous spawn blocks the event loop,
 * which deadlocks anything else this process serves (seen in the day-1 spike).
 */
export class AgentBrowserRunner {
  constructor(
    private readonly invocation: Invocation,
    private readonly env: Readonly<Record<string, string>> = {},
  ) {}

  private exec(args: readonly string[], { timeoutMs, stdin }: RunOptions): Promise<{ stdout: string; stderr: string; timedOut: boolean }> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.invocation.command, [...this.invocation.prefixArgs, ...args], {
        env: { ...process.env, ...this.env },
        shell: false,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill();
      }, timeoutMs);
      child.stdout.setEncoding('utf8').on('data', (c: string) => (stdout += c));
      child.stderr.setEncoding('utf8').on('data', (c: string) => (stderr += c));
      child.on('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.on('close', () => {
        clearTimeout(timer);
        resolve({ stdout, stderr, timedOut });
      });
      // The CLI can exit before reading stdin (e.g. its daemon was just killed); that's EPIPE, not a crash.
      child.stdin.on('error', () => undefined);
      child.stdin.end(stdin ?? '');
    });
  }

  async run(globalArgs: readonly string[], args: readonly string[], options: RunOptions): Promise<Envelope> {
    try {
      const { stdout, stderr, timedOut } = await this.exec([...globalArgs, '--json', ...args], options);
      if (timedOut) return { success: false, data: {}, error: `agent-browser timed out after ${options.timeoutMs}ms`, code: 'timeout' };
      return toEnvelope(lastJsonLine(stdout), stderr.trim());
    } catch (error) {
      return { success: false, data: {}, error: error instanceof Error ? error.message : String(error), code: null };
    }
  }

  /** Run several commands in one daemon round-trip. Commands go over stdin as JSON, never through a shell. */
  async batch(globalArgs: readonly string[], commands: readonly (readonly string[])[], options: Omit<RunOptions, 'stdin'> & { readonly bail?: boolean }): Promise<BatchEntry[] | Envelope> {
    try {
      const { stdout, stderr, timedOut } = await this.exec([...globalArgs, '--json', 'batch', ...(options.bail ? ['--bail'] : [])], {
        timeoutMs: options.timeoutMs,
        stdin: JSON.stringify(commands),
      });
      if (timedOut) return { success: false, data: {}, error: `agent-browser timed out after ${options.timeoutMs}ms`, code: 'timeout' };
      const parsed = lastJsonLine(stdout);
      if (!Array.isArray(parsed)) return toEnvelope(parsed, stderr.trim());
      return parsed.map((entry): BatchEntry => {
        const rec = asRecord(entry);
        return {
          command: Array.isArray(rec.command) ? rec.command.map(String) : [],
          result: asRecord(rec.result),
          error: typeof rec.error === 'string' ? rec.error : null,
        };
      });
    } catch (error) {
      return { success: false, data: {}, error: error instanceof Error ? error.message : String(error), code: null };
    }
  }
}
