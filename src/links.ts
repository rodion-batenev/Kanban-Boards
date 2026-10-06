export type Segment = { text: string; target?: string };

export type LinkTarget = { path: string; line?: number; column?: number };

const LINK_RE = /\[([^\]\n]+)\]\((?:<([^>\n]+)>|([^)\s][^)\n]*))\)|\bhttps?:\/\/[^\s<>()[\]]*[^\s<>()[\].,;:!?'"]/g;

/** Splits text into plain runs and links: `[label](target)`, `[label](<target with spaces>)`, bare http(s) URLs. */
export function tokenize(text: string): Segment[] {
  const out: Segment[] = [];
  let last = 0;
  for (const m of text.matchAll(LINK_RE)) {
    const start = m.index!;
    if (start > last) out.push({ text: text.slice(last, start) });
    out.push(m[1] !== undefined ? { text: m[1], target: (m[2] ?? m[3]).trim() } : { text: m[0], target: m[0] });
    last = start + m[0].length;
  }
  if (last < text.length) out.push({ text: text.slice(last) });
  return out;
}

export function formatLink(label: string, target: string): string {
  const safeLabel = label.replace(/[[\]\n]/g, '') || target;
  return /[\s()<>]/.test(target) ? `[${safeLabel}](<${target}>)` : `[${safeLabel}](${target})`;
}

/** True for URIs with a real scheme (not `file:`, not a Windows drive letter). */
export function isExternal(target: string): boolean {
  return /^[a-z][a-z0-9+.-]+:/i.test(target) && !/^file:/i.test(target);
}

/** Splits a trailing `#L12`, `#L12-L20`, `:12` or `:12:5` off a path. */
export function parseTarget(target: string): LinkTarget {
  const m = /^(.+?)(?:#L(\d+)(?:-L?\d+)?|:(\d+)(?::(\d+))?)?$/.exec(target);
  if (!m) return { path: target };
  const line = m[2] ?? m[3];
  return {
    path: m[1],
    line: line ? Number(line) : undefined,
    column: m[4] ? Number(m[4]) : undefined,
  };
}
