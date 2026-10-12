import fs from "node:fs";
import path from "node:path";
import { legacyCacheDir, legacyCacheFile, needsTranslation, translateTexts, type Dict } from "./cache.js";
import { readJson, writeJson } from "./files.js";
import { messageId } from "./ids.js";
import type { Manifest } from "./manifest.js";
import { readManifest } from "./manifest.js";
import type { Overrides } from "./overrides.js";
import type { Project } from "./project.js";
import type { Translator } from "./translate.js";

export function catalogFile(project: Project, lang: string): string {
  return path.join(project.output, `${lang}.json`);
}

export function readCatalog(project: Project, lang: string): Dict {
  return readJson<Dict>(catalogFile(project, lang), {});
}

/** A usable catalog value: non-empty text. Anything else counts as missing. */
const valid = (v: unknown): v is string => typeof v === "string" && v.trim() !== "";

// --- Provider cache (.auto-locale/cache.json) -------------------------------------------------------------
// Every machine translation ever made, keyed by source text. It only fills catalog entries that are missing
// (e.g. a string removed and later restored), so it never overwrites a catalog value.

interface CacheEntry {
  value: string;
  provider: string;
}
interface CacheFile {
  version: 1;
  entries: Record<string, Record<string, CacheEntry>>;
}

const cachePath = (project: Project) => path.join(project.meta, "cache.json");

export function readCache(project: Project): CacheFile {
  return readJson<CacheFile>(cachePath(project), { version: 1, entries: {} });
}

/**
 * Copies translations made by older versions (node_modules/.cache/react-autolocale, keyed by text) into the
 * cache, so upgrading never retranslates. The old files are left in place.
 */
export function importLegacyCache(project: Project): number {
  if (!fs.existsSync(legacyCacheDir(project.root))) return 0;
  const cache = readCache(project);
  let added = 0;
  for (const lang of project.site.languages) {
    const old = readJson<Dict>(legacyCacheFile(project.root, lang), {});
    const entries = (cache.entries[lang] ??= {});
    for (const [text, value] of Object.entries(old)) {
      if (valid(value) && !entries[text]) (entries[text] = { value, provider: "legacy" }, added++);
    }
  }
  if (added) writeJson(cachePath(project), cache);
  return added;
}

// --- Translating missing entries ---------------------------------------------------------------------------

export interface LangReport {
  /** Entries already in the catalog (left untouched). */
  kept: number;
  /** Filled from the cache or the glossary without calling the provider. */
  reused: number;
  /** Translated by the provider in this run. */
  translated: number;
  /** Handled by the overrides file instead. */
  overridden: number;
  failed: { id: string; text: string; reason: string }[];
}

export interface TranslateReport {
  langs: Record<string, LangReport>;
  /** The run stopped early (Ctrl+C or a fatal provider error); everything finished so far was saved. */
  stopped?: string;
}

export interface TranslateOptions {
  translator: Translator;
  /** Recorded in the cache next to each translation. */
  providerName: string;
  overrides?: Overrides;
  /** Only these languages (default: all targets). */
  langs?: string[];
  /** Strings per provider call batch; each finished chunk is written to disk before the next starts. */
  chunkSize?: number;
  shouldStop?: () => boolean;
  log?: (msg: string) => void;
}

