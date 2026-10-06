import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  chromiumUserDataDirs,
  discoverEndpoints,
  firefoxProfileRoots,
  isWsl,
  parseDevToolsActivePort,
  parseWebDriverBiDiServer,
  wslWindowsUserDataDirs,
} from '../endpoints.js';

describe('parseDevToolsActivePort', () => {
  it('should build a ws url from the approval-mode file', () => {
    expect(parseDevToolsActivePort('9222\n/devtools/browser/abc-123\n')).toBe('ws://127.0.0.1:9222/devtools/browser/abc-123');
  });

  it('should accept Windows line endings', () => {
    expect(parseDevToolsActivePort('41903\r\n/devtools/browser/x')).toBe('ws://127.0.0.1:41903/devtools/browser/x');
  });

  it('should reject malformed content', () => {
    expect(parseDevToolsActivePort('')).toBeNull();
    expect(parseDevToolsActivePort('9222')).toBeNull();
    expect(parseDevToolsActivePort('abc\n/devtools/browser/x')).toBeNull();
    expect(parseDevToolsActivePort('9222\n/json/version')).toBeNull();
  });
});

describe('parseWebDriverBiDiServer', () => {
  it('should build a BiDi session url', () => {
    expect(parseWebDriverBiDiServer('{"ws_host":"127.0.0.1","ws_port":40123}')).toBe('ws://127.0.0.1:40123/session');
  });

  it('should reject malformed content', () => {
    expect(parseWebDriverBiDiServer('not json')).toBeNull();
    expect(parseWebDriverBiDiServer('{"ws_host":"127.0.0.1","ws_port":"1"}')).toBeNull();
    expect(parseWebDriverBiDiServer('null')).toBeNull();
  });
});

describe('chromiumUserDataDirs', () => {
  it('should include Edge on Windows under LOCALAPPDATA', () => {
    const dirs = chromiumUserDataDirs({ platform: 'win32', home: 'C:\\Users\\a', env: { LOCALAPPDATA: 'C:\\Users\\a\\AppData\\Local' } });
    expect(dirs.find((d) => d.browser === 'edge')?.dir).toBe('C:\\Users\\a\\AppData\\Local\\Microsoft\\Edge\\User Data');
    expect(dirs.find((d) => d.browser === 'brave')?.dir).toBe('C:\\Users\\a\\AppData\\Local\\BraveSoftware\\Brave-Browser\\User Data');
  });

  it('should honour XDG_CONFIG_HOME on Linux', () => {
    const dirs = chromiumUserDataDirs({ platform: 'linux', home: '/home/a', env: { XDG_CONFIG_HOME: '/cfg' } });
    expect(dirs.find((d) => d.browser === 'chrome')?.dir).toBe('/cfg/google-chrome');
  });

  it('should use Application Support on macOS', () => {
    const dirs = chromiumUserDataDirs({ platform: 'darwin', home: '/Users/a', env: {} });
    expect(dirs.find((d) => d.browser === 'edge')?.dir).toBe('/Users/a/Library/Application Support/Microsoft Edge');
  });
});

describe('WSL', () => {
  it('should map Windows user-data dirs onto /mnt/c', () => {
    const chrome = wslWindowsUserDataDirs('ayush').find((d) => d.browser === 'chrome');
    expect(chrome?.dir).toBe('/mnt/c/Users/ayush/AppData/Local/Google/Chrome/User Data');
  });

  it('should detect WSL from the environment', () => {
    expect(isWsl({ WSL_DISTRO_NAME: 'Ubuntu' })).toBe(true);
    expect(isWsl({})).toBe(false);
  });
});

describe('firefoxProfileRoots', () => {
  it('should include the snap location on Linux', () => {
    expect(firefoxProfileRoots({ platform: 'linux', home: '/home/a', env: {} })).toContain('/home/a/snap/firefox/common/.mozilla/firefox');
  });
});

describe('discoverEndpoints', () => {
  it('should find Chromium and Firefox endpoints from their files', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'pb-discovery-'));
    const chrome = path.join(home, '.config', 'google-chrome');
    const ffProfile = path.join(home, '.mozilla', 'firefox', 'abc.default-release');
    await mkdir(chrome, { recursive: true });
    await mkdir(ffProfile, { recursive: true });
    await writeFile(path.join(chrome, 'DevToolsActivePort'), '9222\n/devtools/browser/id\n');
    await writeFile(path.join(ffProfile, 'WebDriverBiDiServer.json'), '{"ws_host":"127.0.0.1","ws_port":40123}');

    const found = await discoverEndpoints({ platform: 'linux', home, env: {} });

    expect(found).toEqual([
      { engine: 'chromium', browser: 'chrome', wsUrl: 'ws://127.0.0.1:9222/devtools/browser/id', source: path.join(chrome, 'DevToolsActivePort') },
      { engine: 'firefox', browser: 'firefox', wsUrl: 'ws://127.0.0.1:40123/session', source: path.join(ffProfile, 'WebDriverBiDiServer.json') },
    ]);
  });
});
