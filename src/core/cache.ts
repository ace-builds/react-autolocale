import path from "node:path";
import type { SiteConfig } from "./site.js";
import { digitsPreserved, mask, unmask, type Translator } from "./translate.js";

export type Dict = Record<string, string>;

/** Where versions before the CLI workflow kept translations (keyed by source text). Read only, for migration. */
export function legacyCacheDir(root: string): string {
  return path.join(root, "node_modules", ".cache", "react-autolocale");
}

export function legacyCacheFile(root: string, lang: string): string {
  return path.join(legacyCacheDir(root), `${lang}.json`);
}

/** Strings that are entirely an excluded phrase need no translation. */
export function needsTranslation(s: string, exclude: string[]): boolean {
  return !exclude.includes(s.trim());
}

export interface TranslateTextsOptions {
  strings: string[];
  from: string;
  to: string;
  exclude: string[];
  /** Where each string appears ("button", "h1", ...), passed to engines that can use it. */
  contexts?: Record<string, string>;
  /** This language's required terms: { Roadmap: "Feuille de route" }. */
  glossary?: Record<string, string>;
  translator: Translator;
  log?: (msg: string) => void;
}

/**
 * Machine-translates `strings` with protected pieces masked. Strings whose result lost a placeholder or changed
 * a number are retried once with numbers locked; if that fails too they are reported in `failed`, never
 * returned as a wrong or empty translation. Provider errors propagate to the caller.
 */
export async function translateTexts(opts: TranslateTextsOptions): Promise<{ translated: Dict; failed: string[] }> {
  const { strings, exclude, translator } = opts;
  const terms = opts.glossary ?? {};
  const translated: Dict = {};
  const failed: string[] = [];
  for (const s of strings) if (terms[s]) translated[s] = terms[s]!; // a whole string that is a glossary term
  const todo = strings.filter((s) => !terms[s]);
  if (!todo.length) return { translated, failed };

  const ctx = todo.map((s) => opts.contexts?.[s] ?? "");
  const run = async (items: string[], contextList: string[], numbers: boolean) => {
    const jobs = items.map((s) => mask(s, exclude, { glossary: terms, numbers }));
    const out = await translator.translate(jobs.map((j) => j.masked), opts.from, opts.to, contextList);
    return jobs.map((job, i) => unmask(out[i] ?? "", job.phrases));
  };
  const first = await run(todo, ctx, false);
  const redo = todo.map((_, i) => i).filter((i) => !first[i] || !digitsPreserved(todo[i]!, first[i]!));
  const second = redo.length ? await run(redo.map((i) => todo[i]!), redo.map((i) => ctx[i]!), true) : [];
  todo.forEach((source, i) => {
    const result = redo.includes(i) ? second[redo.indexOf(i)] : first[i];
    if (result && result.trim()) translated[source] = result;
    else failed.push(source);
  });
  return { translated, failed };
}

export interface EnsureOptions {
  site: SiteConfig;
  strings: string[];
  contexts?: Record<string, string>;
  glossary?: Record<string, Record<string, string>>;
  /** Hand-written fixes: { fr: { "Contact": "Contact" } }. They always win over machine translation. */
  overrides?: Record<string, Record<string, string>>;
  getTranslator: () => Translator;
  log?: (msg: string) => void;
}

/** Translates every string into every language in memory (no files). Used by tests and the model checks. */
export async function ensureTranslations(opts: EnsureOptions): Promise<Record<string, Dict>> {
  const { site } = opts;
  const wanted = opts.strings.filter((s) => needsTranslation(s, site.exclude));
  const result: Record<string, Dict> = {};
  for (const lang of site.languages) {
    const fixed = opts.overrides?.[lang] ?? {};
    const { translated } = await translateTexts({
      strings: wanted.filter((s) => !fixed[s]),
      from: site.original,
      to: lang,
      exclude: site.exclude,
      contexts: opts.contexts,
      glossary: opts.glossary?.[lang],
      translator: opts.getTranslator(),
      log: opts.log,
    });
    result[lang] = { ...translated, ...fixed };
  }
  return result;
}
