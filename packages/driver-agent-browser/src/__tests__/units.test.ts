import { readFileSync } from 'node:fs';
import { parseSnapshotTree } from '@pilot-browser/core';
import { describe, expect, it } from 'vitest';
import { nativeBinaryName } from '../binary.js';
import { toBrowserError } from '../errors.js';
import { pngSize } from '../png.js';
import { clipToViewport, type Box } from '../viewport.js';

describe('toBrowserError', () => {
  it('should classify agent-browser failures', () => {
    expect(toBrowserError('Unknown ref: e999').code).toBe('stale_ref');
    expect(toBrowserError('x', 'tab_gone').code).toBe('tab_gone');
    expect(toBrowserError('CDP command timed out: Page.navigate').code).toBe('timeout');
    expect(toBrowserError('Chrome is waiting for remote-debugging approval').code).toBe('needs_user');
    expect(toBrowserError('No element matches selector').code).toBe('not_found');
    expect(toBrowserError('something else')).toEqual({ code: 'engine_error', message: 'something else', retryable: false });
  });
});

describe('nativeBinaryName', () => {
  it('should pick the shipped binary per platform', () => {
    expect(nativeBinaryName('linux', 'x64', false)).toBe('agent-browser-linux-x64');
    expect(nativeBinaryName('linux', 'arm64', true)).toBe('agent-browser-linux-musl-arm64');
    expect(nativeBinaryName('darwin', 'arm64', false)).toBe('agent-browser-darwin-arm64');
    expect(nativeBinaryName('win32', 'arm64', false)).toBe('agent-browser-win32-x64.exe');
    expect(nativeBinaryName('freebsd', 'x64', false)).toBeNull();
  });
});

describe('pngSize', () => {
  it('should read IHDR dimensions and reject non-PNG bytes', () => {
    const png = new Uint8Array(24);
    png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    new DataView(png.buffer).setUint32(16, 1280);
    new DataView(png.buffer).setUint32(20, 633);
    expect(pngSize(png)).toEqual({ width: 1280, height: 633 });
    expect(pngSize(new Uint8Array(24))).toBeNull();
  });
});

describe('clipToViewport', () => {
  const tree = readFileSync(new URL('../../../core/src/snapshot/__tests__/fixture-snapshot.txt', import.meta.url), 'utf8');
  const lines = parseSnapshotTree(tree);
  const viewport = { width: 1280, height: 633 };
  // Boxes measured from the real fixture during the build (main frame viewport-relative, iframe frame-relative).
  const measured: Record<string, Box> = {
    e1: { x: 24, y: 24, width: 1232, height: 41 },
    e2: { x: 24, y: 86, width: 34, height: 21 },
    e3: { x: 24, y: 158, width: 95, height: 32 },
    e7: { x: 24, y: 240, width: 140, height: 21 },
    e8: { x: 84, y: 315, width: 102, height: 19 },
    e4: { x: 24, y: 387, width: 104, height: 21 },
    e5: { x: 24, y: 460, width: 424, height: 94 },
    e163: { x: 48, y: 8, width: 185, height: 21 },
    e162: { x: 236, y: 8, width: 46, height: 21 },
  };
  const boxes = new Map<string, Box>(Object.entries(measured));
  // Offscreen links sit far below the fold.
  for (const l of lines) if (l.role === 'link') boxes.set(l.ref, { x: 40, y: 1600, width: 160, height: 20 });

  it('should keep on-screen refs, their zero-size options and iframe children', () => {
    const { visible, omitted } = clipToViewport(lines, boxes, viewport);
    expect(visible.map((l) => l.ref)).toEqual(['e1', 'e2', 'e3', 'e7', 'e8', 'e159', 'e160', 'e161', 'e4', 'e5', 'e163', 'e162']);
    expect(omitted).toBe(lines.length - 12);
  });

  it('should hide iframe children when the iframe scrolls out of view', () => {
    const scrolled = new Map(boxes);
    scrolled.set('e5', { x: 24, y: -200, width: 424, height: 94 });
    const { visible } = clipToViewport(lines, scrolled, viewport);
    expect(visible.map((l) => l.ref)).not.toContain('e163');
  });

  it('should re-emit the original lines unchanged', () => {
    const { tree: clipped } = clipToViewport(lines, boxes, viewport);
    expect(clipped.split('\n')[2]).toBe('- generic "Save draft" [ref=e3] clickable [cursor:pointer, onclick]');
  });
});
