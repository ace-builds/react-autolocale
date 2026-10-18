import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { DEFAULT_KEY_ENV, DEFAULT_MODELS, type AutoLocaleConfig, type ProviderConfig } from "../core/config.js";
import { parseEnv } from "../core/env.js";
import { getLanguage, LANGUAGES } from "../core/languages.js";
import { defaultOutput, hasRootSrc, META_DIR, resolveOutput, toProjectPath } from "../core/paths.js";
import { findConfigFile, loadConfigFile } from "../core/project.js";
import { defaultInclude, findSite } from "../core/site.js";
import { info, intro, note, ok, outro, warn, type Out } from "./out.js";
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

export const LOCAL_HELP =
  "Free and works offline, with no API key, but it needs a large download the first time (about 110 MB per " +
  "English->X language, 870 MB for other pairs) and translating on your CPU is slow for big apps. The quality may " +
  "not match the cloud models, especially for short labels and less common languages, so review the result. " +
  "Models are cached in ~/.cache/react-autolocale and downloaded only when you run `translate` or `generate`, " +
  "never during init or builds.";
export const CLOUD_HELP =
  "Uses a hosted AI model. No large downloads, and usually faster for big translation jobs. Needs an API key; " +
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

/** How to run a package binary with this package manager. */
export const runner = (pm: Detected["packageManager"]) => ({ npm: "npx", pnpm: "pnpm exec", yarn: "yarn", bun: "bunx" })[pm];

const languageChoices = (exclude: string) =>
  LANGUAGES.filter((l) => l.code !== exclude).map((l) => ({ value: l.code, label: l.english, hint: l.native === l.english ? l.code : `${l.code} · ${l.native}` }));

