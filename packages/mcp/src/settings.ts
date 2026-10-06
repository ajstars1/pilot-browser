import { mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { APPROVAL_MODES, isApprovalMode, type ApprovalMode } from '@pilot-browser/core';

/**
 * Operator settings. They live in a file the person running the server controls
 * (`~/.pilot-browser/config.json`) or in env vars; no MCP tool can change them, so the model
 * can't loosen its own leash. Re-read on every browser_connect: edits apply to the next
 * session without restarting the MCP client.
 */
export interface Settings {
  readonly mode: ApprovalMode;
  /** Folder uploads may come from; null disables uploads. */
  readonly uploadDir: string | null;
  readonly approvalTimeoutSeconds: number;
  readonly profileDir: string;
}

export type SettingKey = keyof Settings;
export const SETTING_KEYS: readonly SettingKey[] = ['mode', 'uploadDir', 'approvalTimeoutSeconds', 'profileDir'];

type Env = Readonly<Record<string, string | undefined>>;

export const configPath = (env: Env = process.env, home = os.homedir()): string =>
  env.PILOT_CONFIG ?? path.join(home, '.pilot-browser', 'config.json');

const expandHome = (value: string, home: string): string => (value === '~' || value.startsWith('~/') ? path.join(home, value.slice(1)) : value);

export const defaultSettings = (home = os.homedir()): Settings => ({
  mode: 'supervised',
  uploadDir: null,
  approvalTimeoutSeconds: 120,
  profileDir: path.join(home, '.pilot-browser', 'profiles'),
});

/** Validate one value; returns an error message or the parsed value. */
export const parseSetting = (key: SettingKey, raw: unknown, home = os.homedir()): { ok: true; value: Settings[SettingKey] } | { ok: false; error: string } => {
  switch (key) {
    case 'mode':
      return isApprovalMode(raw) ? { ok: true, value: raw } : { ok: false, error: `mode must be one of: ${APPROVAL_MODES.join(', ')}` };
    case 'uploadDir':
      if (raw === null || raw === '') return { ok: true, value: null };
      return typeof raw === 'string' ? { ok: true, value: path.resolve(expandHome(raw, home)) } : { ok: false, error: 'uploadDir must be a folder path' };
    case 'profileDir':
      return typeof raw === 'string' && raw ? { ok: true, value: path.resolve(expandHome(raw, home)) } : { ok: false, error: 'profileDir must be a folder path' };
    case 'approvalTimeoutSeconds': {
      const n = typeof raw === 'number' ? raw : Number(raw);
      return Number.isInteger(n) && n >= 5 && n <= 3600 ? { ok: true, value: n } : { ok: false, error: 'approvalTimeoutSeconds must be a whole number from 5 to 3600' };
    }
  }
};

const readFileSettings = async (file: string): Promise<Record<string, unknown>> => {
  try {
    const data: unknown = JSON.parse(await readFile(file, 'utf8'));
    return typeof data === 'object' && data !== null && !Array.isArray(data) ? (data as Record<string, unknown>) : {};
  } catch {
    return {};
  }
};

/** Defaults, then the config file, then env vars (env wins). Invalid values are ignored. */
export const loadSettings = async (env: Env = process.env, home = os.homedir()): Promise<Settings> => {
  const merged: Record<string, unknown> = { ...defaultSettings(home) };
  const file = await readFileSettings(configPath(env, home));
  const fromEnv: Record<string, unknown> = {};
  if (env.PILOT_MODE) fromEnv.mode = env.PILOT_MODE;
  if (env.PILOT_APPROVALS === 'off') fromEnv.mode = 'full-auto';
  if (env.PILOT_UPLOAD_DIR) fromEnv.uploadDir = env.PILOT_UPLOAD_DIR;
  if (env.PILOT_APPROVAL_TIMEOUT) fromEnv.approvalTimeoutSeconds = env.PILOT_APPROVAL_TIMEOUT;
  if (env.PILOT_PROFILE_DIR) fromEnv.profileDir = env.PILOT_PROFILE_DIR;
  for (const layer of [file, fromEnv]) {
    for (const key of SETTING_KEYS) {
      if (!(key in layer)) continue;
      const parsed = parseSetting(key, layer[key], home);
      if (parsed.ok) merged[key] = parsed.value;
    }
  }
  return merged as unknown as Settings;
};

/** Write one key to the config file (creating it if needed). */
export const saveSetting = async (key: SettingKey, raw: unknown, env: Env = process.env, home = os.homedir()): Promise<Settings[SettingKey]> => {
  const parsed = parseSetting(key, raw, home);
  if (!parsed.ok) throw new Error(parsed.error);
  const file = configPath(env, home);
  const current = await readFileSettings(file);
  const next = { ...current, [key]: parsed.value };
  if (parsed.value === null) delete (next as Record<string, unknown>)[key];
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  return parsed.value;
};

const MODE_DESCRIPTIONS: Record<ApprovalMode, string> = {
  manual: 'asks before every click, typing, upload and submit',
  supervised: 'asks before submits, uploads, sends, deletes, payments and cross-site copies',
  auto: 'asks only for payments, deletes, destructive dialogs and cross-site copies',
  'full-auto': 'never asks (origin allowlist, upload folder and Stop still apply)',
};

export const describeMode = (mode: ApprovalMode): string => MODE_DESCRIPTIONS[mode];

/** Remove one key from the config file, so it falls back to its default. */
export const unsetSetting = async (key: SettingKey, env: Env = process.env, home = os.homedir()): Promise<void> => {
  const file = configPath(env, home);
  const current = await readFileSettings(file);
  if (!(key in current)) return;
  const { [key]: _removed, ...rest } = current;
  await writeFile(file, `${JSON.stringify(rest, null, 2)}\n`, { mode: 0o600 });
};
