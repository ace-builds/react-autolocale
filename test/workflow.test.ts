import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runClean, runGenerate, runScan, runTranslate, type Out } from "../src/cli/commands.js";
import { configSource, detect, ensureGitignore, runInit, saveKeyToEnv } from "../src/cli/init.js";
import { createPrompter, type Prompter } from "../src/cli/prompt.js";
import { loadDicts, translateMissing } from "../src/core/catalog.js";
import { loadEnv, parseEnv } from "../src/core/env.js";
import { findCollisions, messageId } from "../src/core/ids.js";
import { readManifest, scanProject } from "../src/core/manifest.js";
import { defaultOutput, resolveOutput } from "../src/core/paths.js";
import { loadProject, validateConfig } from "../src/core/project.js";
import { extractItems } from "../src/core/transform.js";
import { TranslationError } from "../src/core/translate.js";

// Fixtures live inside the repo so they resolve react, react-dom and vite from its node_modules.
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const made: string[] = [];
afterAll(() => made.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

function project(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(REPO, "test", ".tmp-"));
  made.push(dir);
  for (const [name, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), content);
  }
  return dir;
}

const read = (dir: string, file: string) => JSON.parse(fs.readFileSync(path.join(dir, file), "utf8"));
const quiet = (): Out & { lines: string[] } => {
  const lines: string[] = [];
  return { lines, log: (m: string) => lines.push(m) };
};
const noPrompt: Prompter = createPrompter(false);

/** A provider in the config file: counts calls on globalThis and translates as "fr(text)". */
const COUNTING_CONFIG = `
export default {
  sourceLocale: "en",
  locales: ["en", "fr"],
  provider: async ({ texts, to }) => {
    // The language-banner phrases (masked "{language}" -> X0X) are translated once too; count only app strings.
    if (!texts.some((t) => t.includes("X0X"))) globalThis.__rlCalls = (globalThis.__rlCalls ?? 0) + texts.length;
    if (globalThis.__rlFail) throw new Error("provider down");
    return texts.map((t) => to + "(" + t + ")");
  },
};
`;
const APP = (body: string) => `export function App() {\n  return (\n    <main>\n${body}\n    </main>\n  );\n}\n`;
const g = globalThis as { __rlCalls?: number; __rlFail?: boolean };
beforeEach(() => {
  g.__rlCalls = 0;
  g.__rlFail = false;
});

describe("output directory", () => {
  it("uses src/generated/auto-locale when the project has a root-level src/", () => {
    const dir = project({ "src/App.tsx": "" });
    expect(defaultOutput(dir)).toBe("src/generated/auto-locale");
  });
  it("uses generated/auto-locale without a root-level src/", () => {
    const dir = project({ "app/src/page.tsx": "", "src-file": "" });
    expect(defaultOutput(dir)).toBe("generated/auto-locale");
  });
  it("lets an explicit output win, resolved from the project root", () => {
    const dir = project({ "src/App.tsx": "" });
    expect(resolveOutput(dir, "./custom/translations")).toBe(path.join(dir, "custom", "translations"));
  });
  it("is shared by every command through loadProject", async () => {
    const dir = project({ "auto-locale.config.mjs": `export default { sourceLocale: "en", locales: ["en", "fr"], output: "i18n" };`, "components/A.jsx": APP("<p>Hi there</p>") });
    const p = await loadProject(dir);
    expect(p.outputRel).toBe("i18n");
    expect(p.include).toEqual(["."]);
    runScan(p, quiet());
    expect(read(dir, "i18n/en.json")).toEqual({ [messageId("Hi there")]: "Hi there" });
    expect(fs.existsSync(path.join(dir, ".auto-locale/manifest.json"))).toBe(true);
  });
});

