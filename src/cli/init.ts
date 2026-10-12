import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { DEFAULT_KEY_ENV, DEFAULT_MODELS, type AutoLocaleConfig, type ProviderConfig } from "../core/config.js";
import { parseEnv } from "../core/env.js";
import { getLanguage } from "../core/languages.js";
import { defaultOutput, hasRootSrc, META_DIR, resolveOutput, toProjectPath } from "../core/paths.js";
import { findConfigFile, loadConfigFile } from "../core/project.js";
import { defaultInclude, findSite } from "../core/site.js";
import type { Out } from "./commands.js";
import type { Prompter } from "./prompt.js";
import { patchViteConfig } from "./viteConfig.js";

export interface InitFlags {
  source?: string;
  locales?: string[];
  provider?: ProviderConfig["name"];
  model?: string;
  apiKeyEnv?: string;
  output?: string;
  /** Replace an existing auto-locale.config.ts without asking. */
  force?: boolean;
}

const VITE_CONFIGS = ["vite.config.ts", "vite.config.mts", "vite.config.js", "vite.config.mjs"];
const SDK = { openai: "openai", anthropic: "@anthropic-ai/sdk" } as const;

export interface Detected {
  react: boolean;
  viteConfig?: string;
  typescript: boolean;
  packageManager: "pnpm" | "yarn" | "bun" | "npm";
  configFile?: string;
  hasSrc: boolean;
  existingCatalogs: string[];
  autoScale: { original: string; languages: string[] } | null;
  /** The app is already wrapped in <AutoScale> (with or without props). */
  wrapped: boolean;
}

export function detect(root: string): Detected {
  let deps: Record<string, string> = {};
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
    deps = { ...pkg.dependencies, ...pkg.devDependencies };
  } catch {
    /* no package.json */
  }
  const lock = (f: string) => fs.existsSync(path.join(root, f));
  const output = resolveOutput(root);
  let autoScale: Detected["autoScale"] = null;
  let wrapped = false;
  try {
    const site = findSite(root, defaultInclude(root), { required: false });
    wrapped = !!site;
    if (site?.original) autoScale = { original: site.original, languages: site.languages };
  } catch {
    /* unreadable source is reported by later commands */
  }
  return {
    react: "react" in deps,
    viteConfig: VITE_CONFIGS.find((f) => fs.existsSync(path.join(root, f))),
    typescript: fs.existsSync(path.join(root, "tsconfig.json")),
    packageManager: lock("pnpm-lock.yaml") ? "pnpm" : lock("yarn.lock") ? "yarn" : lock("bun.lockb") || lock("bun.lock") ? "bun" : "npm",
    configFile: findConfigFile(root),
    hasSrc: hasRootSrc(root),
    existingCatalogs: fs.existsSync(output) ? fs.readdirSync(output).filter((f) => f.endsWith(".json")) : [],
    autoScale,
    wrapped,
  };
}

const langName = (code: string) => getLanguage(code)?.english ?? code;

function parseLocales(input: string): { ok: string[]; bad: string[] } {
  const codes = [...new Set(input.split(/[\s,]+/).map((c) => c.trim().toLowerCase()).filter(Boolean))];
  return { ok: codes.filter((c) => getLanguage(c)), bad: codes.filter((c) => !getLanguage(c)) };
}

export const LOCAL_HELP =
  "Free and runs on your machine; no API key. Models are large (about 110 MB per English->X language, 870 MB for\n" +
  "other pairs) and translating on the CPU uses RAM and time, so big apps or many languages can be slow.\n" +
  "Models are cached in ~/.cache/react-autolocale and downloaded only when you run `translate` or `generate`,\n" +
  "never during init or builds.";
export const CLOUD_HELP =
  "Uses a hosted AI model. No large downloads, and usually faster for big translation jobs. Needs an API key;\n" +
  "provider usage may be billed to your account.";

/** Writes auto-locale.config.ts. `output` is written only when it differs from the automatic default. */
export function configSource(cfg: AutoLocaleConfig, root: string): string {
  const lines = [`  sourceLocale: ${JSON.stringify(cfg.sourceLocale)},`, `  locales: ${JSON.stringify(cfg.locales)},`];
  const p = cfg.provider as ProviderConfig;
  const fields = Object.entries(p).map(([k, v]) => `${k}: ${JSON.stringify(v)}`);
  lines.push(`  provider: { ${fields.join(", ")} },`);
  const auto = defaultOutput(root);
  if (cfg.output && path.resolve(root, cfg.output) !== path.resolve(root, auto)) lines.push(`  output: ${JSON.stringify(cfg.output)},`);
  else lines.push(`  // Catalogs are written to ${auto}/ by default. To choose another folder:`, `  // output: "./${auto}",`);
  return `import { defineConfig } from "react-autolocale/config";\n\nexport default defineConfig({\n${lines.join("\n")}\n});\n`;
}

