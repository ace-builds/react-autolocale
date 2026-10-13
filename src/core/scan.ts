import fs from "node:fs";
import path from "node:path";
import { collectProjectFacts } from "./facts.js";
import { isContentJson, jsonStrings } from "./json.js";
import { extractItems } from "./transform.js";
import { walk } from "./walk.js";

export { isSourceFile, walk } from "./walk.js";

export interface ScanResult {
  strings: string[];
  /** The element or attribute each string first appears in. */
  contexts: Record<string, string>;
  /** Project-relative files each string appears in. */
  files: Record<string, string[]>;
  /** How many source files were read. */
  fileCount: number;
}

/** `from "./data.json"`, `import("./data.json")`, `require("./data.json")` */
const JSON_IMPORT = /(?:from\s*|import\s*\(?\s*|require\s*\(\s*)["']([^"']+\.json)["']/g;

/** Every translatable string under the configured folders, in stable file order, and where each appears. */
export function scanProjectDetailed(root: string, include: string[], opts: { skip?: string[] } = {}): ScanResult {
  const skip = opts.skip ?? [];
  const found = new Set<string>();
  const contexts: Record<string, string> = {};
  const files: Record<string, string[]> = {};
  let fileCount = 0;
  const facts = collectProjectFacts(root, include); // strings the code compares or uses as keys are never translated
  const add = (text: string, context: string, rel: string) => {
    found.add(text);
    contexts[text] ??= context;
    const list = (files[text] ??= []);
    if (!list.includes(rel)) list.push(rel);
  };

  const sourceFiles: string[] = [];
  for (const dir of include) sourceFiles.push(...walk(path.resolve(root, dir), skip));
  const jsonOnDisk = include.flatMap((dir) => [...walk(path.resolve(root, dir), skip, (f) => isContentJson(f, skip))]);
  const importedJson = new Set<string>();

  for (const file of sourceFiles) {
    fileCount++;
    const code = fs.readFileSync(file, "utf8");
    const rel = path.relative(root, file).split(path.sep).join("/");
    const items = extractItems(code, file, facts);
    for (const s of items.strings) add(s, items.contexts[s] ?? "", rel);
    for (const m of code.matchAll(JSON_IMPORT)) {
      const spec = m[1]!;
      if (spec.startsWith(".")) {
        const abs = path.resolve(path.dirname(file), spec);
        if (jsonOnDisk.includes(abs)) importedJson.add(abs);
      } else {
        const tail = "/" + spec.replace(/^[@~]\/?|^\/+/, ""); // "@/data/faq.json" -> "/data/faq.json"
        for (const j of jsonOnDisk) if (j.split(path.sep).join("/").endsWith(tail)) importedJson.add(j);
      }
    }
  }
  for (const file of importedJson) {
    const rel = path.relative(root, file).split(path.sep).join("/");
    for (const { text, key } of jsonStrings(fs.readFileSync(file, "utf8"), facts)) add(text, key || "text", rel);
  }
  return { strings: [...found], contexts, files, fileCount };
}

export function scanProject(root: string, include: string[]): string[] {
  return scanProjectDetailed(root, include).strings;
}