describe("configuration", () => {
  it("keeps working with <AutoScale> props and no config file", async () => {
    const dir = project({ "src/main.tsx": `<AutoScale original="en" languages={["fr", "es"]} exclude={["Acme"]}><App /></AutoScale>` });
    const p = await loadProject(dir);
    expect(p.site).toMatchObject({ original: "en", languages: ["fr", "es"], exclude: ["Acme"] });
    expect(p.configFile).toBeUndefined();
  });
  it("lets the config file own the languages, so <AutoScale> needs no props", async () => {
    const dir = project({ "auto-locale.config.mjs": `export default { sourceLocale: "en", locales: ["en", "de"] };`, "src/main.tsx": `<AutoScale seo><App /></AutoScale>` });
    const p = await loadProject(dir);
    expect(p.site).toMatchObject({ original: "en", languages: ["de"], seo: true });
  });
  it("names the bad setting", () => {
    expect(() => validateConfig({ sourceLocale: "en", locales: ["en", "xx"] })).toThrow(/unsupported language code: xx/);
    expect(() => validateConfig({ sourceLocale: "en" })).toThrow(/both sourceLocale and locales/);
    expect(() => validateConfig({ provider: { name: "deepl" } as never })).toThrow(/provider.name must be one of/);
  });
});

describe("init", () => {
  const vite = `import { defineConfig } from "vite";\nimport react from "@vitejs/plugin-react";\nexport default defineConfig({ plugins: [react()] });\n`;
  const base = () => project({ "package.json": `{"dependencies":{"react":"19"}}`, "vite.config.ts": vite, "src/main.tsx": "", ".gitignore": "node_modules\n" });

  it("configures the local model without downloading anything", async () => {
    const dir = base();
    const out = quiet();
    await runInit(dir, { source: "en", locales: ["fr", "es"], provider: "local" }, noPrompt, out);
    const cfg = fs.readFileSync(path.join(dir, "auto-locale.config.ts"), "utf8");
    expect(cfg).toContain(`locales: ["en","fr","es"]`);
    expect(cfg).toContain(`provider: { name: "local" }`);
    expect(cfg).toContain(`// output: "./src/generated/auto-locale"`);
    expect(fs.readFileSync(path.join(dir, "vite.config.ts"), "utf8")).toContain("reactAutolocale()");
    expect(fs.readFileSync(path.join(dir, ".gitignore"), "utf8")).toBe("node_modules\n.auto-locale/cache.json\n");
    expect(fs.existsSync(path.join(dir, "src/generated"))).toBe(false); // nothing generated or translated
    expect(out.lines.join("\n")).toMatch(/Next:\n {2}npx react-autolocale generate/);
    expect(out.lines.join("\n")).toContain("Local models are not downloaded yet");
  });

  for (const [name, env] of [["openai", "OPENAI_API_KEY"], ["anthropic", "ANTHROPIC_API_KEY"], ["gemini", "GEMINI_API_KEY"]] as const) {
    it(`configures ${name} with ${env}, saves a pasted key to .env without printing it`, async () => {
      const dir = base();
      const out = quiet();
      const secret = `sk-test-${name}-123456`;
      const prompt: Prompter = { ...noPrompt, interactive: true, secret: async () => secret, confirm: async () => false };
      const saved = process.env[env];
      delete process.env[env];
      try {
        await runInit(dir, { source: "en", locales: ["fr"], provider: name }, prompt, out);
      } finally {
        if (saved !== undefined) process.env[env] = saved;
      }
      const cfg = fs.readFileSync(path.join(dir, "auto-locale.config.ts"), "utf8");
      expect(cfg).toContain(`name: "${name}"`);
      expect(cfg).toContain(`apiKeyEnv: "${env}"`);
      expect(cfg).not.toContain(secret);
      expect(fs.readFileSync(path.join(dir, ".env"), "utf8")).toBe(`${env}=${secret}\n`);
      expect(fs.readFileSync(path.join(dir, ".gitignore"), "utf8")).toContain(".env\n");
      expect(out.lines.join("\n")).not.toContain(secret);
    });
  }

  it("offers the cloud engines first, the local model last, and no default", async () => {
    const dir = base();
    let seen: { values: string[]; labels: string[]; fallback: string | undefined } | null = null;
    const prompt: Prompter = {
      ...noPrompt,
      interactive: true,
      ask: async (_q, fallback = "") => fallback || "x",
      choose: (async (_q: string, options: { value: string; label: string; hint?: string }[], fallback?: string) => {
        seen = { values: options.map((o) => o.value), labels: options.map((o) => `${o.label} ${o.hint ?? ""}`), fallback };
        return "gemini";
      }) as Prompter["choose"],
      secret: async () => "",
      confirm: async () => false,
    };
    await runInit(dir, { source: "en", locales: ["fr"] }, prompt, quiet());
    expect(seen!.values).toEqual(["openai", "anthropic", "gemini", "local"]);
    expect(seen!.fallback).toBeUndefined(); // nothing is chosen for the user
    const local = seen!.labels[3]!;
    expect(local).toMatch(/large download/i);
    expect(local).toMatch(/quality/i);
    expect(fs.readFileSync(path.join(dir, "auto-locale.config.ts"), "utf8")).toContain(`name: "gemini"`);
  });

  it("refuses to pick an engine for you when it cannot ask", async () => {
    const dir = base();
    await expect(runInit(dir, { source: "en", locales: ["fr"] }, noPrompt, quiet())).rejects.toThrow(/Choose a translation engine: --provider/);
    expect(fs.existsSync(path.join(dir, "auto-locale.config.ts"))).toBe(false);
  });

  it("keeps an existing config unless told to replace it", async () => {
    const dir = base();
    fs.writeFileSync(path.join(dir, "auto-locale.config.ts"), `export default { sourceLocale: "en", locales: ["en", "it"] };\n`);
    const before = fs.readFileSync(path.join(dir, "auto-locale.config.ts"), "utf8");
    await runInit(dir, { source: "en", locales: ["fr"], provider: "local" }, noPrompt, quiet());
    expect(fs.readFileSync(path.join(dir, "auto-locale.config.ts"), "utf8")).toBe(before);
  });

  it("reports existing catalogs and writes an explicit output only when it differs from the default", () => {
    const dir = project({ "src/generated/auto-locale/fr.json": "{}" });
    expect(detect(dir).existingCatalogs).toEqual(["fr.json"]);
    expect(configSource({ sourceLocale: "en", locales: ["en"], provider: { name: "local" }, output: "lang" }, dir)).toContain(`output: "lang",`);
  });
});

