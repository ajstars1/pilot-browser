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
  /**
   * Nobody is at the browser (e.g. an overnight run). Handoffs and waits for the user fail
   * at once instead of blocking, actions that need approval are refused rather than asked
   * about, and input in the tab no longer pauses the agent (Pause and Stop still do).
   */
  readonly unattended: boolean;
  /**
   * The user's own details (name, email, phone, profile URLs). Typing these is never treated
   * as a cross-site copy, even if a page on another site showed them.
   */
  readonly identity: readonly string[];
}

export type SettingKey = keyof Settings;
export const SETTING_KEYS: readonly SettingKey[] = ['mode', 'uploadDir', 'approvalTimeoutSeconds', 'profileDir', 'unattended', 'identity'];

const MAX_IDENTITY_VALUES = 20;
const MAX_IDENTITY_LENGTH = 200;

type Env = Readonly<Record<string, string | undefined>>;

export const configPath = (env: Env = process.env, home = os.homedir()): string =>
  env.PILOT_CONFIG ?? path.join(home, '.pilot-browser', 'config.json');

const expandHome = (value: string, home: string): string => (value === '~' || value.startsWith('~/') ? path.join(home, value.slice(1)) : value);

export const defaultSettings = (home = os.homedir()): Settings => ({
  mode: 'supervised',
  uploadDir: null,
  approvalTimeoutSeconds: 120,
  profileDir: path.join(home, '.pilot-browser', 'profiles'),
  unattended: false,
  identity: [],
});

const parseBoolean = (raw: unknown): boolean | null => {
  if (typeof raw === 'boolean') return raw;
  if (typeof raw !== 'string') return null;
  const v = raw.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(v)) return true;
  if (['0', 'false', 'no', 'off', ''].includes(v)) return false;
  return null;
};

/** A JSON array of strings, or one string with values separated by ";". */
const parseIdentity = (raw: unknown): string[] | null => {
  let values: unknown = raw;
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (trimmed.startsWith('[')) {
      try {
        values = JSON.parse(trimmed);
      } catch {
        return null;
      }
    } else {
      values = trimmed.split(';');
    }
  }
  if (!Array.isArray(values) || !values.every((v) => typeof v === 'string')) return null;
  const cleaned = [...new Set((values as string[]).map((v) => v.trim()).filter(Boolean))];
  if (cleaned.length > MAX_IDENTITY_VALUES || cleaned.some((v) => v.length > MAX_IDENTITY_LENGTH)) return null;
  return cleaned;
};

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
    case 'unattended': {
      const b = parseBoolean(raw);
      return b === null ? { ok: false, error: 'unattended must be true or false' } : { ok: true, value: b };
    }
    case 'identity': {
      const values = parseIdentity(raw);
      return values === null
        ? { ok: false, error: `identity must be a JSON array of strings or values separated by ";" (at most ${MAX_IDENTITY_VALUES}, each up to ${MAX_IDENTITY_LENGTH} characters)` }
        : { ok: true, value: values };
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
  const unattended = env.PILOT_BROWSER_UNATTENDED ?? env.PILOT_UNATTENDED;
  if (unattended !== undefined) fromEnv.unattended = unattended;
  if (env.PILOT_IDENTITY) fromEnv.identity = env.PILOT_IDENTITY;
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
  if (parsed.value === null || (Array.isArray(parsed.value) && parsed.value.length === 0)) delete (next as Record<string, unknown>)[key];
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