/** Adds lines to .gitignore that are not already there; never rewrites what exists. */
export function ensureGitignore(root: string, entries: string[]): string[] {
  const file = path.join(root, ".gitignore");
  const current = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  const have = new Set(current.split(/\r?\n/).map((l) => l.trim()));
  const add = entries.filter((e) => !have.has(e) && !have.has("/" + e));
  if (add.length) fs.writeFileSync(file, current + (current && !current.endsWith("\n") ? "\n" : "") + add.join("\n") + "\n");
  return add;
}

/** Appends KEY=value to .env unless KEY is already defined there. The value is never printed. */
export function saveKeyToEnv(root: string, name: string, value: string): boolean {
  const file = path.join(root, ".env");
  const current = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  if (name in parseEnv(current)) return false;
  fs.writeFileSync(file, current + (current && !current.endsWith("\n") ? "\n" : "") + `${name}=${value}\n`, { mode: 0o600 });
  return true;
}

function keyIsAvailable(root: string, name: string): boolean {
  if (process.env[name]) return true;
  return [".env.local", ".env"].some((f) => {
    const file = path.join(root, f);
    return fs.existsSync(file) && !!parseEnv(fs.readFileSync(file, "utf8"))[name];
  });
}

function sdkInstalled(root: string, pkg: string): boolean {
  try {
    createRequire(path.join(root, "package.json")).resolve(pkg);
    return true;
  } catch {
    return false;
  }
}

