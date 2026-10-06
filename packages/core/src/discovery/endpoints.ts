import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import type { BrowserKind, Endpoint } from '../types.js';

export interface HostInfo {
  readonly platform: NodeJS.Platform;
  readonly home: string;
  readonly env: Readonly<Record<string, string | undefined>>;
}

interface Candidate {
  readonly browser: BrowserKind;
  readonly dir: string;
}

/** Where each Chromium-family browser keeps its default user-data dir. */
export const chromiumUserDataDirs = ({ platform, home, env }: HostInfo): Candidate[] => {
  if (platform === 'win32') {
    const local = env.LOCALAPPDATA ?? path.win32.join(home, 'AppData', 'Local');
    const j = (...p: string[]) => path.win32.join(local, ...p, 'User Data');
    return [
      { browser: 'chrome', dir: j('Google', 'Chrome') },
      { browser: 'chrome-canary', dir: j('Google', 'Chrome SxS') },
      { browser: 'chromium', dir: j('Chromium') },
      { browser: 'brave', dir: j('BraveSoftware', 'Brave-Browser') },
      { browser: 'edge', dir: j('Microsoft', 'Edge') },
    ];
  }
  if (platform === 'darwin') {
    const support = path.posix.join(home, 'Library', 'Application Support');
    const j = (...p: string[]) => path.posix.join(support, ...p);
    return [
      { browser: 'chrome', dir: j('Google', 'Chrome') },
      { browser: 'chrome-canary', dir: j('Google', 'Chrome Canary') },
      { browser: 'chromium', dir: j('Chromium') },
      { browser: 'brave', dir: j('BraveSoftware', 'Brave-Browser') },
      { browser: 'edge', dir: j('Microsoft Edge') },
    ];
  }
  const config = env.XDG_CONFIG_HOME ?? path.posix.join(home, '.config');
  const j = (...p: string[]) => path.posix.join(config, ...p);
  return [
    { browser: 'chrome', dir: j('google-chrome') },
    { browser: 'chrome-canary', dir: j('google-chrome-unstable') },
    { browser: 'chromium', dir: j('chromium') },
    { browser: 'brave', dir: j('BraveSoftware', 'Brave-Browser') },
    { browser: 'edge', dir: j('microsoft-edge') },
  ];
};

/**
 * WSL: Claude Code runs in Linux while the browser runs on Windows. Build the
 * Windows candidates as /mnt/c paths. Connecting to them also needs WSL
 * mirrored networking, because Chrome binds Windows 127.0.0.1 only.
 */
export const wslWindowsUserDataDirs = (windowsUser: string, mount = '/mnt/c'): Candidate[] =>
  chromiumUserDataDirs({
    platform: 'win32',
    home: `C:\\Users\\${windowsUser}`,
    env: { LOCALAPPDATA: `C:\\Users\\${windowsUser}\\AppData\\Local` },
  }).map(({ browser, dir }) => ({
    browser,
    dir: path.posix.join(mount, ...dir.replace(/^[A-Za-z]:\\/, '').split('\\')),
  }));

export const isWsl = (env: HostInfo['env']): boolean => Boolean(env.WSL_DISTRO_NAME ?? env.WSL_INTEROP);

/** Chromium approval mode writes `<port>\n<ws path>` to DevToolsActivePort. */
export const parseDevToolsActivePort = (content: string, host = '127.0.0.1'): string | null => {
  const [port, wsPath] = content.trim().split(/\r?\n/);
  if (!port || !/^\d{1,5}$/.test(port) || !wsPath?.startsWith('/devtools/browser/')) return null;
  return `ws://${host}:${port}${wsPath}`;
};

/** Firefox Remote Agent writes WebDriverBiDiServer.json (`{ ws_host, ws_port }`) into the profile. */
export const parseWebDriverBiDiServer = (content: string): string | null => {
  try {
    const data: unknown = JSON.parse(content);
    if (typeof data !== 'object' || data === null) return null;
    const { ws_host: host, ws_port: port } = data as Record<string, unknown>;
    if (typeof host !== 'string' || typeof port !== 'number') return null;
    return `ws://${host}:${port}/session`;
  } catch {
    return null;
  }
};

/** Firefox profile roots; each contains one directory per profile. */
export const firefoxProfileRoots = ({ platform, home, env }: HostInfo): string[] => {
  if (platform === 'win32') {
    const roaming = env.APPDATA ?? path.win32.join(home, 'AppData', 'Roaming');
    return [path.win32.join(roaming, 'Mozilla', 'Firefox', 'Profiles')];
  }
  if (platform === 'darwin') return [path.posix.join(home, 'Library', 'Application Support', 'Firefox', 'Profiles')];
  return [
    path.posix.join(home, '.mozilla', 'firefox'),
    path.posix.join(home, 'snap', 'firefox', 'common', '.mozilla', 'firefox'),
  ];
};

const readIfPresent = async (file: string): Promise<string | null> => readFile(file, 'utf8').catch(() => null);

/** Find every attachable browser endpoint. Reading these files never contacts the browser. */
export const discoverEndpoints = async (host: HostInfo): Promise<Endpoint[]> => {
  const found: Endpoint[] = [];
  for (const { browser, dir } of chromiumUserDataDirs(host)) {
    const source = path.join(dir, 'DevToolsActivePort');
    const content = await readIfPresent(source);
    const wsUrl = content ? parseDevToolsActivePort(content) : null;
    if (wsUrl) found.push({ engine: 'chromium', browser, wsUrl, source });
  }
  for (const root of firefoxProfileRoots(host)) {
    const profiles = await readdir(root).catch(() => [] as string[]);
    for (const profile of profiles) {
      const source = path.join(root, profile, 'WebDriverBiDiServer.json');
      const content = await readIfPresent(source);
      const wsUrl = content ? parseWebDriverBiDiServer(content) : null;
      if (wsUrl) found.push({ engine: 'firefox', browser: 'firefox', wsUrl, source });
    }
  }
  return found;
};
