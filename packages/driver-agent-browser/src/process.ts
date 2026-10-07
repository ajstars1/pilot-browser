import { execFile } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Where agent-browser keeps each session's `<session>.pid`, in its own lookup order. */
export const socketDir = (env: NodeJS.ProcessEnv = process.env): string => {
  if (env.AGENT_BROWSER_SOCKET_DIR) return env.AGENT_BROWSER_SOCKET_DIR;
  if (env.XDG_RUNTIME_DIR) return path.join(env.XDG_RUNTIME_DIR, 'agent-browser');
  return path.join(os.homedir(), '.agent-browser');
};

const readPid = async (file: string): Promise<number | null> => {
  try {
    const pid = Number.parseInt((await readFile(file, 'utf8')).trim(), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
};

/** The daemon process serving an agent-browser session, if its pid file exists. */
export const daemonPid = (session: string, env?: NodeJS.ProcessEnv): Promise<number | null> => readPid(path.join(socketDir(env), `${session}.pid`));

/** Every agent-browser session with a pid file, keyed by daemon pid. */
export const daemonSessions = async (env?: NodeJS.ProcessEnv): Promise<Map<number, string>> => {
  const dir = socketDir(env);
  const sessions = new Map<number, string>();
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return sessions;
  }
  for (const name of names.filter((n) => n.endsWith('.pid'))) {
    const pid = await readPid(path.join(dir, name));
    if (pid !== null) sessions.set(pid, name.slice(0, -'.pid'.length));
  }
  return sessions;
};

export const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
};

/** SIGTERM, then SIGKILL whatever is still running after `graceMs`. */
export const terminate = async (pids: readonly number[], graceMs = 3_000): Promise<void> => {
  const send = (pid: number, signal: NodeJS.Signals): void => {
    try {
      process.kill(pid, signal);
    } catch {
      // Already gone.
    }
  };
  for (const pid of pids) send(pid, 'SIGTERM');
  const deadline = Date.now() + graceMs;
  while (pids.some(isAlive) && Date.now() < deadline) await sleep(100);
  for (const pid of pids.filter(isAlive)) send(pid, 'SIGKILL');
};

export interface ProcessRow {
  readonly pid: number;
  readonly ppid: number;
  readonly args: string;
}

/** Parse `ps -Ao pid=,ppid=,args=` output. */
export const parsePs = (output: string): ProcessRow[] =>
  output
    .split('\n')
    .map((line) => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => ({ pid: Number(m[1]), ppid: Number(m[2]), args: m[3] ?? '' }));

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Main browser processes (not renderers or helpers) using `profileDir` as their user data dir. */
export const browsersForProfile = (rows: readonly ProcessRow[], profileDir: string): ProcessRow[] => {
  const flag = new RegExp(`--user-data-dir=["']?${escapeRegExp(profileDir)}["']?(\\s|$)`);
  return rows.filter((r) => flag.test(r.args) && !/\s--type=/.test(r.args));
};

/** The process table, or none where `ps` isn't available (Windows). */
export const listProcesses = (): Promise<ProcessRow[]> => {
  if (process.platform === 'win32') return Promise.resolve([]);
  return new Promise((resolve) => {
    execFile('ps', ['-Ao', 'pid=,ppid=,args='], { maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => resolve(error ? [] : parsePs(stdout)));
  });
};