export async function runInit(root: string, flags: InitFlags, prompt: Prompter, out: Out): Promise<{ config?: AutoLocaleConfig; configFile?: string }> {
  const d = detect(root);
  const stack = [d.react ? "React" : null, d.viteConfig ? "Vite" : null].filter(Boolean).join(" + ") || "unknown (React + Vite expected)";
  out.log("React Auto Locale setup\n");
  out.log(`Detected project: ${stack}${d.typescript ? " (TypeScript)" : ""}, ${d.packageManager}`);
  out.log(`Source directory: ${d.hasSrc ? "src/" : "not found"}`);
  if (d.existingCatalogs.length) out.log(`Existing catalogs: ${toProjectPath(root, resolveOutput(root))}/ (${d.existingCatalogs.join(", ")})`);

  // An existing config is kept unless the developer confirms (or passes --force).
  let configFile = d.configFile;
  let config: AutoLocaleConfig | undefined;
  if (configFile) {
    const existing = await loadConfigFile(configFile, root);
    const p = existing.provider;
    const providerName = !p ? "local" : typeof p === "function" || "translate" in p ? "custom" : p.name;
    out.log(`\n${path.basename(configFile)} already exists: source ${existing.sourceLocale ?? "?"}, locales ${(existing.locales ?? []).join(", ")}, provider ${providerName}.`);
    const replace = flags.force || (await prompt.confirm("Reconfigure it?", false));
    if (!replace) {
      out.log("Keeping it as is.");
      config = existing;
    }
  }

  if (!config) {
    // Languages
    let source = (flags.source ?? (await prompt.ask("\nSource language (the language your code is written in)", d.autoScale?.original ?? "en"))).toLowerCase();
    while (!getLanguage(source)) {
      if (!prompt.interactive) throw new Error(`Unsupported source language "${source}".`);
      source = (await prompt.ask(`"${source}" is not a supported code. Source language`, "en")).toLowerCase();
    }
    let targets: string[] = (flags.locales ?? []).filter((l) => l !== source);
    if (!flags.locales) {
      const suggested = d.autoScale?.languages.join(",") ?? "";
      for (;;) {
        const { ok, bad } = parseLocales(await prompt.ask("Target languages, comma-separated (e.g. fr,es,de)", suggested));
        if (bad.length) out.log(`Unsupported: ${bad.join(", ")}.`);
        targets = ok.filter((l) => l !== source);
        if (targets.length && !bad.length) break;
        if (!prompt.interactive) throw new Error("Pass target languages with --locales fr,es (no <AutoScale languages> found to reuse).");
      }
    } else {
      const bad = flags.locales.filter((l) => !getLanguage(l));
      if (bad.length) throw new Error(`Unsupported language code${bad.length > 1 ? "s" : ""}: ${bad.join(", ")}.`);
    }

    // Engine
    const name =
      flags.provider ??
      (await prompt.choose(
        "How would you like to translate your application?",
        [
          { value: "local", label: "Local model (OPUS-MT / NLLB-200)", help: LOCAL_HELP },
          { value: "openai", label: "Cloud AI: OpenAI", help: CLOUD_HELP },
          { value: "anthropic", label: "Cloud AI: Anthropic Claude", help: CLOUD_HELP },
        ],
        "local",
      ));
    let provider: ProviderConfig;
    if (name === "openai" || name === "anthropic") {
      provider = { name, model: flags.model ?? DEFAULT_MODELS[name], apiKeyEnv: flags.apiKeyEnv ?? DEFAULT_KEY_ENV[name] };
    } else if (name === "ollama") {
      if (!flags.model) throw new Error("Ollama needs a model: --provider ollama --model llama3.1");
      provider = { name, model: flags.model };
    } else if (name === "local") {
      provider = { name };
    } else {
      throw new Error(`Unknown provider "${name}". Choose local, openai, anthropic or ollama.`);
    }

    // Output folder
    const auto = defaultOutput(root);
    out.log(`\nGenerated output:\n  ${auto}/\nInternal metadata:\n  ${META_DIR}/`);
    let output = flags.output ?? (await prompt.ask("Catalog folder (press Enter to keep)", auto));
    output = output.replace(/\/+$/, "");

    config = { sourceLocale: source, locales: [source, ...targets], provider, ...(output !== auto ? { output } : {}) };
    configFile = path.join(root, "auto-locale.config.ts");
    fs.writeFileSync(configFile, configSource(config, root));
    out.log(`\nWrote ${path.basename(configFile)}.`);
  }

  // Provider credentials and SDK (never printed, never written anywhere but .env).
  const provider = config.provider;
  const ignore = [`${META_DIR}/cache.json`];
  let modelNote = "";
  if (provider && typeof provider === "object" && "name" in provider && (provider.name === "openai" || provider.name === "anthropic")) {
    const keyEnv = provider.apiKeyEnv ?? DEFAULT_KEY_ENV[provider.name];
    ignore.push(".env", ".env.local");
    if (keyIsAvailable(root, keyEnv)) {
      out.log(`${keyEnv} is already set (value hidden).`);
    } else {
      const key = await prompt.secret(`Paste your ${provider.name === "openai" ? "OpenAI" : "Anthropic"} API key to save it in .env (leave empty to do it later)`);
      if (key) {
        saveKeyToEnv(root, keyEnv, key);
        out.log(`Saved ${keyEnv} to .env (value hidden).`);
      } else {
        out.log(`Add ${keyEnv}=... to .env (or your environment) before running translate. No request is made without it.`);
      }
    }
    const pkg = SDK[provider.name];
    if (!sdkInstalled(root, pkg)) {
      const cmd = { npm: ["install", "-D", pkg], pnpm: ["add", "-D", pkg], yarn: ["add", "-D", pkg], bun: ["add", "-d", pkg] }[d.packageManager];
      if (await prompt.confirm(`Install ${pkg} (used only by the CLI, never bundled) now with ${d.packageManager}?`, false)) {
        const res = spawnSync(d.packageManager, cmd, { cwd: root, stdio: "inherit", shell: process.platform === "win32" });
        if (res.status !== 0) out.log(`Installing failed. Run it yourself: ${d.packageManager} ${cmd.join(" ")}`);
      } else {
        out.log(`Install the provider SDK before translating: ${d.packageManager} ${cmd.join(" ")}`);
      }
    }
  } else if (!provider || (typeof provider === "object" && "name" in provider && provider.name === "local")) {
    modelNote = "Local models are not downloaded yet; the first `generate` downloads them.";
  }
  const added = ensureGitignore(root, ignore);
  if (added.length) out.log(`Added to .gitignore: ${added.join(", ")}`);

  // Vite plugin
  if (d.viteConfig) {
    const file = path.join(root, d.viteConfig);
    const patched = patchViteConfig(fs.readFileSync(file, "utf8"));
    if (!patched) out.log(`Could not edit ${d.viteConfig} automatically. Add:\n  import reactAutolocale from "react-autolocale/vite";\n  plugins: [reactAutolocale(), ...]`);
    else if (patched.changed) (fs.writeFileSync(file, patched.code), out.log(`Added the react-autolocale plugin to ${d.viteConfig}.`));
  } else {
    out.log("No vite.config found. Add the plugin yourself: plugins: [reactAutolocale()] from \"react-autolocale/vite\".");
  }

  const p = config.provider;
  const providerLabel = !p ? "Local model" : typeof p === "function" || "translate" in p ? "Custom" : ({ local: "Local model", openai: "OpenAI", anthropic: "Anthropic Claude", ollama: "Ollama" } as const)[p.name];
  const out_ = toProjectPath(root, resolveOutput(root, config.output));
  out.log(`\nReact Auto Locale initialized.\n`);
  out.log(`Source language: ${langName(config.sourceLocale ?? "")}`);
  out.log(`Target languages: ${(config.locales ?? []).filter((l) => l !== config!.sourceLocale).map(langName).join(", ")}`);
  out.log(`Provider: ${providerLabel}`);
  out.log(`Generated output:\n  ${out_}/`);
  out.log(`Internal metadata:\n  ${META_DIR}/`);
  out.log(`Configuration:\n  ${path.basename(configFile!)}`);
  if (modelNote) out.log(modelNote);
  if (!d.wrapped) out.log(`\nWrap your app once (for example in main.tsx):\n  import { AutoScale } from "react-autolocale";\n  <AutoScale><App /></AutoScale>`);
  out.log(`\nNext:\n  npx react-autolocale generate`);
  return { config, configFile };
}
