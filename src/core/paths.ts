import fs from "node:fs";
import path from "node:path";

/** Internal bookkeeping (manifest, translation cache), kept apart from the catalogs the app uses. */
export const META_DIR = ".auto-locale";

export function hasRootSrc(root: string): boolean {
  try {
    return fs.statSync(path.join(root, "src")).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Where catalogs are written, relative to the project root: an explicit `output` wins; otherwise
 * `src/generated/auto-locale` when the project has a root-level `src/`, else `generated/auto-locale`.
 */
export function defaultOutput(root: string): string {
  return hasRootSrc(root) ? "src/generated/auto-locale" : "generated/auto-locale";
}

export function resolveOutput(root: string, output?: string): string {
  return path.resolve(root, output ?? defaultOutput(root));
}

export function metaDir(root: string): string {
  return path.join(root, META_DIR);
}

/** Project-relative, forward slashes: how paths are stored in config and the manifest. */
export function toProjectPath(root: string, file: string): string {
  return path.relative(root, file).split(path.sep).join("/") || ".";
}
