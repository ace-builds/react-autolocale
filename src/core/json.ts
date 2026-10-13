import path from "node:path";
import { looksLikeCopy, NON_COPY_KEYS } from "./classify.js";
import type { ProjectFacts } from "./facts.js";
import { messageId } from "./ids.js";

/**
 * Text kept in JSON data files (`import content from "./content.json"`): products, FAQs, team members, page copy.
 * A string value is translated when it reads like text and its key is not a code key (id, url, type, ...).
 */

/** JSON files that are configuration, not content. */
const NOT_CONTENT = /(?:^|\/)(?:package(?:-lock)?|tsconfig[\w.-]*|jsconfig|composer|\.?eslintrc|\.?prettierrc|vercel|netlify|firebase|\w+\.config|[\w.-]+\.schema|manifest)\.json$/i;

export function isContentJson(file: string, skipDirs: string[] = []): boolean {
  const norm = file.split(path.sep).join("/");
  if (!norm.endsWith(".json") || NOT_CONTENT.test(norm) || norm.includes("/node_modules/")) return false;
  return !skipDirs.some((d) => norm.startsWith(d.split(path.sep).join("/").replace(/\/?$/, "/")));
}

function eligible(text: string, key: string, facts?: ProjectFacts): boolean {
  return text === text.trim() && !NON_COPY_KEYS.has(key) && !key.startsWith("$") && looksLikeCopy(text) && !facts?.codeValues.has(text);
}

export interface JsonString {
  text: string;
  /** The key it sits under ("title", "label", ...), used as context. */
  key: string;
}

/** The translatable strings in a JSON document, in document order. */
export function jsonStrings(raw: string, facts?: ProjectFacts): JsonString[] {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return [];
  }
  const out: JsonString[] = [];
  const visit = (v: unknown, key: string): void => {
    if (typeof v === "string") {
      if (eligible(v, key, facts)) out.push({ text: v, key });
    } else if (Array.isArray(v)) v.forEach((x) => visit(x, key)); // array items belong to the key above them
    else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) visit(x, k);
  };
  visit(data, "");
  return out;
}

const IDENT = /^[A-Za-z_$][\w$]*$/;
const RESERVED = new Set(["default", "class", "function", "var", "let", "const", "new", "delete", "return", "if", "else", "for", "while", "do", "switch", "case", "this", "typeof", "void", "with", "yield", "import", "export", "enum", "null", "true", "false"]);

/**
 * A JavaScript module equivalent to Vite's own JSON import (default export plus a named export per key), with
 * translatable strings wrapped in lookups that run when the module loads.
 */
export function jsonModule(raw: string, facts?: ProjectFacts): string | null {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (/"__proto__"\s*:/.test(raw)) return null; // an object literal would treat it as the prototype
  let used = false;
  const write = (v: unknown, key: string): string => {
    if (typeof v === "string") {
      if (!eligible(v, key, facts)) return JSON.stringify(v);
      used = true;
      return `__rlText(${JSON.stringify(messageId(v))},${JSON.stringify(v)})`;
    }
    if (Array.isArray(v)) return `[${v.map((x) => write(x, key)).join(",")}]`;
    if (v && typeof v === "object") return `{${Object.entries(v).map(([k, x]) => `${JSON.stringify(k)}:${write(x, k)}`).join(",")}}`;
    return JSON.stringify(v);
  };
  const body = write(data, "");
  if (!used) return null; // nothing to translate: let Vite handle the file as usual
  const named =
    data && typeof data === "object" && !Array.isArray(data)
      ? Object.keys(data).filter((k) => IDENT.test(k) && !RESERVED.has(k)).map((k) => `export const ${k} = __data[${JSON.stringify(k)}];`)
      : [];
  return `import { __rlText } from "react-autolocale";\nconst __data = ${body};\nexport default __data;\n${named.join("\n")}\n`;
}
