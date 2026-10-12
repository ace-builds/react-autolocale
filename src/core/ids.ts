import { createHash } from "node:crypto";

/**
 * Stable id for a source string: a hash of its normalized text, so moving code or editing other files never
 * changes it. Identical text shares one id (and one translation). 40 bits keeps collisions out of reach for
 * any real app; `findCollisions` reports one if it ever happens.
 */
export function messageId(text: string): string {
  return "msg_" + createHash("sha256").update(normalize(text)).digest("hex").slice(0, 10);
}

/** Whitespace runs collapse to one space, as they render in the browser. */
export function normalize(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** Different texts that hash to the same id. */
export function findCollisions(texts: Iterable<string>): [string, string][] {
  const seen = new Map<string, string>();
  const out: [string, string][] = [];
  for (const text of texts) {
    const id = messageId(text);
    const prev = seen.get(id);
    if (prev !== undefined && normalize(prev) !== normalize(text)) out.push([prev, text]);
    else seen.set(id, text);
  }
  return out;
}
