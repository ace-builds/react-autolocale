import fs from "node:fs";
import path from "node:path";
import { ensureBanner } from "../core/banner.js";
import { catalogFile, importLegacyCache, removeFromCatalogs, translateMissing, type TranslateReport } from "../core/catalog.js";
import { loadEnv } from "../core/env.js";
import { writeJson } from "../core/files.js";
import { manifestFile, readManifest, scanProject, type ScanReport } from "../core/manifest.js";
import { readOverrides } from "../core/overrides.js";
import type { Project } from "../core/project.js";
import { createProvider } from "../core/providers.js";
import { TranslationError } from "../core/translate.js";
import type { Prompter } from "./prompt.js";

export interface Out {
  log(msg: string): void;
}

const ok = (out: Out, msg: string) => out.log(`✓ ${msg}`);
const note = (out: Out, msg: string) => out.log(`! ${msg}`);
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** `scan`: extract strings and update the manifest + source catalog. No translation, no network. */
export function runScan(project: Project, out: Out): ScanReport {
  const report = scanProject(project);
  ok(out, `Scanned ${plural(report.fileCount, "source file")}`);
  ok(out, `Found ${plural(report.added.length, "new string")} (${report.active.length} in use)`);
  if (report.removed.length) {
    note(out, `${plural(report.removed.length, "string")} no longer in the source; translations kept (remove them with \`npx react-autolocale clean\`).`);
  }
  if (report.previousSource) {
    note(out, `The source language changed from ${report.previousSource} to ${project.site.original}. Existing translations were made from ${report.previousSource}.`);
  }
  if (report.previousOutput) migrateOutput(project, report.previousOutput, out);
  return report;
}

/**
 * The catalogs moved (a new `output`, or the default changed). Old files are never moved or deleted: target
 * catalogs missing at the new location are copied over, and the old folder is left for the developer to remove.
 */
function migrateOutput(project: Project, previous: string, out: Out): void {
  const oldDir = path.resolve(project.root, previous);
  if (!fs.existsSync(oldDir) || oldDir === project.output) return;
  const copied: string[] = [];
  for (const lang of project.site.languages) {
    const from = path.join(oldDir, `${lang}.json`);
    const to = catalogFile(project, lang);
    if (fs.existsSync(from) && !fs.existsSync(to)) (fs.copyFileSync(from, to), copied.push(lang));
  }
  note(
    out,
    `Catalogs were previously in ${previous}/ and are now written to ${project.outputRel}/.` +
      (copied.length ? ` Copied ${copied.join(", ")} catalogs to the new folder.` : "") +
      ` The old folder was left untouched: check the new one, then delete ${previous}/ yourself` +
      ` (or set output: "${previous}" in auto-locale.config.ts to keep using it).`,
  );
}

export interface TranslateFlags {
  langs?: string[];
}

/** `translate`: fill missing catalog entries with the configured provider. */
export async function runTranslate(project: Project, flags: TranslateFlags, out: Out): Promise<TranslateReport | null> {
  const manifest = fs.existsSync(manifestFile(project)) ? readManifest(project) : null;
  if (!manifest) throw new Error("No manifest yet. Run `npx react-autolocale generate` (or `scan` first).");
  const langs = flags.langs ?? project.site.languages;
  const unknown = langs.filter((l) => !project.site.languages.includes(l));
  if (unknown.length) throw new Error(`--lang ${unknown.join(",")} is not a target language (targets: ${project.site.languages.join(", ")}).`);

  const imported = importLegacyCache(project);
  if (imported) ok(out, `Imported ${plural(imported, "translation")} made by an older version (node_modules/.cache/react-autolocale, left in place)`);

  loadEnv(project.root);
  let provider;
  try {
    provider = await createProvider(project, out.log);
  } catch (err) {
    if (err instanceof TranslationError) throw new Error(err.message);
    throw err;
  }
  if (provider.name === "local") {
    out.log(
      "Using the local models (CPU). Downloaded once into ~/.cache/react-autolocale and reused by every project: about 110 MB per " +
        "English->X language (OPUS-MT), 870 MB for other pairs (NLLB-200), plus a 470 MB engine if your project has no @huggingface/transformers.",
    );
  } else {
    out.log(`Using ${provider.name}.`);
  }

  // Ctrl+C: finish the chunk in flight, save it, stop. A second Ctrl+C exits immediately.
  let interrupted = false;
  const onSigint = () => {
    interrupted = true;
    out.log("\nStopping after the current batch (press Ctrl+C again to quit now)...");
    process.once("SIGINT", () => process.exit(130));
  };
  process.once("SIGINT", onSigint);
  let report: TranslateReport;
  try {
    report = await translateMissing(project, manifest, {
      translator: provider.translator,
      providerName: provider.name,
      overrides: readOverrides(project.root),
      langs,
      chunkSize: provider.chunkSize,
      shouldStop: () => interrupted,
      log: (m) => out.log(`  ${m}`),
    });
  } finally {
    process.removeListener("SIGINT", onSigint);
  }

  if (!report.stopped) {
    try {
      await ensureBanner({ output: project.output, langs: [project.site.original, ...project.site.languages], getTranslator: () => provider.translator });
    } catch (err) {
      note(out, `Language-suggestion banner not translated (${(err as Error).message}); it shows in English.`);
    }
  }
  printTranslateReport(project, report, out);
  return report;
}

