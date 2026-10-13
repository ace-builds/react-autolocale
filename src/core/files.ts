import fs from "node:fs";
import path from "node:path";

/** Writes through a temp file and a rename, so an interrupted run never leaves half a file behind. */
export function writeFileAtomic(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, file);
}

/** Pretty JSON with sorted keys, so new entries land in place and diffs stay small. Skips unchanged files. */
export function writeJson(file: string, data: unknown): boolean {
  const content = JSON.stringify(sortKeys(data), null, 2) + "\n";
  if (fs.existsSync(file) && fs.readFileSync(file, "utf8") === content) return false;
  writeFileAtomic(file, content);
  return true;
}

/** Missing file: `fallback`. Broken file: an error naming it (never silently treated as empty). */
export function readJson<T>(file: string, fallback: T): T {
  if (!fs.existsSync(file)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch (err) {
    throw new Error(`${file} is not valid JSON (${(err as Error).message}). Fix or delete it, then run the command again.`);
  }
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value as object)
        .sort()
        .map((k) => [k, sortKeys((value as Record<string, unknown>)[k])]),
    );
  }
  return value;
}
