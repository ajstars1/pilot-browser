import { describe, expect, it } from 'vitest';
import { buildOverlayScript, overlayCall, parseOverlayDrain } from '../script.js';

describe('buildOverlayScript', () => {
  it('should pass the token as an argument, never inside function source', () => {
    const script = buildOverlayScript('tok-123');
    expect(script.endsWith('("tok-123");')).toBe(true);
    expect(script.indexOf('tok-123')).toBe(script.lastIndexOf('tok-123'));
  });

  it('should be valid JavaScript', () => {
    expect(() => new Function(buildOverlayScript('t'))).not.toThrow();
  });
});

describe('overlayCall', () => {
  it('should JSON-encode every argument so model text cannot break out', () => {
    expect(overlayCall('t', 'begin', 'Clicking "Go"); alert(1); ("')).toBe(
      'globalThis.__pilotBrowserOverlay?.begin("t", "Clicking \\"Go\\"); alert(1); (\\"") ?? null',
    );
  });
});

describe('parseOverlayDrain', () => {
  it('should accept a well-formed drain', () => {
    expect(parseOverlayDrain('{"mode":"user","events":[{"type":"input"},{"type":"handback"}]}')).toEqual({
      mode: 'user',
      events: [{ type: 'input' }, { type: 'handback' }],
    });
  });

  it('should drop unknown event types and reject malformed data', () => {
    expect(parseOverlayDrain('{"mode":"agent","events":[{"type":"resume-everything"},{"type":"stop"}]}')).toEqual({
      mode: 'agent',
      events: [{ type: 'stop' }],
    });
    expect(parseOverlayDrain('{"mode":"god","events":[]}')).toBeNull();
    expect(parseOverlayDrain('not json')).toBeNull();
    expect(parseOverlayDrain(null)).toBeNull();
  });
});