describe("environment and secrets", () => {
  it("parses .env and never overrides variables that are already set", () => {
    expect(parseEnv(`# c\nexport A=1\nB="two words"\nC=x # note\n`)).toEqual({ A: "1", B: "two words", C: "x" });
    const dir = project({ ".env": "RL_TEST_A=from-file\nRL_TEST_B=from-file\n" });
    process.env.RL_TEST_A = "from-shell";
    loadEnv(dir);
    expect(process.env.RL_TEST_A).toBe("from-shell");
    expect(process.env.RL_TEST_B).toBe("from-file");
    delete process.env.RL_TEST_A;
    delete process.env.RL_TEST_B;
  });
  it("does not overwrite a key already in .env, and appends to .gitignore without rewriting it", () => {
    const dir = project({ ".env": "OPENAI_API_KEY=old\n", ".gitignore": "dist" });
    expect(saveKeyToEnv(dir, "OPENAI_API_KEY", "new")).toBe(false);
    expect(fs.readFileSync(path.join(dir, ".env"), "utf8")).toBe("OPENAI_API_KEY=old\n");
    expect(ensureGitignore(dir, [".env", "dist"])).toEqual([".env"]);
    expect(fs.readFileSync(path.join(dir, ".gitignore"), "utf8")).toBe("dist\n.env\n");
  });
  it("fails before any request when the API key is missing", async () => {
    const dir = project({ "auto-locale.config.mjs": `export default { sourceLocale: "en", locales: ["en", "fr"], provider: { name: "openai", apiKeyEnv: "RL_MISSING_KEY" } };`, "src/A.tsx": APP("<p>Hello</p>") });
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const p = await loadProject(dir);
    scanProject(p);
    await expect(runTranslate(p, {}, quiet())).rejects.toThrow(/RL_MISSING_KEY is not set.*No request was made/);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});

describe("extraction and message ids", () => {
  it("gives identical text one stable id, ignoring whitespace layout", () => {
    expect(messageId("Get   started\n")).toBe(messageId("Get started"));
    expect(messageId("Get started")).toMatch(/^msg_[0-9a-f]{10}$/);
    expect(messageId("Get started")).not.toBe(messageId("Get Started"));
    expect(findCollisions(["a", "b", "a"])).toEqual([]);
  });
  it("collects supported attributes (aria-placeholder included) and skips translate=\"no\"", () => {
    const { strings, contexts } = extractItems(
      `function A() { return <div><input placeholder="Search" aria-placeholder="Type here" data-x="Nope" className="Nope" /><p translate="no">Cosmos Mind Labs</p><p>Hello, {user.name}!</p></div>; }`,
      "A.tsx",
    );
    expect(strings.sort()).toEqual(["Hello, {name}!", "Search", "Type here"]);
    expect(contexts["Type here"]).toBe("aria-placeholder");
  });
  it("records every file a shared string appears in", async () => {
    const dir = project({
      "auto-locale.config.mjs": `export default { sourceLocale: "en", locales: ["en", "fr"] };`,
      "src/A.tsx": APP("<button>Save</button>"),
      "src/B.tsx": APP("<a>Save</a>"),
    });
    const { manifest } = scanProject(await loadProject(dir));
    expect(manifest.messages[messageId("Save")]).toEqual({ text: "Save", context: "button", files: ["src/A.tsx", "src/B.tsx"], status: "active" });
  });
});

describe("incremental generation", () => {
  it("translates only new strings, keeps edits, and leaves unchanged catalogs byte-identical", async () => {
    const dir = project({ "auto-locale.config.mjs": COUNTING_CONFIG, "src/A.tsx": APP("<h1>Build better products</h1>\n<button>Get started</button>") });
    const p = await loadProject(dir);
    const out = quiet();
    const first = await runGenerate(p, {}, out);
    expect(g.__rlCalls).toBe(2);
    expect(first.translate!.langs.fr!.translated).toBe(2);
    const fr = path.join(dir, "src/generated/auto-locale/fr.json");
    expect(read(dir, "src/generated/auto-locale/fr.json")).toEqual({
      [messageId("Build better products")]: "fr(Build better products)",
      [messageId("Get started")]: "fr(Get started)",
    });
    expect(out.lines).toContain("\nNo source files modified.");

    // A hand edit survives; nothing is retranslated; files are not rewritten.
    const edited = { ...read(dir, "src/generated/auto-locale/fr.json"), [messageId("Get started")]: "Commencer" };
    fs.writeFileSync(fr, JSON.stringify(edited, null, 2) + "\n");
    const manifestBefore = fs.readFileSync(path.join(dir, ".auto-locale/manifest.json"), "utf8");
    const frBefore = fs.readFileSync(fr, "utf8");
    await runGenerate(p, {}, quiet());
    expect(g.__rlCalls).toBe(2);
    expect(fs.readFileSync(fr, "utf8")).toBe(frBefore);
    expect(fs.readFileSync(path.join(dir, ".auto-locale/manifest.json"), "utf8")).toBe(manifestBefore);

    // One new string: one provider call, inserted in sorted position.
    fs.writeFileSync(path.join(dir, "src/A.tsx"), APP("<h1>Build better products</h1>\n<button>Get started</button>\n<button>Start free trial</button>"));
    const third = await runGenerate(p, {}, quiet());
    expect(g.__rlCalls).toBe(3);
    expect(third.scan.added).toEqual([messageId("Start free trial")]);
    expect(third.translate!.langs.fr).toMatchObject({ kept: 2, translated: 1, failed: [] });
    const now = read(dir, "src/generated/auto-locale/fr.json");
    expect(now[messageId("Get started")]).toBe("Commencer");
    expect(Object.keys(now)).toEqual(Object.keys(now).sort());
  });

  it("keeps translations of removed strings until clean, then reuses the cache if they come back", async () => {
    const dir = project({ "auto-locale.config.mjs": COUNTING_CONFIG, "src/A.tsx": APP("<p>Old text</p>\n<p>Kept text</p>") });
    const p = await loadProject(dir);
    await runGenerate(p, {}, quiet());
    fs.writeFileSync(path.join(dir, "src/A.tsx"), APP("<p>Kept text</p>"));
    const scan = runScan(p, quiet());
    expect(scan.removed).toEqual([messageId("Old text")]);
    expect(read(dir, "src/generated/auto-locale/fr.json")[messageId("Old text")]).toBe("fr(Old text)");
    expect(loadDicts(p).byId.fr![messageId("Old text")]).toBeUndefined(); // unused entries are not shipped

    expect(await runClean(p, {}, noPrompt, quiet())).toBe(0); // no confirmation, nothing removed
    expect(await runClean(p, { yes: true }, noPrompt, quiet())).toBe(1);
    expect(read(dir, "src/generated/auto-locale/fr.json")[messageId("Old text")]).toBeUndefined();
    expect(readManifest(p)!.messages[messageId("Old text")]).toBeUndefined();

    fs.writeFileSync(path.join(dir, "src/A.tsx"), APP("<p>Old text</p>\n<p>Kept text</p>"));
    const calls = g.__rlCalls;
    const back = await runGenerate(p, {}, quiet());
    expect(g.__rlCalls).toBe(calls); // restored from .auto-locale/cache.json
    expect(back.translate!.langs.fr!.reused).toBe(1);
  });

  it("reports failures, keeps finished work, never stores empty results, and retries only what is missing", async () => {
    const dir = project({ "auto-locale.config.mjs": COUNTING_CONFIG, "src/A.tsx": APP("<p>One</p>\n<p>Two</p>\n<p>Three</p>") });
    const p = await loadProject(dir);
    const { manifest } = scanProject(p);
    let n = 0;
    const flaky = {
      async translate(texts: string[]) {
        n++;
        if (n === 2) throw new TranslationError("timeout");
        return texts.map((t) => (t === "Three" ? "" : `ok(${t})`));
      },
    };
    const report = await translateMissing(p, manifest, { translator: flaky, providerName: "test", chunkSize: 1 });
    expect(report.langs.fr!.translated).toBe(1);
    expect(report.langs.fr!.failed.map((f) => f.text).sort()).toEqual(["Three", "Two"]);
    const fr = read(dir, "src/generated/auto-locale/fr.json");
    expect(Object.values(fr)).toEqual(["ok(One)"]); // no empty string for "Three", nothing for "Two"

    const retry = await translateMissing(p, manifest, { translator: { translate: async (t: string[]) => t.map((x) => `ok(${x})`) }, providerName: "test" });
    expect(retry.langs.fr).toMatchObject({ kept: 1, translated: 2, failed: [] });
  });

  it("stops on a fatal provider error or an interrupt and keeps what was saved", async () => {
    const dir = project({ "auto-locale.config.mjs": COUNTING_CONFIG, "src/A.tsx": APP("<p>One</p>\n<p>Two</p>\n<p>Three</p>") });
    const p = await loadProject(dir);
    const { manifest } = scanProject(p);
    let chunks = 0;
    const interrupted = await translateMissing(p, manifest, {
      translator: { translate: async (t: string[]) => (chunks++, t.map((x) => `ok(${x})`)) },
      providerName: "test",
      chunkSize: 1,
      shouldStop: () => chunks >= 1,
    });
    expect(interrupted.stopped).toBe("interrupted");
    expect(Object.keys(read(dir, "src/generated/auto-locale/fr.json"))).toHaveLength(1);

    const fatal = await translateMissing(p, manifest, {
      translator: { translate: async () => { throw new TranslationError("bad key", true); } },
      providerName: "test",
      chunkSize: 1,
    });
    expect(fatal.stopped).toBe("bad key");
    expect(fatal.langs.fr!.failed).toHaveLength(1); // stopped after the first failing chunk
    expect(Object.keys(read(dir, "src/generated/auto-locale/fr.json"))).toHaveLength(1);
  });

  it("warns about a previous output folder, copies its catalogs, and leaves it in place", async () => {
    const dir = project({ "auto-locale.config.mjs": `export default { sourceLocale: "en", locales: ["en", "fr"], output: "old" };`, "src/A.tsx": APP("<p>Hello</p>") });
    runScan(await loadProject(dir), quiet());
    fs.writeFileSync(path.join(dir, "old/fr.json"), JSON.stringify({ [messageId("Hello")]: "Bonjour" }));
    fs.writeFileSync(path.join(dir, "auto-locale.config.mjs"), `export default { sourceLocale: "en", locales: ["en", "fr"] };`);
    const out = quiet();
    runScan(await loadProject(dir), out);
    expect(out.lines.join("\n")).toMatch(/previously in old\/ .*src\/generated\/auto-locale\/.*left untouched/s);
    expect(read(dir, "old/fr.json")).toEqual({ [messageId("Hello")]: "Bonjour" });
    expect(read(dir, "src/generated/auto-locale/fr.json")).toEqual({ [messageId("Hello")]: "Bonjour" });
  });

  it("imports translations from the pre-CLI cache instead of retranslating them", async () => {
    const dir = project({ "auto-locale.config.mjs": COUNTING_CONFIG, "src/A.tsx": APP("<p>Hello</p>"), "node_modules/.cache/react-autolocale/fr.json": `{"Hello":"Bonjour"}` });
    const p = await loadProject(dir);
    expect(loadDicts(p).usedLegacy).toBe(true); // builds keep working before generate runs
    await runGenerate(p, {}, quiet());
    expect(g.__rlCalls).toBe(0);
    expect(read(dir, "src/generated/auto-locale/fr.json")).toEqual({ [messageId("Hello")]: "Bonjour" });
  });
});

describe("production build", () => {
  const sha = (dir: string) =>
    createHash("sha256")
      .update(["src/main.tsx", "src/App.tsx", "index.html"].map((f) => fs.readFileSync(path.join(dir, f), "utf8")).join("\0"))
      .digest("hex");
  let fetchSpy: ReturnType<typeof vi.spyOn> | undefined;
  afterEach(() => fetchSpy?.mockRestore());

  it("renders from the catalogs with no translation work, no network, and unchanged sources", async () => {
    const dir = project({
      "auto-locale.config.mjs": `export default { sourceLocale: "en", locales: ["en", "fr"], provider: async () => { globalThis.__rlCalls = 99; throw new Error("must not run"); } };`,
      // The prerender step starts its own Vite server from this file, so the alias must live here.
      "vite.config.mjs": `import reactAutolocale from ${JSON.stringify(path.join(REPO, "src/vite/index.ts"))};\nexport default { logLevel: "silent", plugins: [reactAutolocale()], resolve: { alias: { "react-autolocale": ${JSON.stringify(path.join(REPO, "src/runtime/index.ts"))} } } };\n`,
      "index.html": `<!doctype html><html><head><title>App</title></head><body><div id="root"></div><script type="module" src="/src/main.tsx"></script></body></html>`,
      "src/main.tsx": `import React from "react";\nimport { createRoot } from "react-dom/client";\nimport { AutoScale } from "react-autolocale";\nimport { App } from "./App";\ncreateRoot(document.getElementById("root")!).render(<AutoScale><App /></AutoScale>);\n`,
      "src/App.tsx": `import React from "react";\nexport function App() {\n  return (\n    <main>\n      <h1>Build better products</h1>\n      <input placeholder="Search products" />\n      <p>Not translated yet</p>\n    </main>\n  );\n}\n`,
    });
    const p = await loadProject(dir);
    scanProject(p);
    fs.writeFileSync(
      path.join(dir, "src/generated/auto-locale/fr.json"),
      JSON.stringify({ [messageId("Build better products")]: "Créez de meilleurs produits", [messageId("Search products")]: "Rechercher des produits" }),
    );
    const before = sha(dir);
    fetchSpy = vi.spyOn(globalThis, "fetch");
    const { build } = await import("vite");
    await build({ root: dir, logLevel: "silent" });

    const fr = fs.readFileSync(path.join(dir, "dist/fr/index.html"), "utf8");
    expect(fr).toContain("<h1>Créez de meilleurs produits</h1>");
    expect(fr).toContain(`placeholder="Rechercher des produits"`);
    expect(fr).toContain("<p>Not translated yet</p>"); // missing translation falls back to the source text
    expect(fs.readFileSync(path.join(dir, "dist/en/index.html"), "utf8")).toContain("<h1>Build better products</h1>");
    expect(g.__rlCalls).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(sha(dir)).toBe(before);
    expect(fs.readdirSync(path.join(dir, "src")).sort()).toEqual(["App.tsx", "generated", "main.tsx"]);
  }, 60_000);
});
