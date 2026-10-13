#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { exportTranslations, OVERRIDES_FILE } from "../core/overrides.js";
import { loadProject } from "../core/project.js";
import { runClean, runGenerate, runScan, runTranslate, type Out } from "./commands.js";
import { runInit, type InitFlags } from "./init.js";
import { createPrompter } from "./prompt.js";

const HELP = `react-autolocale

Usage:
  react-autolocale init [--source en] [--locales fr,es] [--provider local|openai|anthropic|ollama]
                        [--model <id>] [--api-key-env <NAME>] [--output <dir>] [--yes] [--force]
      Sets up auto-locale.config.ts, the translation provider and the Vite plugin. Downloads nothing.
  react-autolocale generate [--lang fr,es]
      Scans the source, then translates new strings and writes the catalogs. Incremental.
  react-autolocale sync [--lang fr,es]
      Same as generate: run it after changing text in your components.
  react-autolocale scan
      Extracts strings and updates .auto-locale/manifest.json. No translation, no network.
  react-autolocale translate [--lang fr,es]
      Translates strings missing from the catalogs (retries anything that failed before).
  react-autolocale clean [--yes]
      Lists strings no longer in the source and removes their translations once confirmed.
  react-autolocale export
      Copies the generated translations to ${OVERRIDES_FILE} so you can edit them.
      Anything in that file always wins over machine translation.
  react-autolocale add switcher|banner [--dir src/components]
      Copies an editable <LanguageSwitcher /> or <LanguageBanner /> into your project.

Options:
  --root <dir>   Project root (default: the nearest folder with a package.json).
`;

const TSX = `import { useLanguage } from "react-autolocale";

// This file is yours: change the markup, style it, or replace it entirely.
export function LanguageSwitcher() {
  const { language, languages, setLanguage } = useLanguage();
  return (
    <div role="group" aria-label="Language">
      {languages.map((l) => (
        <button
          key={l.code}
          lang={l.code}
          aria-pressed={l.code === language}
          onClick={() => setLanguage(l.code)}
        >
          {l.native}
        </button>
      ))}
    </div>
  );
}
`;

const JSX = TSX;

const BANNER_TSX = `import { useLanguageSuggestion } from "react-autolocale";

// This file is yours: change the markup, style it, or replace it entirely.
// It renders nothing unless the visitor's browser language differs from this page's language.
export function LanguageBanner() {
  const suggestion = useLanguageSuggestion();
  if (!suggestion) return null;
  return (
    <div role="region" aria-label={suggestion.native}>
      <span>{suggestion.text}</span>
      <button onClick={suggestion.accept}>{suggestion.switchLabel}</button>
      <button onClick={suggestion.dismiss}>{suggestion.dismissLabel}</button>
    </div>
  );
}
`;

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

function addComponent(root: string, args: string[], name: "LanguageSwitcher" | "LanguageBanner"): void {
  const dir = path.resolve(root, flag(args, "--dir") ?? (fs.existsSync(path.join(root, "src")) ? "src/components" : "components"));
  const ts = fs.existsSync(path.join(root, "tsconfig.json"));
  const file = path.join(dir, ts ? `${name}.tsx` : `${name}.jsx`);
  if (fs.existsSync(file)) throw new Error(`${path.relative(root, file)} already exists.`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, name === "LanguageBanner" ? BANNER_TSX : ts ? TSX : JSX);
  console.log(`Created ${path.relative(root, file)}\nImport it anywhere: import { ${name} } from "./components/${name}";`);
}

/** --name value / --flag pairs. */
function parseArgs(argv: string[]): { positional: string[]; flags: Record<string, string | true> } {
  const positional: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith("--")) positional.push(a);
    else if (argv[i + 1] !== undefined && !argv[i + 1]!.startsWith("--")) flags[a.slice(2)] = argv[++i]!;
    else flags[a.slice(2)] = true;
  }
  return { positional, flags };
}

/** The project the user means: --root, else the nearest folder (from cwd up) with a package.json. */
function findRoot(explicit?: string): string {
  if (explicit) return path.resolve(explicit);
  for (let dir = process.cwd(); ; dir = path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, "package.json"))) return dir;
    if (path.dirname(dir) === dir) return process.cwd();
  }
}

const list = (v: string | true | undefined) => (typeof v === "string" ? v.split(",").map((s) => s.trim()).filter(Boolean) : undefined);
const str = (v: string | true | undefined) => (typeof v === "string" ? v : undefined);

async function main(): Promise<void> {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const [cmd, what] = positional;
  const root = findRoot(str(flags.root));
  const out: Out = { log: (m) => console.log(m) };
  const interactive = !!process.stdin.isTTY && !flags.yes;

  switch (cmd) {
    case "init": {
      const initFlags: InitFlags = {
        source: str(flags.source),
        locales: list(flags.locales),
        provider: str(flags.provider) as InitFlags["provider"],
        model: str(flags.model),
        apiKeyEnv: str(flags["api-key-env"]),
        output: str(flags.output),
        force: !!flags.force,
      };
      await runInit(root, initFlags, createPrompter(interactive), out);
      return;
    }
    case "scan":
      out.log("React Auto Locale\n");
      runScan(await loadProject(root, out), out);
      out.log("\nNo source files modified.");
      return;
    case "translate": {
      const report = await runTranslate(await loadProject(root, out), { langs: list(flags.lang) }, out);
      if (report && (report.stopped || Object.values(report.langs).some((r) => r.failed.length))) process.exitCode = 1;
      return;
    }
    case "generate":
    case "sync": {
      const { translate } = await runGenerate(await loadProject(root, out), { langs: list(flags.lang) }, out);
      if (translate && (translate.stopped || Object.values(translate.langs).some((r) => r.failed.length))) process.exitCode = 1;
      return;
    }
    case "clean":
      await runClean(await loadProject(root, out), { yes: !!flags.yes }, createPrompter(!!process.stdin.isTTY && !flags.yes), out);
      return;
    case "export": {
      const { file, languages } = exportTranslations(await loadProject(root, out));
      out.log(`Wrote ${path.relative(root, file)}: ${Object.entries(languages).map(([l, n]) => `${l} ${n}`).join(", ")} strings.`);
      out.log("Edit any value, commit the file, and rebuild. Your edits always win over machine translation.");
      return;
    }
    case "add":
      if (what === "switcher") return addComponent(root, process.argv.slice(2), "LanguageSwitcher");
      if (what === "banner") return addComponent(root, process.argv.slice(2), "LanguageBanner");
  }
  console.log(HELP);
  if (cmd && cmd !== "help" && cmd !== "--help") process.exitCode = 1;
}

main().catch((err) => {
  console.error(`react-autolocale: ${(err as Error).message}`);
  process.exit(1);
});