export async function runInit(root: string, flags: InitFlags, prompt: Prompter, out: Out): Promise<{ config?: AutoLocaleConfig; configFile?: string }> {
  const d = detect(root);
  const stack = [d.react ? "React" : null, d.viteConfig ? "Vite" : null].filter(Boolean).join(" + ") || "unknown (React + Vite expected)";
  intro(out, "React Auto Locale setup");
  const found = [
    `Project:  ${stack}${d.typescript ? " (TypeScript)" : ""}, ${d.packageManager}`,
    `Source:   ${d.hasSrc ? "src/" : "not found"}`,
    ...(d.existingCatalogs.length ? [`Catalogs: ${toProjectPath(root, resolveOutput(root))}/ (${d.existingCatalogs.join(", ")})`] : []),
  ];
  note(out, found.join("\n"), "Detected");

  // An existing config is kept unless the developer confirms (or passes --force).
  let configFile = d.configFile;
  let config: AutoLocaleConfig | undefined;
  if (configFile) {
    const existing = await loadConfigFile(configFile, root);
    const p = existing.provider;
    const providerName = !p ? "local" : typeof p === "function" || "translate" in p ? "custom" : p.name;
    info(out, `${path.basename(configFile)} already exists: source ${existing.sourceLocale ?? "?"}, locales ${(existing.locales ?? []).join(", ")}, provider ${providerName}.`);
    const replace = flags.force || (await prompt.confirm("Reconfigure it?", false));
    if (!replace) {
      info(out, "Keeping it as is.");
      config = existing;
    }
  }

  if (!config) {
    // Languages
    let source = flags.source?.toLowerCase();
    if (source && !getLanguage(source)) throw new Error(`Unsupported source language "${source}".`);
    source ??= (await prompt.choose("Source language (the language your code is written in)", languageChoices(""), d.autoScale?.original ?? "en")) ?? "en";
    if (!getLanguage(source)) throw new Error(`Unsupported source language "${source}". Pass a supported code with --source.`);

    let targets: string[];
    if (flags.locales) {
      const bad = flags.locales.filter((l) => !getLanguage(l));
      if (bad.length) throw new Error(`Unsupported language code${bad.length > 1 ? "s" : ""}: ${bad.join(", ")}.`);
      targets = flags.locales.filter((l) => l !== source);
    } else {
      const suggested = (d.autoScale?.languages ?? []).filter((l) => l !== source && getLanguage(l));
      targets = await prompt.pick("Target languages", languageChoices(source), suggested);
    }
    targets = [...new Set(targets)];
    if (!targets.length) throw new Error("Pass target languages with --locales fr,es (no <AutoScale languages> found to reuse).");

    // Engine
    if (!flags.provider && prompt.interactive) note(out, `Cloud AI. ${CLOUD_HELP}\n\nLocal model. ${LOCAL_HELP}`, "Translation engines");
    const name =
      flags.provider ??
      (await prompt.choose<ProviderConfig["name"]>("How would you like to translate your application?", [
        { value: "openai", label: "Cloud AI: OpenAI", hint: "needs an API key" },
        { value: "anthropic", label: "Cloud AI: Anthropic Claude", hint: "needs an API key" },
        { value: "gemini", label: "Cloud AI: Google Gemini", hint: "needs an API key" },
        // Last, and never the default: it needs a big download and may translate less well than the cloud models.
        { value: "local", label: "Local model (OPUS-MT / NLLB-200)", hint: "free and offline, but a large download and lower quality" },
      ]));
    if (!name) {
      throw new Error("Choose a translation engine: --provider openai|anthropic|gemini|local|ollama (add --model for ollama).");
    }
    let provider: ProviderConfig;
    if (name === "openai" || name === "anthropic" || name === "gemini") {
      provider = { name, model: flags.model ?? DEFAULT_MODELS[name], apiKeyEnv: flags.apiKeyEnv ?? DEFAULT_KEY_ENV[name] };
    } else if (name === "ollama") {
      if (!flags.model) throw new Error("Ollama needs a model: --provider ollama --model llama3.1");
      provider = { name, model: flags.model };
    } else if (name === "local") {
      provider = { name };
    } else {
      throw new Error(`Unknown provider "${name}". Choose local, openai, anthropic, gemini or ollama.`);
    }

    // Output folder
    const auto = defaultOutput(root);
    let output =
      flags.output ??
      (await prompt.ask(`Catalog folder (metadata stays in ${META_DIR}/)`, auto, (v) =>
        path.isAbsolute(v) || path.relative(root, path.resolve(root, v)).startsWith("..") ? "Use a folder inside the project." : undefined,
      ));
    output = output.replace(/\/+$/, "");

    config = { sourceLocale: source, locales: [source, ...targets], provider, ...(output !== auto ? { output } : {}) };
    configFile = path.join(root, "auto-locale.config.ts");
    fs.writeFileSync(configFile, configSource(config, root));
    ok(out, `Wrote ${path.basename(configFile)}`);
  }

  // Provider credentials and SDK (never printed, never written anywhere but .env).
  const provider = config.provider;
  const ignore = [`${META_DIR}/cache.json`];
  let modelNote = "";
  if (provider && typeof provider === "object" && "name" in provider && (provider.name === "openai" || provider.name === "anthropic" || provider.name === "gemini")) {
    const keyEnv = provider.apiKeyEnv ?? DEFAULT_KEY_ENV[provider.name];
    ignore.push(".env", ".env.local");
    if (keyIsAvailable(root, keyEnv)) {
      ok(out, `${keyEnv} is already set (value hidden)`);
    } else {
      const key = await prompt.secret(`Paste your ${({ openai: "OpenAI", anthropic: "Anthropic", gemini: "Google Gemini" } as const)[provider.name]} API key to save it in .env (leave empty to do it later)`);
      if (key) {
        saveKeyToEnv(root, keyEnv, key);
        ok(out, `Saved ${keyEnv} to .env (value hidden)`);
      } else {
        warn(out, `Add ${keyEnv}=... to .env (or your environment) before running translate. No request is made without it.`);
      }
    }
    // Gemini is called over plain HTTP, so only OpenAI and Anthropic need an SDK in the project.
    const pkg = provider.name === "gemini" ? null : SDK[provider.name];
    if (pkg && !sdkInstalled(root, pkg)) {
      const cmd = { npm: ["install", "-D", pkg], pnpm: ["add", "-D", pkg], yarn: ["add", "-D", pkg], bun: ["add", "-d", pkg] }[d.packageManager];
      if (await prompt.confirm(`Install ${pkg} (used only by the CLI, never bundled) now with ${d.packageManager}?`, false)) {
        const res = spawnSync(d.packageManager, cmd, { cwd: root, stdio: "inherit", shell: process.platform === "win32" });
        if (res.status !== 0) warn(out, `Installing failed. Run it yourself: ${d.packageManager} ${cmd.join(" ")}`);
        else ok(out, `Installed ${pkg}`);
      } else {
        warn(out, `Install the provider SDK before translating: ${d.packageManager} ${cmd.join(" ")}`);
      }
    }
  } else if (!provider || (typeof provider === "object" && "name" in provider && provider.name === "local")) {
    modelNote = "Local models are not downloaded yet; the first `generate` downloads them.";
  }
  const added = ensureGitignore(root, ignore);
  if (added.length) ok(out, `Added to .gitignore: ${added.join(", ")}`);

  // Vite plugin
  if (d.viteConfig) {
    const file = path.join(root, d.viteConfig);
    const patched = patchViteConfig(fs.readFileSync(file, "utf8"));
    if (!patched) warn(out, `Could not edit ${d.viteConfig} automatically. Add:\n  import reactAutolocale from "react-autolocale/vite";\n  plugins: [reactAutolocale(), ...]`);
    else if (patched.changed) (fs.writeFileSync(file, patched.code), ok(out, `Added the react-autolocale plugin to ${d.viteConfig}`));
  } else {
    warn(out, "No vite.config found. Add the plugin yourself: plugins: [reactAutolocale()] from \"react-autolocale/vite\".");
  }

  const p = config.provider;
  const providerLabel = !p ? "Local model" : typeof p === "function" || "translate" in p ? "Custom" : ({ local: "Local model", openai: "OpenAI", anthropic: "Anthropic Claude", gemini: "Google Gemini", ollama: "Ollama" } as const)[p.name];
  const summary = [
    `Source language:   ${langName(config.sourceLocale ?? "")}`,
    `Target languages:  ${(config.locales ?? []).filter((l) => l !== config!.sourceLocale).map(langName).join(", ")}`,
    `Provider:          ${providerLabel}`,
    `Generated output:  ${toProjectPath(root, resolveOutput(root, config.output))}/`,
    `Internal metadata: ${META_DIR}/`,
    `Configuration:     ${path.basename(configFile!)}`,
    ...(modelNote ? ["", modelNote] : []),
  ];
  note(out, summary.join("\n"), "React Auto Locale initialized");
  if (!d.wrapped) note(out, `import { AutoScale } from "react-autolocale";\n\n<AutoScale><App /></AutoScale>`, "Wrap your app once (for example in main.tsx)");
  note(out, `${runner(d.packageManager)} react-autolocale generate`, "Next");
  outro(out, "Setup complete.");
  return { config, configFile };
}
