import type { RefLine } from '@pilot-browser/core';

export interface Box {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface Viewport {
  readonly width: number;
  readonly height: number;
}

export interface ClipResult {
  readonly tree: string;
  readonly visible: readonly RefLine[];
  readonly omitted: number;
}

const intersects = (b: Box, vp: Viewport): boolean =>
  b.width > 0 && b.height > 0 && b.x + b.width > 0 && b.y + b.height > 0 && b.x < vp.width && b.y < vp.height;

/**
 * Keep only ref lines that are on screen. agent-browser boxes are viewport-relative for the
 * main frame and frame-relative inside iframes, so iframe descendants get the iframe's offset
 * and must also fall inside the iframe. Zero-size nodes (e.g. <option>s of a closed select)
 * inherit visibility from their nearest ancestor.
 */
export const clipToViewport = (lines: readonly RefLine[], boxes: ReadonlyMap<string, Box>, viewport: Viewport): ClipResult => {
  const visible: RefLine[] = [];
  const ancestors: { line: RefLine; abs: Box | null; visible: boolean; isFrame: boolean }[] = [];
  for (const line of lines) {
    while (ancestors.length > 0 && (ancestors.at(-1)?.line.depth ?? -1) >= line.depth) ancestors.pop();
    const parent = ancestors.at(-1);
    const frame = [...ancestors].reverse().find((a) => a.isFrame);
    const raw = boxes.get(line.ref);
    let abs: Box | null = null;
    let isVisible: boolean;
    if (raw && raw.width > 0 && raw.height > 0) {
      abs = frame?.abs ? { ...raw, x: raw.x + frame.abs.x, y: raw.y + frame.abs.y } : raw;
      const inFrame = !frame?.abs || intersects({ ...abs, x: abs.x - frame.abs.x, y: abs.y - frame.abs.y }, frame.abs);
      isVisible = intersects(abs, viewport) && inFrame && (frame ? frame.visible : true);
    } else {
      isVisible = parent?.visible ?? false;
    }
    const isFrame = line.role.toLowerCase() === 'iframe';
    ancestors.push({ line, abs, visible: isVisible, isFrame });
    if (isVisible) visible.push(line);
  }
  const omitted = lines.length - visible.length;
  const tree = visible.map((l) => l.raw).join('\n');
  return { tree, visible, omitted };
};
