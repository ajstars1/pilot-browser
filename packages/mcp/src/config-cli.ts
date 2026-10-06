import { APPROVAL_MODES } from '@pilot-browser/core';
import { configPath, describeMode, loadSettings, saveSetting, SETTING_KEYS, unsetSetting, type SettingKey } from './settings.js';

const USAGE = `Usage:
  pilot-browser-mcp config                     show the effective settings
  pilot-browser-mcp config set <key> <value>   change a setting
  pilot-browser-mcp config unset <key>         back to the default

Keys:
  mode                    ${APPROVAL_MODES.join(' | ')}
  uploadDir               folder the agent may upload files from
  approvalTimeoutSeconds  how long an approval waits for you (5-3600)
  profileDir              where managed-mode browser profiles live

Changes apply on the next browser_connect; no restart needed.
Env vars (PILOT_MODE, PILOT_UPLOAD_DIR, PILOT_APPROVAL_TIMEOUT, PILOT_PROFILE_DIR) override the file.
`;

const out = (text: string): void => {
  process.stdout.write(`${text}\n`);
};

const isKey = (key: string | undefined): key is SettingKey => (SETTING_KEYS as readonly string[]).includes(key ?? '');

/** `pilot-browser-mcp config …`. Returns the process exit code. */
export const runConfigCommand = async (args: readonly string[]): Promise<number> => {
  const [verb, key, value] = args;
  try {
    if (verb === undefined || verb === 'show' || verb === 'get') {
      const s = await loadSettings();
      out(`config file: ${configPath()}`);
      out(`mode:                   ${s.mode}  (${describeMode(s.mode)})`);
      out(`uploadDir:              ${s.uploadDir ?? '(uploads disabled)'}`);
      out(`approvalTimeoutSeconds: ${s.approvalTimeoutSeconds}`);
      out(`profileDir:             ${s.profileDir}`);
      return 0;
    }
    if (verb === 'set' && isKey(key) && value !== undefined) {
      const saved = await saveSetting(key, value);
      out(`${key} = ${saved ?? '(unset)'}${key === 'mode' ? `  (${describeMode(saved as (typeof APPROVAL_MODES)[number])})` : ''}`);
      out('Applies on the next browser_connect.');
      return 0;
    }
    if (verb === 'unset' && isKey(key)) {
      await unsetSetting(key);
      out(`${key} reset to its default.`);
      return 0;
    }
    process.stderr.write(USAGE);
    return verb === 'help' || verb === '--help' ? 0 : 1;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
};
