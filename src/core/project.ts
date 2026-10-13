import fs from "node:fs";
import path from "node:path";
import { PROVIDER_NAMES, type AutoLocaleConfig } from "./config.js";
import { getLanguage } from "./languages.js";
import { metaDir, resolveOutput, toProjectPath } from "./paths.js";
import { defaultInclude, findSite, type SiteConfig } from "./site.js";

export const CONFIG_FILES = ["auto-locale.config.ts", "auto-locale.config.mts", "auto-locale.config.js", "auto-locale.config.mjs"];

/** Everything a command or the Vite plugin needs, resolved once from the same rules. */
export interface Project {
  root: string;
  /** Absolute path of auto-locale.config.*, if the project has one. */
  configFile?: string;
  config: AutoLocaleConfig;
  site: SiteConfig;
  include: string[];
  /** Absolute catalog directory, and the same path relative to the root (as stored in the manifest). */
  output: string;
  outputRel: string;
  /** Absolute .auto-locale directory. */
  meta: string;
  glossary: Record<string, Record<string, string>>;
}

export function findConfigFile(root: string): string | undefined {
  return CONFIG_FILES.map((f) => path.join(root, f)).find((f) => fs.existsSync(f));
}

/** Loads auto-locale.config.* through Vite's own config loader, so TypeScript works without extra tooling. */
export async function loadConfigFile(file: string, root: string): Promise<AutoLocaleConfig> {
  const { loadConfigFromFile } = await import("vite");
  const loaded = await loadConfigFromFile({ command: "build", mode: "production" }, file, root, "silent");
  if (!loaded) throw new Error(`Could not load ${path.basename(file)}.`);
  return loaded.config as AutoLocaleConfig;
}

/** Throws a message that names the bad setting. */
export function validateConfig(config: AutoLocaleConfig, file = "auto-locale.config.ts"): void {
  const fail = (msg: string) => {
    throw new Error(`${file}: ${msg}`);
  };
  if (config === null || typeof config !== "object") fail("must export an object, e.g. export default defineConfig({ ... }).");
  const { sourceLocale, locales, output, include, exclude, provider } = config;
  if (sourceLocale !== undefined && (typeof sourceLocale !== "string" || !getLanguage(sourceLocale))) {
    fail(`sourceLocale "${sourceLocale}" is not a supported language code.`);
  }
  if (locales !== undefined) {
    if (!Array.isArray(locales) || !locales.length) fail(`locales must be a non-empty array, e.g. ["en", "fr"].`);
    const bad = locales.filter((l) => typeof l !== "string" || !getLanguage(l));
    if (bad.length) fail(`unsupported language code${bad.length > 1 ? "s" : ""}: ${bad.join(", ")}.`);
  }
  if ((sourceLocale === undefined) !== (locales === undefined)) fail("set both sourceLocale and locales, or neither.");
  if (output !== undefined && (typeof output !== "string" || !output.trim())) fail("output must be a path string.");
  for (const [key, value] of Object.entries({ include, exclude })) {
    if (value !== undefined && (!Array.isArray(value) || value.some((v) => typeof v !== "string"))) fail(`${key} must be an array of strings.`);
  }
  if (provider && typeof provider === "object" && !("translate" in provider)) {
    if (!PROVIDER_NAMES.includes(provider.name as never)) {
      fail(`provider.name must be one of ${PROVIDER_NAMES.join(", ")} (got "${(provider as { name?: string }).name}").`);
    }
    if (provider.name === "ollama" && !provider.model) fail(`provider "ollama" needs a model, e.g. { name: "ollama", model: "llama3.1" }.`);
  }
}

export async function loadProject(root: string, opts: { log?: (msg: string) => void } = {}): Promise<Project> {
  const configFile = findConfigFile(root);
  const config = configFile ? await loadConfigFile(configFile, root) : {};
  validateConfig(config, configFile ? path.basename(configFile) : undefined);
  const include = config.include ?? defaultInclude(root);

  let site: SiteConfig;
  if (config.sourceLocale && config.locales) {
    // The config file owns the languages; <AutoScale> props (if any) still supply seo, siteUrl and exclude.
    const props = findSite(root, include, { required: false });
    const languages = config.locales.filter((l) => l !== config.sourceLocale);
    if (props?.original && (props.original !== config.sourceLocale || props.languages.join() !== languages.join())) {
      opts.log?.(`[react-autolocale] <AutoScale> languages differ from ${path.basename(configFile!)}; using the config file.`);
    }
    site = { original: config.sourceLocale, languages, exclude: props?.exclude ?? [], seo: props?.seo ?? false, siteUrl: props?.siteUrl };
  } else {
    site = findSite(root, include);
  }
  site.exclude = [...new Set([...site.exclude, ...(config.exclude ?? [])])];

  const output = resolveOutput(root, config.output);
  return {
    root,
    configFile,
    config,
    site,
    include,
    output,
    outputRel: toProjectPath(root, output),
    meta: metaDir(root),
    glossary: config.glossary ?? {},
  };
}
