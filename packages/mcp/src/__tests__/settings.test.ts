import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadSettings, parseSetting, saveSetting, unsetSetting } from '../settings.js';

const tmpHome = () => mkdtemp(path.join(os.tmpdir(), 'pilot-settings-'));

describe('settings', () => {
  it('should default to supervised with uploads disabled', async () => {
    const home = await tmpHome();
    expect(await loadSettings({}, home)).toEqual({
      mode: 'supervised',
      uploadDir: null,
      approvalTimeoutSeconds: 120,
      profileDir: path.join(home, '.pilot-browser', 'profiles'),
      unattended: false,
      identity: [],
    });
  });

  it('should read unattended from the file or PILOT_BROWSER_UNATTENDED, and identity values', async () => {
    const home = await tmpHome();
    expect((await loadSettings({ PILOT_BROWSER_UNATTENDED: '1' }, home)).unattended).toBe(true);
    expect((await loadSettings({ PILOT_UNATTENDED: 'yes' }, home)).unattended).toBe(true);
    await saveSetting('unattended', 'true', {}, home);
    expect((await loadSettings({}, home)).unattended).toBe(true);
    expect((await loadSettings({ PILOT_BROWSER_UNATTENDED: '0' }, home)).unattended).toBe(false);

    await saveSetting('identity', 'Ada Lovelace; ada@example.com ;+44 20 7946 0000', {}, home);
    expect((await loadSettings({}, home)).identity).toEqual(['Ada Lovelace', 'ada@example.com', '+44 20 7946 0000']);
    await saveSetting('identity', '["Ada; Countess of Lovelace"]', {}, home);
    expect((await loadSettings({}, home)).identity).toEqual(['Ada; Countess of Lovelace']);
    expect((await loadSettings({ PILOT_IDENTITY: 'X Y;x@y.z' }, home)).identity).toEqual(['X Y', 'x@y.z']);
    expect(parseSetting('unattended', 'maybe')).toMatchObject({ ok: false });
    expect(parseSetting('identity', [1, 2])).toMatchObject({ ok: false });
    expect(parseSetting('identity', 'x'.repeat(201))).toMatchObject({ ok: false });
  });

  it('should save, load and unset values in the config file (owner-only)', async () => {
    const home = await tmpHome();
    await saveSetting('mode', 'auto', {}, home);
    await saveSetting('uploadDir', '~/resumes', {}, home);
    const file = path.join(home, '.pilot-browser', 'config.json');
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ mode: 'auto', uploadDir: path.join(home, 'resumes') });
    // Windows has no POSIX permission bits; elsewhere the file must be owner-only.
    if (process.platform !== 'win32') expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(await loadSettings({}, home)).toMatchObject({ mode: 'auto', uploadDir: path.join(home, 'resumes') });
    await unsetSetting('mode', {}, home);
    expect((await loadSettings({}, home)).mode).toBe('supervised');
  });

  it('should let env vars override the file, including the legacy PILOT_APPROVALS=off', async () => {
    const home = await tmpHome();
    await saveSetting('mode', 'manual', {}, home);
    expect((await loadSettings({ PILOT_MODE: 'auto' }, home)).mode).toBe('auto');
    expect((await loadSettings({ PILOT_APPROVALS: 'off' }, home)).mode).toBe('full-auto');
    expect((await loadSettings({ PILOT_UPLOAD_DIR: '/x/y' }, home)).uploadDir).toBe(path.resolve('/x/y'));
  });

  it('should ignore invalid or corrupt values instead of loosening anything', async () => {
    const home = await tmpHome();
    const file = path.join(home, 'cfg.json');
    await writeFile(file, JSON.stringify({ mode: 'yolo', approvalTimeoutSeconds: 1 }));
    expect(await loadSettings({ PILOT_CONFIG: file, PILOT_MODE: 'god' }, home)).toMatchObject({ mode: 'supervised', approvalTimeoutSeconds: 120 });
    await writeFile(file, '{not json');
    expect((await loadSettings({ PILOT_CONFIG: file }, home)).mode).toBe('supervised');
  });

  it('should reject invalid values when setting', async () => {
    expect(parseSetting('mode', 'yolo')).toMatchObject({ ok: false });
    expect(parseSetting('approvalTimeoutSeconds', '9999')).toMatchObject({ ok: false });
    await expect(saveSetting('mode', 'nope', {}, await tmpHome())).rejects.toThrow('mode must be one of');
  });
});
