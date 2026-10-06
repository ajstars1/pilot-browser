import { describe, expect, it } from 'vitest';
import { createOriginPolicy } from '../origin.js';

const allowed = (entries: string[], url: string): boolean => createOriginPolicy(entries).check(url).ok;

describe('createOriginPolicy', () => {
  it('should allow a host and its subdomains', () => {
    expect(allowed(['github.com'], 'https://github.com/notifications')).toBe(true);
    expect(allowed(['github.com'], 'https://gist.github.com/x')).toBe(true);
  });

  it('should not be fooled by look-alike hosts', () => {
    expect(allowed(['github.com'], 'https://evilgithub.com/')).toBe(false);
    expect(allowed(['github.com'], 'https://github.com.evil.example/')).toBe(false);
  });

  it('should match an exact origin including scheme and port', () => {
    expect(allowed(['https://app.example.com'], 'https://app.example.com/a')).toBe(true);
    expect(allowed(['https://app.example.com'], 'http://app.example.com/a')).toBe(false);
    expect(allowed(['https://app.example.com'], 'https://app.example.com:8443/a')).toBe(false);
  });

  it('should match host:port entries', () => {
    expect(allowed(['127.0.0.1:8791'], 'http://127.0.0.1:8791/index.html')).toBe(true);
    expect(allowed(['127.0.0.1:8791'], 'http://127.0.0.1:8792/frame.html')).toBe(false);
  });

  it('should block dangerous schemes even with a wildcard', () => {
    for (const url of ['javascript:alert(1)', 'file:///etc/passwd', 'data:text/html,hi', 'chrome://settings', 'view-source:https://a.com']) {
      expect(allowed(['*'], url)).toBe(false);
    }
  });

  it('should block embedded credentials and invalid URLs', () => {
    expect(allowed(['*'], 'https://user:pass@example.com/')).toBe(false);
    expect(allowed(['*'], 'not a url')).toBe(false);
  });

  it('should always allow about:blank', () => {
    expect(allowed([], 'about:blank')).toBe(true);
  });

  it('should explain why a URL was blocked', () => {
    const result = createOriginPolicy(['github.com']).check('https://evil.example/steal');
    expect(result).toEqual({
      ok: false,
      error: { code: 'blocked_by_policy', message: expect.stringContaining('https://evil.example'), retryable: false },
    });
  });
});