/** Fills every active message missing from each target catalog. Valid existing entries are never replaced. */
export async function translateMissing(project: Project, manifest: Manifest, opts: TranslateOptions): Promise<TranslateReport> {
  const { site } = project;
  const log = opts.log ?? (() => {});
  const chunkSize = opts.chunkSize ?? 40;
  const cache = readCache(project);
  const report: TranslateReport = { langs: {} };
  const active = Object.entries(manifest.messages).filter(([, m]) => m.status === "active" && needsTranslation(m.text, site.exclude));
  const contexts = Object.fromEntries(active.map(([, m]) => [m.text, m.context]));

  for (const lang of opts.langs ?? site.languages) {
    const r: LangReport = { kept: 0, reused: 0, translated: 0, overridden: 0, failed: [] };
    report.langs[lang] = r;
    const catalog = readCatalog(project, lang);
    const cached = (cache.entries[lang] ??= {});
    const fixed = opts.overrides?.[lang] ?? {};
    const terms = project.glossary[lang] ?? {};
    const missing: [string, string][] = [];
    for (const [id, m] of active) {
      if (valid(catalog[id])) r.kept++;
      else if (valid(fixed[m.text])) r.overridden++;
      else if (valid(cached[m.text]?.value)) (catalog[id] = cached[m.text]!.value, r.reused++);
      else if (valid(terms[m.text])) (catalog[id] = terms[m.text]!, r.reused++);
      else missing.push([id, m.text]);
    }
    if (r.reused) writeJson(catalogFile(project, lang), catalog);
    if (!missing.length) continue;

    log(`${lang}: translating ${missing.length} string${missing.length === 1 ? "" : "s"}...`);
    for (let i = 0; i < missing.length; i += chunkSize) {
      if (opts.shouldStop?.()) {
        report.stopped ??= "interrupted";
        break;
      }
      const chunk = missing.slice(i, i + chunkSize);
      try {
        const { translated, failed } = await translateTexts({
          strings: chunk.map(([, text]) => text),
          from: site.original,
          to: lang,
          exclude: site.exclude,
          contexts,
          glossary: terms,
          translator: opts.translator,
        });
        for (const [id, text] of chunk) {
          if (valid(translated[text])) {
            catalog[id] = translated[text]!;
            cached[text] = { value: translated[text]!, provider: opts.providerName };
            r.translated++;
          }
        }
        for (const text of failed) {
          r.failed.push({ id: messageId(text), text, reason: "the result lost a number, placeholder or protected phrase" });
        }
      } catch (err) {
        const reason = (err as Error).message;
        for (const [id, text] of chunk) r.failed.push({ id, text, reason });
        if ((err as { fatal?: boolean }).fatal) report.stopped = reason;
      }
      // Persist after every chunk: an interrupted run keeps everything finished so far.
      writeJson(catalogFile(project, lang), catalog);
      writeJson(cachePath(project), cache);
      log(`${lang}: ${Math.min(i + chunkSize, missing.length)}/${missing.length}`);
      if (report.stopped) break;
    }
    if (report.stopped) break;
  }
  return report;
}

/** Removes ids from every catalog (source and targets). Returns how many entries were removed. */
export function removeFromCatalogs(project: Project, ids: string[]): number {
  let removed = 0;
  for (const lang of [project.site.original, ...project.site.languages]) {
    const file = catalogFile(project, lang);
    if (!fs.existsSync(file)) continue;
    const catalog = readCatalog(project, lang);
    for (const id of ids) if (id in catalog) (delete catalog[id], removed++);
    writeJson(file, catalog);
  }
  return removed;
}

// --- What the Vite plugin serves ---------------------------------------------------------------------------

export interface LoadedDicts {
  /** Message id -> text, per target language: what the runtime looks up. */
  byId: Record<string, Dict>;
  /** Source text -> text, per target language: used for the translated <head> tags. */
  byText: Record<string, Dict>;
  /** Active, translatable messages with no translation, per language. */
  missing: Record<string, number>;
  /** Some translations came from the pre-CLI cache in node_modules. */
  usedLegacy: boolean;
}

/** Reads the generated catalogs (no translation, no network). Overrides win; legacy translations fill gaps. */
export function loadDicts(project: Project, overrides: Overrides = {}): LoadedDicts {
  const manifest = fs.existsSync(path.join(project.meta, "manifest.json")) ? readManifest(project) : null;
  const source = readCatalog(project, project.site.original);
  const legacyText: Dict = {};
  const textOf = (id: string) => manifest?.messages[id]?.text ?? source[id] ?? legacyText[id];
  const isActive = (id: string) => !manifest || manifest.messages[id]?.status === "active";
  const out: LoadedDicts = { byId: {}, byText: {}, missing: {}, usedLegacy: false };

  for (const lang of project.site.languages) {
    const byId: Dict = {};
    for (const [id, value] of Object.entries(readCatalog(project, lang))) if (valid(value) && isActive(id)) byId[id] = value;
    for (const [text, value] of Object.entries(readJson<Dict>(legacyCacheFile(project.root, lang), {}))) {
      const id = messageId(text);
      if (valid(value) && !byId[id] && (!manifest || isActive(id))) {
        byId[id] = value;
        legacyText[id] = text;
        out.usedLegacy = true;
      }
    }
    for (const [text, value] of Object.entries(overrides[lang] ?? {})) if (valid(value)) byId[messageId(text)] = value;

    const byText: Dict = {};
    for (const [id, value] of Object.entries(byId)) {
      const text = textOf(id);
      if (text) byText[text] = value;
    }
    for (const [text, value] of Object.entries(overrides[lang] ?? {})) if (valid(value)) byText[text] = value;
    out.byId[lang] = byId;
    out.byText[lang] = byText;
    out.missing[lang] = manifest
      ? Object.entries(manifest.messages).filter(([id, m]) => m.status === "active" && needsTranslation(m.text, project.site.exclude) && !byId[id]).length
      : 0;
  }
  return out;
}
