import type { RefLine } from '../types.js';

// `  - role "name" [attr, attr, ref=e12] trailing value`
const LINE = /^(\s*)- (\S+)(?: "((?:[^"\\]|\\.)*)")?(?: \[([^\]]*)\])?(.*)$/;

/**
 * Parse an accessibility snapshot rendered as an indented tree into ref lines.
 * The rendered tree is the source of truth: agent-browser 0.38.2's JSON `refs`
 * map leaves `name` empty for cursor-interactive (role-less) elements.
 */
export const parseSnapshotTree = (tree: string): RefLine[] => {
  const lines: RefLine[] = [];
  for (const raw of tree.split(/\r?\n/)) {
    const match = LINE.exec(raw);
    if (!match) continue;
    const [, indent = '', role = '', name = '', attrList = '', rest = ''] = match;
    const attrs = attrList
      .split(',')
      .map((a) => a.trim())
      .filter(Boolean);
    const refAttr = attrs.find((a) => a.startsWith('ref='));
    if (!refAttr) continue;
    lines.push({
      ref: refAttr.slice('ref='.length),
      role,
      name: name.replace(/\\"/g, '"'),
      depth: indent.length / 2,
      attrs: attrs.filter((a) => a !== refAttr),
      value: rest.replace(/^:\s*/, '').trim(),
    });
  }
  return lines;
};

export const findRef = (lines: readonly RefLine[], query: { readonly role?: string; readonly name: string }): RefLine | undefined =>
  lines.find((l) => (query.role === undefined || l.role === query.role) && l.name.includes(query.name));
