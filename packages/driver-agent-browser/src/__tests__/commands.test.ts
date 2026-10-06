import { describe, expect, it } from 'vitest';
import { actionToCommands, dependsOnObservation, normalizeRef, refsOf } from '../commands.js';

describe('normalizeRef', () => {
  it('should accept bare and @-prefixed refs', () => {
    expect(normalizeRef('e12')).toBe('@e12');
    expect(normalizeRef('@e12')).toBe('@e12');
  });

  it('should reject anything that is not a ref, including selectors and flags', () => {
    for (const bad of ['#submit', 'button', '--headed', 'e', 'e1; rm -rf', '']) expect(normalizeRef(bad)).toBeNull();
  });
});

describe('actionToCommands', () => {
  it('should map ref clicks, including double-click', () => {
    expect(actionToCommands({ type: 'click', target: { ref: '@e2' } })).toEqual({ ok: true, value: [['click', '@e2']] });
    expect(actionToCommands({ type: 'click', target: { ref: '@e2' }, clickCount: 2 })).toEqual({ ok: true, value: [['dblclick', '@e2']] });
  });

  it('should map coordinate clicks to mouse move/down/up', () => {
    expect(actionToCommands({ type: 'click', target: { x: 10, y: 20 }, button: 'right' })).toEqual({
      ok: true,
      value: [
        ['mouse', 'move', '10', '20'],
        ['mouse', 'down', 'right'],
        ['mouse', 'up', 'right'],
      ],
    });
  });

  it('should refuse right-clicks on refs rather than silently left-clicking', () => {
    const result = actionToCommands({ type: 'click', target: { ref: '@e2' }, button: 'right' });
    expect(result.ok).toBe(false);
  });

  it('should clear before typing unless told not to', () => {
    expect(actionToCommands({ type: 'type', ref: '@e3', text: 'hi' })).toEqual({ ok: true, value: [['fill', '@e3', 'hi']] });
    expect(actionToCommands({ type: 'type', ref: '@e3', text: 'hi', clear: false })).toEqual({ ok: true, value: [['type', '@e3', 'hi']] });
  });

  it('should keep model text as one argument even when it looks like a flag', () => {
    expect(actionToCommands({ type: 'type', ref: '@e3', text: '--executable-path /bin/sh' })).toEqual({
      ok: true,
      value: [['fill', '@e3', '--executable-path /bin/sh']],
    });
  });

  it('should map the remaining actions', () => {
    expect(actionToCommands({ type: 'navigate', url: 'https://a.com' })).toEqual({ ok: true, value: [['open', 'https://a.com']] });
    expect(actionToCommands({ type: 'check', ref: '@e1', checked: false })).toEqual({ ok: true, value: [['uncheck', '@e1']] });
    expect(actionToCommands({ type: 'scroll', direction: 'down' })).toEqual({ ok: true, value: [['scroll', 'down', '600']] });
    expect(actionToCommands({ type: 'dialog', accept: true, promptText: 'x' })).toEqual({ ok: true, value: [['dialog', 'accept', 'x']] });
    expect(actionToCommands({ type: 'dialog', accept: false })).toEqual({ ok: true, value: [['dialog', 'dismiss']] });
    expect(actionToCommands({ type: 'upload', ref: '@e7', files: [] }).ok).toBe(false);
  });
});

describe('refsOf / dependsOnObservation', () => {
  it('should require a fresh observation for ref and coordinate actions only', () => {
    expect(refsOf({ type: 'select', ref: '@e8', value: 'in' })).toEqual(['@e8']);
    expect(dependsOnObservation({ type: 'click', target: { x: 1, y: 1 } })).toBe(true);
    expect(dependsOnObservation({ type: 'navigate', url: 'https://a.com' })).toBe(false);
    expect(dependsOnObservation({ type: 'key', keys: 'Enter' })).toBe(false);
  });
});