function printTranslateReport(project: Project, report: TranslateReport, out: Out): void {
  const langs = Object.entries(report.langs);
  const sum = (k: "kept" | "reused" | "translated" | "overridden") => langs.reduce((n, [, r]) => n + r[k], 0);
  const failedTotal = langs.reduce((n, [, r]) => n + r.failed.length, 0);
  ok(out, `Kept ${plural(sum("kept"), "existing translation")}${sum("reused") ? `, reused ${sum("reused")} from the cache/glossary` : ""}`);
  if (sum("overridden")) ok(out, `${plural(sum("overridden"), "string")} handled by react-autolocale.overrides.json`);
  ok(out, `Translated ${plural(sum("translated"), "string")}${sum("translated") ? ` (${langs.map(([l, r]) => `${l} ${r.translated}`).join(", ")})` : ""}`);
  ok(out, `Updated ${plural(langs.length, "locale catalog")} in ${project.outputRel}/`);
  for (const [lang, r] of langs) {
    if (!r.failed.length) continue;
    out.log(`✗ ${lang}: ${plural(r.failed.length, "string")} failed (shown in ${project.site.original} until fixed)`);
    for (const f of r.failed.slice(0, 5)) out.log(`    ${f.id} "${f.text.slice(0, 60)}": ${f.reason}`);
    if (r.failed.length > 5) out.log(`    ...and ${r.failed.length - 5} more`);
  }
  if (report.stopped) out.log(`✗ Stopped: ${report.stopped}. Everything finished so far was saved.`);
  if (failedTotal || report.stopped) out.log("Retry the remaining strings with: npx react-autolocale translate");
}

/** `generate` / `sync`: scan, then translate what is missing. Both are incremental. */
export async function runGenerate(project: Project, flags: TranslateFlags, out: Out): Promise<{ scan: ScanReport; translate: TranslateReport | null }> {
  out.log("React Auto Locale\n");
  const scan = runScan(project, out);
  const translate = await runTranslate(project, flags, out);
  out.log("\nNo source files modified.");
  return { scan, translate };
}

/** `clean`: list messages no longer in the source and, once confirmed, remove them from the catalogs. */
export async function runClean(project: Project, flags: { yes?: boolean }, prompt: Prompter, out: Out): Promise<number> {
  const { manifest } = scanProject(project);
  const unused = Object.entries(manifest.messages).filter(([, m]) => m.status === "unused");
  if (!unused.length) {
    ok(out, "Nothing to clean: every catalog entry is still used.");
    return 0;
  }
  out.log(`${plural(unused.length, "string")} no longer appear in the source:`);
  for (const [id, m] of unused.slice(0, 20)) out.log(`  ${id} "${m.text.slice(0, 70)}"`);
  if (unused.length > 20) out.log(`  ...and ${unused.length - 20} more`);
  const go = flags.yes || (await prompt.confirm("Remove them and their translations from every catalog?", false));
  if (!go) {
    out.log(prompt.interactive ? "Nothing removed." : "Nothing removed. Run `npx react-autolocale clean --yes` to remove them.");
    return 0;
  }
  const ids = unused.map(([id]) => id);
  const removed = removeFromCatalogs(project, ids);
  for (const id of ids) delete manifest.messages[id];
  writeJson(manifestFile(project), manifest);
  ok(out, `Removed ${plural(ids.length, "string")} (${plural(removed, "catalog entry")}).`);
  return ids.length;
}
