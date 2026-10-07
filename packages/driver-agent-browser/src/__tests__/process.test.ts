import { describe, expect, it } from 'vitest';
import { browsersForProfile, parsePs, socketDir } from '../process.js';

const PS = `
    1     0 /sbin/init
  9100  2159 /opt/google/chrome/chrome --remote-debugging-port=0 --no-first-run --user-data-dir=/home/alex/.pilot-browser/profiles/jobs --headed about:blank
  9101  9100 /opt/google/chrome/chrome --type=renderer --user-data-dir=/home/alex/.pilot-browser/profiles/jobs --lang=en-US
  9200  2159 /opt/google/chrome/chrome --remote-debugging-port=0 --user-data-dir=/home/alex/.pilot-browser/profiles/jobs-2
  9300  3601 /opt/google/chrome/chrome
`;

describe('process helpers', () => {
  it('should parse ps rows with arguments that contain spaces', () => {
    const rows = parsePs(PS);
    expect(rows).toHaveLength(5);
    expect(rows[1]).toEqual({ pid: 9100, ppid: 2159, args: expect.stringContaining('--headed about:blank') });
  });

  it('should find the main browser for a profile, not its helpers or a profile with a longer name', () => {
    const found = browsersForProfile(parsePs(PS), '/home/alex/.pilot-browser/profiles/jobs');
    expect(found.map((r) => r.pid)).toEqual([9100]);
    expect(browsersForProfile(parsePs(PS), '/home/alex/.pilot-browser/profiles/jobs-2').map((r) => r.pid)).toEqual([9200]);
    expect(browsersForProfile(parsePs(PS), '/home/alex/.pilot-browser/profiles/other')).toEqual([]);
  });

  it("should look for agent-browser's pid files where agent-browser keeps them", () => {
    expect(socketDir({ AGENT_BROWSER_SOCKET_DIR: '/tmp/ab', XDG_RUNTIME_DIR: '/run/user/1000' })).toBe('/tmp/ab');
    expect(socketDir({ XDG_RUNTIME_DIR: '/run/user/1000' })).toBe('/run/user/1000/agent-browser');
    expect(socketDir({})).toMatch(/\.agent-browser$/);
  });
});
