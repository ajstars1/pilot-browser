import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { findRef, parseSnapshotTree } from '../tree.js';

// Real `agent-browser snapshot -i` output captured during the day-1 spike.
const fixture = readFileSync(new URL('./fixture-snapshot.txt', import.meta.url), 'utf8');

describe('parseSnapshotTree', () => {
  const lines = parseSnapshotTree(fixture);

  it('should parse every ref line of a real snapshot', () => {
    expect(lines.length).toBe(163);
    expect(lines[0]).toEqual({ ref: 'e1', role: 'heading', name: 'Spike fixture', depth: 0, attrs: ['level=1'], value: '' });
  });

  it('should keep the name of role-less clickable elements that the JSON refs map drops', () => {
    expect(findRef(lines, { name: 'Save draft' })).toMatchObject({ ref: 'e3', role: 'generic' });
  });

  it('should capture trailing values and attributes', () => {
    expect(findRef(lines, { role: 'combobox', name: 'Country' })).toMatchObject({ attrs: ['expanded=false'], value: 'Choose…' });
  });

  it('should nest cross-origin iframe content under the iframe', () => {
    const email = findRef(lines, { role: 'textbox', name: 'Email' });
    expect(email?.depth).toBe(1);
  });

  it('should parse CRLF output (Windows) the same as LF', () => {
    expect(parseSnapshotTree(fixture.replace(/\r?\n/g, '\r\n'))).toEqual(parseSnapshotTree(fixture.replace(/\r\n/g, '\n')));
  });

  it('should handle escaped quotes and skip lines without refs', () => {
    const parsed = parseSnapshotTree('- heading "Say \\"hi\\"" [ref=e9]\n- generic\n- text "no ref"');
    expect(parsed).toEqual([{ ref: 'e9', role: 'heading', name: 'Say "hi"', depth: 0, attrs: [], value: '' }]);
  });
});
