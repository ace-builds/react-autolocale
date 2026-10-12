# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

`react-autolocale` is a Vite plugin with a React runtime and a CLI. You wrap a React app in `<AutoScale>`, and the build turns it into prerendered static pages for each language (`dist/fr/`, `dist/fr/about/`, ...). Translation is an explicit CLI step (`generate`/`sync`/`translate`) that writes catalogs into the project. The build only reads the catalogs and never translates. Engines: the local Transformers.js models (OPUS-MT for English sources, NLLB-200 for everything else), Ollama, OpenAI, Anthropic, or a custom function. The provider component is named `AutoScale`, not "AutoLocale", and so is the boot global `window.__AUTOSCALE__`. README.md is the user-facing spec, so update it whenever behavior changes.

## Commands (pnpm, Node >= 20)

- `pnpm build`: runs tsdown to build four ESM entries: `index` (runtime), `vite` (plugin), `config` (`defineConfig`, safe to import from Node) and `cli` (bin).
- `pnpm test`: runs vitest. For a single file, use `pnpm exec vitest run test/transform.test.ts`. For a single test, add `-t "<name>"`.
- `pnpm typecheck`: runs `tsc -p .`.
- `RUN_MODELS=1 pnpm exec vitest run test/models.test.ts`: runs the real models. It is slow, downloads models, and is skipped unless `RUN_MODELS` is set. Set `NUM_LANGS=fr,es,ja` to choose the languages.
- `pnpm e2e`: builds the library, packs it with `npm pack`, and installs it into a temp copy of `examples/router-app`. It then runs `react-autolocale generate` (local models) and `vite build` on that app, and drives Chrome through playwright-core. It needs network access and Chrome (set `CHROME_PATH` to use a different Chrome).

## Architecture

Everything resolves through `loadProject` ([src/core/project.ts](src/core/project.ts)), which the CLI and the plugin share. It loads `auto-locale.config.*` through Vite's `loadConfigFromFile`, validates it, and falls back to the `<AutoScale>` literal props ([src/core/site.ts](src/core/site.ts)) when the config doesn't set the languages. It also resolves the catalog folder ([src/core/paths.ts](src/core/paths.ts)): an explicit `output`, else `src/generated/auto-locale` when a root-level `src/` exists, else `generated/auto-locale`. Metadata lives in `.auto-locale/`.

**CLI pipeline** ([src/cli/commands.ts](src/cli/commands.ts)):

1. **Scan** ([src/core/manifest.ts](src/core/manifest.ts), [src/core/scan.ts](src/core/scan.ts)):
   - Collects strings (and with `seo`, the `index.html` head strings from [src/core/head.ts](src/core/head.ts)).
   - Writes `.auto-locale/manifest.json` (message id → text, context, files, `active`/`unused`), the source catalog `<output>/<src>.json` and `<output>/index.ts`.
   - Message ids are `msg_` + a sha256 prefix of the normalized text ([src/core/ids.ts](src/core/ids.ts)). The transform computes the same ids.
2. **Translate** ([src/core/catalog.ts](src/core/catalog.ts)): fills only active ids missing from `<output>/<lang>.json`.
   - Order: valid catalog entry (kept) → overrides file (skipped) → `.auto-locale/cache.json` (provider cache keyed by text) → glossary → provider.
   - Works in chunks and writes catalog + cache atomically after each one ([src/core/files.ts](src/core/files.ts); sorted keys, unchanged files aren't rewritten).
   - `translateTexts` ([src/core/cache.ts](src/core/cache.ts)) masks exclude phrases, `{var}` placeholders and digits. `digitsPreserved` failures are retried with numbers locked; anything still bad is reported as failed, never stored.
   - A `TranslationError` with `fatal: true` (missing key or SDK, auth, bad model, quota) stops the run.
3. **Providers** ([src/core/providers.ts](src/core/providers.ts)):
   - OpenAI and Anthropic use their official SDKs (optional peer deps, imported from the user's project). Requests go in batches of 25 with concurrency 3 and JSON-schema output.
   - Local is `createLocalTranslator` in [src/core/translate.ts](src/core/translate.ts). OPUS-MT runs 8 per batch; NLLB runs with batch size 1 on purpose, because batched padding produced garbage. If the project has no `@huggingface/transformers`, the engine is installed into `~/.cache/react-autolocale/engine`.
   - Only the CLI imports this module.

**Vite plugin** ([src/vite/index.ts](src/vite/index.ts)) is read-only:
- `loadDicts` merges catalogs (active ids only), the pre-CLI legacy cache in `node_modules/.cache/react-autolocale` (fallback) and overrides (`overrides` option beats `react-autolocale.overrides.json` beats catalogs).
- **Transform** ([src/core/transform.ts](src/core/transform.ts)) rewrites JSX text and attributes into `__RLT i=<id> s=<text>`, `__RLTD` and `__rl(id, text)` from `react-autolocale`. The extracted strings must match what scan collects, since both use the same code.
- **Virtual module** `virtual:react-autolocale` (typed in [src/virtual.d.ts](src/virtual.d.ts)) exposes `original`, `languages`, `seo`, `banner` and `loaders`. The loaders point at `virtual:react-autolocale/dict/<lang>` (id-keyed). It is left out of the tsdown bundle. The runtime is served as source (`optimizeDeps.exclude`, `ssr.noExternal`) so that it can import the module.
- **Prerender** ([src/vite/prerender.ts](src/vite/prerender.ts)) runs in `closeBundle` and starts its own Vite SSR server from the project's vite config. For each language and route it:
  - renders the app's entry inside jsdom, with globals installed, browser APIs polyfilled and `window.__AUTOSCALE__ = { lang, dict }` (id-keyed)
  - waits for the DOM to settle, then crawls the same-language links on the page
  - writes `dist/<lang>/<route>/index.html`

  Routes also come from static router analysis ([src/core/routes.ts](src/core/routes.ts)) and the `routes` option, up to a cap of 500 pages. [src/vite/seo.ts](src/vite/seo.ts) writes the SEO tags and sitemap, using the text-keyed dicts (`headDicts`), and [src/core/redirect.ts](src/core/redirect.ts) writes the root redirect script.

**Runtime** ([src/runtime/index.ts](src/runtime/index.ts)): exports the `AutoScale` provider, `useLanguage`, `useLocalized`/`Localized`/`ForLanguages`, `useFormat`, `LanguageSwitcher` and `LanguageBanner`/`useLanguageSuggestion`. It boots from `window.__AUTOSCALE__` in the prerendered HTML. The URL prefix decides the language. Explicit `/xx/` URLs are never redirected, and only un-prefixed URLs redirect, by saved or browser language.

**Dev server**: never translates. New strings without a translation produce a debounced warning that suggests `sync`. Changes to catalogs, the manifest, the overrides file or the config re-read everything, invalidate the virtual modules and trigger a full reload.

**CLI** ([src/cli/index.ts](src/cli/index.ts)):
- `init` ([src/cli/init.ts](src/cli/init.ts)) is the wizard: it detects the project, asks for languages, provider and output, writes `auto-locale.config.ts`, appends API keys to `.env` (never printed), adds `.gitignore` lines and patches the Vite config through [src/cli/viteConfig.ts](src/cli/viteConfig.ts). It also takes flags for non-interactive use.
- `scan`, `translate`, `generate`/`sync` and `clean` live in [src/cli/commands.ts](src/cli/commands.ts).
- `export` writes the overrides file from the catalogs.
- `add switcher|banner` copies an editable component into the project.
