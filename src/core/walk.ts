import fs from "node:fs";
import path from "node:path";

const EXTENSIONS = new Set([".tsx", ".jsx", ".ts", ".js"]);
const IGNORED_DIRS = new Set(["node_modules", "dist", "build", "coverage"]);

export function isSourceFile(file: string): boolean {
  return EXTENSIONS.has(path.extname(file)) && !file.endsWith(".d.ts") && !/\.(test|spec|stories|story)\./.test(file);
}

/** Source files under `dir`. `skip` lists absolute folders to leave out (the generated catalogs, internal metadata). */
export function* walk(dir: string, skip: string[] = [], matches: (file: string) => boolean = isSourceFile): Generator<string> {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || IGNORED_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (skip.some((d) => path.resolve(d) === full)) continue;
    if (entry.isDirectory()) yield* walk(full, skip, matches);
    else if (matches(full)) yield full;
  }
}
