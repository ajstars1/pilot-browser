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
  unattended              true for runs with nobody at the browser (overnight): no handoffs,
                          no approval prompts, tab input doesn't pause the agent
  identity                your own details, safe to type anywhere, e.g.
                          'Ada Lovelace;ada@example.com;+44 20 7946 0000' or a JSON array

Changes apply on the next browser_connect; no restart needed.
Env vars (PILOT_MODE, PILOT_UPLOAD_DIR, PILOT_APPROVAL_TIMEOUT, PILOT_PROFILE_DIR,
PILOT_BROWSER_UNATTENDED, PILOT_IDENTITY) override the file.
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
      out(`unattended:             ${s.unattended ? 'yes (no handoffs or approval prompts)' : 'no'}`);
      out(`identity:               ${s.identity.length > 0 ? s.identity.join('; ') : '(none)'}`);
      return 0;
    }
    if (verb === 'set' && isKey(key) && value !== undefined) {
      const saved = await saveSetting(key, value);
      const shown = Array.isArray(saved) ? (saved.length > 0 ? saved.join('; ') : '(none)') : String(saved ?? '(unset)');
      out(`${key} = ${shown}${key === 'mode' ? `  (${describeMode(saved as (typeof APPROVAL_MODES)[number])})` : ''}`);
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
