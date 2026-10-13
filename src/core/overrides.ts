import fs from "node:fs";
import path from "node:path";
import { loadDicts } from "./catalog.js";
import { writeJson } from "./files.js";
import type { Project } from "./project.js";

export type Overrides = Record<string, Record<string, string>>;

/** A committed file the developer edits to correct translations. It always wins over machine translation. */
export const OVERRIDES_FILE = "react-autolocale.overrides.json";

export function readOverrides(root: string): Overrides {
  const file = path.join(root, OVERRIDES_FILE);
  if (!fs.existsSync(file)) return {};
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as Overrides;
  } catch (err) {
    throw new Error(`${OVERRIDES_FILE} is not valid JSON: ${(err as Error).message}`);
  }
}

/** Later arguments win. */
export function mergeOverrides(...all: (Overrides | undefined)[]): Overrides {
  const out: Overrides = {};
  for (const o of all) {
    for (const [lang, strings] of Object.entries(o ?? {})) out[lang] = { ...out[lang], ...strings };
  }
  return out;
}

/**
 * Writes every generated translation into the overrides file (keeping entries already there) so it can be
 * edited. Reads the catalogs through `loadDicts`, which also covers translations made by older versions.
 */
export function exportTranslations(project: Project): { file: string; languages: Record<string, number> } {
  const { byText } = loadDicts(project);
  const generated: Overrides = Object.fromEntries(Object.entries(byText).filter(([, d]) => Object.keys(d).length));
  if (!Object.keys(generated).length) throw new Error("No generated translations found. Run `npx react-autolocale generate` first.");

  const merged = mergeOverrides(generated, readOverrides(project.root)); // what is already in the file stays
  const file = path.join(project.root, OVERRIDES_FILE);
  writeJson(file, merged);
  return { file, languages: Object.fromEntries(Object.entries(merged).map(([l, s]) => [l, Object.keys(s).length])) };
}
