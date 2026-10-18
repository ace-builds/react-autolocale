# react-autolocale

Write your React + Vite app in one language. react-autolocale extracts the text, translates it with the engine you choose (Google Gemini, OpenAI, Anthropic Claude, or as a last option a free local model), and `vite build` produces a static page for every language (`/en/`, `/fr/`, `/es/`, ...). You don't call `t()` or manage keys, and your source files are never modified.

Translation is a separate, explicit command. Builds only read the generated catalogs. They never download a model, call an API or wait for a translation job.

## Quick start

You need a React + Vite project and an API key from the engine you choose: [Google Gemini](https://aistudio.google.com/apikey), [OpenAI](https://platform.openai.com/api-keys) or [Anthropic](https://console.anthropic.com/settings/keys). A free local model is also available, but it is the last option, not the recommended one (see [Choosing a translation engine](#choosing-a-translation-engine)).

**1. Install** (npm, yarn or pnpm)

```bash
npm install react-autolocale          # or: yarn add react-autolocale   |   pnpm add react-autolocale
```

**2. Run the setup wizard**

```bash
npx react-autolocale init             # or: yarn react-autolocale init   |   pnpm exec react-autolocale init
```

It asks these questions, in this order:

| Question | What to answer |
| --- | --- |
| **Source language** | The language your code's text is written in. Press **Enter** for English, or type to search the list (`fre`, `ja`) and press Enter on the one you want. |
| **Target languages** | Type to search, press **Tab** to select a language (repeat for each one), then **Enter**. Languages already listed in `<AutoScale languages>` are preselected. |
| **How would you like to translate?** | Use the arrow keys to pick a cloud provider (OpenAI, Anthropic Claude or Google Gemini) and press Enter. Nothing is chosen for you. The local model is the last option. |
| **Catalog folder** | Press **Enter** to keep the default. |
| **API key** | Paste your key; it is masked as you type. It is saved to `.env`, and `.env` is added to `.gitignore`. Press Enter to skip and add `GEMINI_API_KEY=...` (or `OPENAI_API_KEY` / `ANTHROPIC_API_KEY`) to `.env` yourself later. |

Press **Ctrl+C** or **Esc** at any question to cancel.

It writes `auto-locale.config.ts` and adds the plugin to your `vite.config`. It translates and downloads nothing. To skip the questions: `npx react-autolocale init --provider gemini --source en --locales fr,es`.

**3. Wrap your app once.** Open the file that renders `<App />` (usually `src/main.tsx` or `src/main.jsx`) and add the import and the wrapper. Keep `<StrictMode>` on the outside if you have it:

```tsx
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { AutoScale } from "react-autolocale";
import App from "./App";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <AutoScale>
      <App />
    </AutoScale>
  </StrictMode>,
);
```

No props are needed: the languages come from `auto-locale.config.ts`. Without this wrapper the translations exist, but the site stays in the original language.

**4. Generate the translations**

```bash
npx react-autolocale generate
```

You should see which engine is used and a count, for example `Using gemini:gemini-3.8-flash.` and `Translated 314 strings (fr 157, es 157)`. The translations are saved in `src/generated/auto-locale/`.

**This is the only step that uses your API key.** You run it on your own computer, once, and again only when your text changes. Nothing after this step needs the key or the internet.

**5. Run it and check it**

```bash
npm run dev                           # open http://localhost:5173/fr/ and /es/ (use the port it prints)
npm run build && npm run preview      # the finished pages: dist/fr/, dist/es/, ...
```

You do **not** need the API key for this step, or for deploying: `build` and `preview` only read the translations you already generated. Put the key in `.env` on your own computer and nowhere else, so you never add it to Vercel, Netlify or your CI.

Read the translated pages. Machine translation can get short labels or brand names wrong: fix them as described in [Fixing a translation](#fixing-a-translation), and list brand names in `<AutoScale exclude={["Acme Cloud"]}>`.

**6. Commit the translations**

```bash
git add src/generated/auto-locale
```

Commit that folder so builds and deploys never need an API key or a model. Never commit `.env`.

**Whenever you change text in your components**, run `npx react-autolocale sync`. Only new strings are translated, and a running dev server reloads when it finishes.

Optional: `npx react-autolocale add switcher` copies an editable language switcher into your project (see below).

## Workflow and commands

| Command | What it does | Network / models |
| --- | --- | --- |
| `init` | Creates `auto-locale.config.ts`, sets up the provider (API key into `.env` if you paste one), adds the Vite plugin. Keeps an existing config unless you confirm (or pass `--force`). | None |
| `scan` | Extracts strings and updates `.auto-locale/manifest.json` and the source catalog (`en.json`). | None |
| `translate` | Translates strings missing from the catalogs with the configured provider. Retries anything that failed before. `--lang fr,es` limits it. | Provider only |
| `generate` | `scan` then `translate`. Incremental: existing translations are kept. | Provider only |
| `sync` | Same as `generate`. Use it after editing text. | Provider only |
| `clean` | Lists strings no longer in the source; removes their translations only after you confirm (`--yes` in scripts). | None |
| `export` | Copies the translations into `react-autolocale.overrides.json` for hand editing. | None |
| `add switcher` / `add banner` | Copies an editable component into your project. | None |

`init` also accepts flags, so it can run without prompts in scripts: `--source en --locales fr,es --provider local|openai|anthropic|gemini|ollama --model <id> --api-key-env <NAME> --output <dir> --yes` (or `-y`). Every command takes `--root <dir>`; the default is the nearest folder with a `package.json`.

`npx react-autolocale --help` lists the commands, and `npx react-autolocale <command> --help` (or `help <command>`) shows a command's flags and examples. A mistyped command suggests the closest one. Exit codes: `0` success, `1` failed strings or an error, `2` an invalid flag or argument, `127` an unknown command, `130` cancelled.

A `generate` run looks like this:

```text
┌   React Auto Locale
│
◆  Scanned 24 source files
◆  Found 3 new strings (84 in use)
●  Using OpenAI (gpt-6-astra).
◇  French (fr): 3 strings translated
◇  Spanish (es): 3 strings translated
◇  German (de): 3 strings translated
◆  Kept 243 existing translations
◆  Translated 9 strings (fr 3, es 3, de 3)
◆  Updated 3 locale catalogs in src/generated/auto-locale/
│
└  No source files modified.
```

In a terminal each language shows a live progress bar while it translates. In CI and pipes the progress is printed as plain `fr: 40/120` lines instead.

Failures are listed by language and message id, and the command exits with code 1. They show the source text until you fix them. `npx react-autolocale translate` retries just those strings.

## Configuration

`auto-locale.config.ts` (written by `init`, also `.mts`/`.js`/`.mjs`):

```ts
import { defineConfig } from "react-autolocale/config";

export default defineConfig({
  sourceLocale: "en",
  locales: ["en", "fr", "es", "de"],
  provider: { name: "openai", model: "gpt-6-astra", apiKeyEnv: "OPENAI_API_KEY" },
  // output: "./src/generated/auto-locale",   // optional, see "Generated files"
  // include: ["src"],                         // folders scanned for JSX
  // exclude: ["Acme Cloud"],                  // phrases never translated (adds to <AutoScale exclude>)
  // glossary: { fr: { Roadmap: "Feuille de route" } },
});
```

When the config sets `sourceLocale` and `locales`, `<AutoScale>` needs no language props. Projects without a config file keep working: the languages come from `<AutoScale original="en" languages={["fr", "es"]}>` and the local model is used. `seo` and `siteUrl` stay on `<AutoScale>`. Invalid settings, such as an unknown language code, a half-set language pair or an unknown provider, stop every command with a message naming the setting.

## Choosing a translation engine

The engine only matters to `translate`/`generate`/`sync`. Extraction, the catalogs, the build and the runtime work the same with every engine. `init` never picks one for you.

| Engine | Quality | What you need | Cost |
| --- | --- | --- | --- |
| **Google Gemini**, **OpenAI**, **Anthropic Claude** | Best. Each string is sent with the element it appears in. | An API key | Billed by the provider (Gemini has a free tier with low limits) |
| **Ollama** | Good, depends on the model. | Ollama installed, with a model | Free |
| **Local model** (last option) | **May not match the cloud models**, especially short labels and less common languages. | A **large download** on first use and a fast-enough CPU | Free |

**OpenAI** (`{ name: "openai", model?, apiKeyEnv?, baseURL? }`) and **Anthropic Claude** (`{ name: "anthropic", model?, apiKeyEnv?, effort? }`) avoid the downloads and are usually quicker for large jobs. You need an API key, and usage is billed by the provider.
- **Setup**: install the official SDK in your project (`npm install -D openai` or `npm install -D @anthropic-ai/sdk`; `init` offers to do it). Only the CLI loads it; it never reaches the browser bundle.
- **Keys**: they are read from `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` (change the name with `apiKeyEnv`), from the environment or from `.env` / `.env.local` in the project root. Variables already set in your shell win. If you paste a key into `init`, it is appended to `.env` (never over an existing value) and `.env` is added to `.gitignore`. Keys are never printed or written into the config, the catalogs or the bundle. A missing key stops the command before any request is made.
- **Defaults**: `gpt-6-astra` for OpenAI, and `claude-opus-5-5` at `effort: "low"` for Anthropic. Short UI strings rarely need more; Claude refusals fall back server-side on models that support it.
- **Requests**: strings are sent in batches of 25, 3 at a time, with each string's element (`button`, `h1`, ...) as context. Replies are structured JSON with one translation per string; a batch that comes back the wrong size is retried one string at a time. The SDKs time out after 2 minutes and retry rate limits and server errors 3 times.

**Google Gemini** (`{ name: "gemini", model?, apiKeyEnv?, baseURL? }`) works the same way, with nothing to install: it calls Gemini's REST API directly, so there is no SDK.
- **Key**: create one in [Google AI Studio](https://aistudio.google.com/apikey) and put `GEMINI_API_KEY=...` in `.env` (or let `init` save it for you). Change the variable name with `apiKeyEnv`.
- **Model**: `gemini-3.8-flash` by default. Set `model` to any model id shown in AI Studio, for example a newer Flash or a Pro model for harder text.
- **Behavior**: the same batching and context as the other cloud providers, with structured JSON replies. Rate limits (429) and server errors are retried with backoff, honoring `Retry-After`. A rejected key, a wrong model name or an exhausted quota stops the run with a clear message before anything is stored. Free-tier keys have low rate limits, so large first runs may need to be repeated; finished work is saved after every batch.
- **Choose it**: `npx react-autolocale init --provider gemini`, or in the config: `provider: { name: "gemini" }`.
- **Errors**: a rejected key, an unknown model or a used-up quota stops the run instead of failing every batch. A failing provider is never swapped for another one.

**Ollama** (`{ name: "ollama", model: "llama3.1", url? }`) runs a local LLM that receives the context too.

**Your own engine**: set `provider` to a function (or an object with `translate`). You can wrap DeepL, Google Cloud Translation, a self-hosted API or another LLM:

```ts
provider: async ({ texts, contexts, from, to }) => texts.map((t, i) => myTranslate(t, from, to, contexts[i])),
```

**Local model** (`{ name: "local" }`) is the last option, not the recommended one. It is free and works offline with no API key, but you should know what you are choosing:
- **You must download models first.** `init` and builds download nothing; the first `translate`/`generate` does.
- **The quality may be lower than the cloud models above.** Short labels such as "Home" or "Save" and less common languages are the usual weak spots. Review the result, and fix strings in the overrides file.

It runs on your machine through Transformers.js, using OPUS-MT for English sources and NLLB-200 for everything else. The cost is disk, RAM and CPU time:
- **Downloads**: on the first `translate`, about 110 MB per English→X language and 870 MB for NLLB-200 (non-English sources, and Portuguese, Japanese, Korean and the other NLLB languages below). If your project doesn't have `@huggingface/transformers`, a 470 MB engine is also installed once into `~/.cache/react-autolocale/engine`.
- **Reuse**: models are cached in `~/.cache/react-autolocale` and shared by every project. A loaded model is kept for the whole run.
- **Speed**: OPUS-MT translates 8 strings per call; on an Apple-silicon Mac that measured about 5× faster than one at a time (32 UI strings in about 0.65 s per language once the model was loaded). NLLB runs one string at a time, because batching produced garbage, so it is much slower.
- **Progress and interruption**: each language gets a progress bar (model downloads show their percentage in it), and work is saved after every batch. Press Ctrl+C once to stop after the batch in flight; a second Ctrl+C quits at once. A crash loses at most one batch.

Engines receive text with protected pieces replaced by tokens (`X0X`, `{name}`) and must return them unchanged. Whatever the engine, the results are checked: a translation that drops a token or changes a number is retried once with numbers locked, and is otherwise reported as failed. It is never stored.

## Generated files and Git

```text
my-app/
├── src/
│   └── generated/auto-locale/     # commit this: what the app ships
│       ├── en.json                # message id -> source text
│       ├── fr.json                # message id -> translation
│       ├── banner.json            # the language banner's phrases
│       └── index.ts               # sourceLocale, locales, catalog file names
├── .auto-locale/
│   ├── manifest.json              # commit this: ids, source text, element, files, status
│   └── cache.json                 # ignored by init: every machine translation, for reuse
└── auto-locale.config.ts
```

- **Location**:
  - `src/generated/auto-locale/` when the project has a root-level `src/` folder, otherwise `generated/auto-locale/`.
  - An `output` in the config always wins.
  - The CLI, the scanner and the Vite plugin all resolve the location the same way.
- **Message ids**:
  - `msg_` plus a hash of the whitespace-normalized text, so moving code or editing other files never changes an id.
  - Identical text shares one id and one translation. Use `useLocalized` when one occurrence needs different wording.
  - If two different strings ever produced the same id, `scan` stops and names them; it never silently mixes them up.
- **Small diffs**:
  - Catalogs are pretty-printed JSON with sorted keys, written only when something changed, and written atomically (temp file + rename).
  - A new string adds one line per catalog, and existing entries are never rewritten. You can edit `fr.json` by hand, and later runs keep your edit. An empty value counts as missing.
- **Removed strings**:
  - Marked `unused` in the manifest. Their translations stay until `clean` removes them, but they are not shipped to the browser.
  - If the text comes back, its translation is restored from `.auto-locale/cache.json` without calling the provider.
- **Moving the output**:
  - After `output` changes, the next `scan` copies any missing target catalogs to the new folder and warns you.
  - The old folder is never moved or deleted; remove it yourself once you've checked the new one.

## Production builds

`vite build` and `vite dev` only read the catalogs, the manifest and the overrides file. They never download or load a translation model, call a translation API, regenerate catalogs, or need an API key. A build works offline in CI with only the committed files. A string without a translation renders its source text, and the build prints a one-line count (`Untranslated strings (shown in en): fr 3. Run npx react-autolocale sync.`). In development the same notice appears when you add new text.

## Upgrading from earlier versions

Earlier versions translated during `vite build` and kept translations in `node_modules/.cache/react-autolocale/`:
- **Before you run anything new**: builds still read that folder, with a warning, so nothing breaks.
- **After `npx react-autolocale generate`**: those translations are copied into the new catalogs without being retranslated. The old folder is left in place.
- **Moved options**: `engine` and `glossary` in `vite.config` are now ignored, with a warning. Move them to `auto-locale.config.ts` as `provider` and `glossary`. The `overrides` and `routes` plugin options and `react-autolocale.overrides.json` work as before.

## Multi-page apps (React Router)

Every page is generated, with nothing to configure. The build finds pages two ways: by following the links in each page, and by reading the fixed routes in your router code (`<Route path="/thank-you">`, nested routes, and `createBrowserRouter` objects). Pages written as `/fr/about/index.html` etc. are created for each language.

Dynamic routes (`/users/:id`) can't be known from code, so list the real pages you want with the `routes` option, which can also be a function that fetches them:

```ts
reactAutolocale({ routes: async () => (await getUsers()).map((u) => `/users/${u.id}`) })
```

Give your router the language as its basename, and remount it when the language changes:

```tsx
function Shell() {
  const { basePath, language } = useLanguage();
  return (
    <BrowserRouter basename={basePath} key={language}>
      <Routes>...</Routes>
    </BrowserRouter>
  );
}

<AutoScale original="en" languages={["fr", "es"]}><Shell /></AutoScale>
```

Your host must serve `/fr/about/index.html` for `/fr/about`, which static hosts do by default.

## Fixing a translation

Edit the value in the catalog (`src/generated/auto-locale/fr.json`) and commit it. Later runs keep your edit.

Prefer to edit by source text? Run `npx react-autolocale export`: it writes every translation into `react-autolocale.overrides.json` in your project root, keyed by the original text. Entries in that file always win over the catalogs, apply on the next build or dev reload, and are skipped by `translate`.

You can also fix a few strings in code:

Machine translation sometimes gets short UI words wrong (a nav link "Home" may come back as "Sommaire"). Correct any string in the plugin options; overrides always win:

```ts
reactAutolocale({ overrides: { fr: { Home: "Accueil" }, es: { Home: "Inicio" } } })
```

## Different values per language (prices, links, and more)

Some things should differ by language, not just be translated: a price, a link to a localized page, a phone number.

```tsx
import { useLocalized, Localized, ForLanguages, useFormat } from "react-autolocale";

// A value: falls back to `default`, then to the original language
const href = useLocalized({ en: "/pricing", fr: "/tarifs", es: "/precios", default: "/pricing" });
<a href={href}>Pricing</a>                        // "Pricing" itself is still translated for you

// A block of UI
<Localized en={<UsPhone />} fr={<FrPhone />} default={<UsPhone />} />

// Content for some languages only (local offers, legal notices)
<ForLanguages only={["fr", "es"]}>Free shipping in Europe</ForLanguages>
<ForLanguages except={["ja"]}><CookieNotice /></ForLanguages>

// Numbers, prices and dates in the visitor's format
const format = useFormat();
format.currency(1234.5, "EUR");   // "€1,234.50" in English, "1 234,50 €" in French
format.number(1250000);           // "1,250,000" / "1 250 000"
format.percent(0.15);             // "15%" / "15 %"
format.date(new Date());          // "Oct 9, 2026" / "9 oct. 2026"
```

All of these are part of the prerendered pages, so `/fr/` and `/en/` ship with their own values in the HTML. Values you pick in code are your own data and are never machine-translated. `basePath` from `useLanguage()` is the current prefix (`/fr`) for building internal links. With React Router, the page you link to must be a route you define (here `/tarifs`); the build does not rename routes by language.

## Better translations: glossary and context

Add a `glossary` in `auto-locale.config.ts` for terms that must always translate a given way. It is applied before the engine sees the text, with every engine:

```ts
glossary: { fr: { Roadmap: "Feuille de route" }, es: { Roadmap: "Hoja de ruta" } },
```

The local models translate each string without knowing where it appears, so a lone "Home" in a nav bar can come back wrong. OpenAI, Claude, Ollama and custom engines receive the element each string sits in (`"button"`, `"a"`, `"h1"`, `"placeholder"`, ...), which fixes most of these.

## Language switcher

Switching is just navigation to `/fr/` (instant, no reload; a page load when `seo` is on). You choose the UI:

```bash
npx react-autolocale add switcher   # copies an editable LanguageSwitcher into src/components
```

or import the ready-made dropdown: `import { LanguageSwitcher } from "react-autolocale"`.

Build your own with the hook:

```tsx
const { language, languages, setLanguage, basePath } = useLanguage();
```

## What gets translated

You write normal code and nothing in your files changes. The scanner finds text wherever people usually put it, not only in JSX:

| Where the text is written | Example |
| --- | --- |
| JSX text | `<h1>Welcome</h1>` |
| Sentences with variables, links or bold words | `<p>Hello {user.name}</p>`, `<p>Read the <a href="/terms">terms</a> now</p>` (one message: `Read the {1} now`, so word order can change per language) |
| Attributes | `placeholder`, `title`, `alt`, `aria-label` (and `aria-description`, `aria-placeholder`, ...), `<input type="submit" value="Send">`, `<meta name="description" content="...">`, `data-tooltip` |
| Props on your own components | `<Hero title="Welcome" subtitle="Build it" />`, `<Chart text="VEHICLE · VAN" />` (not code-like props such as `variant`, `size`, `className`, `to`, `href`, `icon`) |
| Expressions in JSX | `{open ? "Close menu" : "Open menu"}`, `{error && "Something went wrong"}`, `{name \|\| "Guest"}`, `` {`Hello, ${name}!`} ``, `{"Page " + n + " of " + total}` |
| Data in arrays and objects, in the same file or a shared content file | `const nav = ["Home", "Pricing"]`, `{ title: "Fast", body: "Ships in seconds." }`, `[["Weight", "1.56 kg"]]`, `export const specs = {...}` in `site.js` |
| JSON files your code imports | `import faq from "./faq.json"` (keys such as `id`, `url`, `type`, `href` are skipped) |
| Text inside logic | `useState("Loading...")`, `setError("Invalid email")`, `alert("Saved!")`, `toast.success("Done")`, `document.title = "Dashboard"`, default props, functions that return labels |
| Hand-written elements | `React.createElement("h1", null, "Hello")` |

Numbers are kept exactly as written: `translate` checks that every digit (prices, phone numbers, hours, versions) survives translation, re-translates with the number locked if not, and otherwise keeps the original text. Use `useFormat()` (below) for numbers you compute.

### How it tells text from code

A string is translated when it reads like text a person sees. URLs, file names, class names (`"flex items-center"`), CSS values, colors, SVG paths, ids, lowercase code words (`"primary"`, `"submit"`), date formats and similar are left alone. Whole categories of code are never touched: object keys, `import` paths, TypeScript types and enums, `className`/`style`/`href`/`id` and other code attributes, selectors, storage keys, `fetch` and `console` calls, analytics events, class helpers (`clsx`, `cn`), and `throw new Error(...)`.

**A string your code depends on is never translated, anywhere in the project.** If the code compares it (`status === "Active"`, `case "Open":`), looks it up (`icons["Home"]`, `{ Home: ... }`), checks it (`.includes("Pending")`) or names it in a type (`type S = "Open" | "Closed"`), that exact text is left as written everywhere, so nothing breaks.

### When it gets one wrong

- `// i18n-ignore` on or above a string (or its statement) leaves it alone; `translate="no"` on an element leaves it and everything inside it alone; `exclude` lists phrases such as brand names that are never translated.
- `msg("text")` forces a string to be translated wherever the automatic rules can't see it, such as a lowercase word: `import { msg } from "react-autolocale"` then `msg("open")`, `msg("Hello {name}", { name })`. It returns the text, so it is safe without the plugin.

```tsx
<p translate="no">Acme Cloud</p>                       // never translated
const DEBUG_LABEL = "Internal build"; // i18n-ignore
```

### Good to know

- **Switching language reloads the page** when your app has text outside React components (data in a `site.js`, `useState` starting values, JSON): that text is translated when the page loads, so the new language needs a fresh page. Apps that only use text in components switch in place without a reload. Either way each language has its own URL.
- **Compare ids, not labels.** A tab labelled `"All"` that your code checks with `=== "All"` stays in English (the code needs that exact text). To translate the label, compare something else: `{ id: "all", label: "All" }` and `filter === "all"`.
- Text passed through your own function (`t(...)`-style helpers) and data that arrives at runtime (API responses, user-written content) is not translated: it does not exist at build time. Text you write in code around those values is.
- Not translated yet: Markdown/MDX files, HTML inside strings (`dangerouslySetInnerHTML`), and CSS `content:`.

## Supported languages

Use these codes in `languages={[...]}`. The source (`original`) language can be any of them.

| Code | Language | Model |
| --- | --- | --- |
| `fr` | French | OPUS-MT |
| `es` | Spanish | OPUS-MT |
| `de` | German | OPUS-MT |
| `it` | Italian | OPUS-MT |
| `nl` | Dutch | OPUS-MT |
| `ru` | Russian | OPUS-MT |
| `zh` | Chinese (Simplified) | OPUS-MT |
| `ar` | Arabic (RTL) | OPUS-MT |
| `hi` | Hindi | OPUS-MT |
| `sv` | Swedish | OPUS-MT |
| `da` | Danish | OPUS-MT |
| `fi` | Finnish | OPUS-MT |
| `cs` | Czech | OPUS-MT |
| `hu` | Hungarian | OPUS-MT |
| `ro` | Romanian | OPUS-MT |
| `uk` | Ukrainian | OPUS-MT |
| `vi` | Vietnamese | OPUS-MT |
| `id` | Indonesian | OPUS-MT |
| `pt` | Portuguese | NLLB |
| `ja` | Japanese | NLLB |
| `ko` | Korean | NLLB |
| `tr` | Turkish | NLLB |
| `pl` | Polish | NLLB |
| `no` | Norwegian | NLLB |
| `el` | Greek | NLLB |
| `he` | Hebrew (RTL) | NLLB |
| `th` | Thai | NLLB |
| `bn` | Bengali | NLLB |
| `fa` | Persian (RTL) | NLLB |
| `ur` | Urdu (RTL) | NLLB |
| `bg` | Bulgarian | NLLB |
| `hr` | Croatian | NLLB |
| `sk` | Slovak | NLLB |
| `ca` | Catalan | NLLB |
| `ms` | Malay | NLLB |
| `sw` | Swahili | NLLB |
| `tl` | Tagalog | NLLB |
| `en` | English (default source) | NLLB when used as a target |

With the local engine, OPUS-MT models (about 110 MB each on disk) are used when the source language is English. NLLB-200 is one larger download (about 870 MB) shared by all the languages marked NLLB, and is also used for any non-English source. Cloud engines handle every code in the table. Right-to-left languages automatically get `dir="rtl"` on the page.

### Quality by language

Every supported language was run through the real models on sample UI sentences: all 37 produce output in the right writing system, with no runaway or repeated text. How good that output is varies. French, Spanish, German, Italian, Dutch, Swedish, Danish, Japanese and Korean read naturally on ordinary sentences. Short imperative labels are the weak spot in many languages: "Save 20%" comes back as "save a file" in Russian, Ukrainian, Hungarian, Hindi and Romanian, "Sign in" comes back wrong in Russian, Chinese, Arabic and Vietnamese, and Arabic and Vietnamese could not keep the number in "Save 20% on your first order" (the original English is kept for such strings rather than risking a wrong number). Treat these as drafts: review the languages you ship in `react-autolocale.overrides.json`, add a `glossary` for key terms, or use an engine that gets context (see above). You can re-run the check yourself with `RUN_MODELS=1 pnpm exec vitest run test/models.test.ts`.

## Automatic language navigation

Whether a visitor is moved depends on the URL they land on:

| Where they land | What happens |
| --- | --- |
| `/` or `/about` (no language in the URL) | Sent to their saved language, otherwise their browser language, if you support it (a French browser lands on `/fr/about`). |
| `/en/about` or `/fr/about` (explicit language URL) | Never redirected. The page they asked for is the page they get. |

- A language chosen in the switcher is remembered and wins on later visits. The browser language itself is not saved; it is checked each time.
- The browser's language setting is used, not the visitor's physical location. Unsupported browser languages stay on the original.
- The root page redirects before it paints, so visitors don't see a flash of the wrong language.

This follows common practice. Redirecting the bare root by browser language is widespread, while forcing visitors off an explicit language URL is avoided: shared links and search results should open the page they point to, redirect loops are avoided, and it respects someone who chose a language on purpose. Search engines are told which URL belongs to which language through `hreflang` tags (see SEO below), so a French searcher is normally shown the `/fr/` URL in the first place. Visitors who land on another language's URL can use the language switcher.

## Suggesting the visitor's language (optional banner)

Instead of forcing a redirect on an explicit URL, you can offer the visitor their browser language: a French visitor on `/en/about` sees "Cette page est également disponible en Français." with a button to switch and one to dismiss. It appears only when the browser language is supported and differs from the page, is shown after the page loads (so it never changes the HTML search engines see), remembers a dismissal, and stays hidden once the visitor has picked a language. The text is shown in the visitor's own language.

It is off unless you add it, and you decide how it looks:

```tsx
import { LanguageBanner } from "react-autolocale";

<LanguageBanner />                                   // ready-made bar, style it with className / style
<LanguageBanner className="my-bar" />                // your own CSS replaces the default look

<LanguageBanner>                                     // or build the markup yourself
  {(s) => (
    <aside>
      {s.text} <button onClick={s.accept}>{s.switchLabel}</button>
      <button onClick={s.dismiss}>{s.dismissLabel}</button>
    </aside>
  )}
</LanguageBanner>
```

Prefer to own the component? `npx react-autolocale add banner` copies an editable `LanguageBanner` into your project. For full control use the hook, `useLanguageSuggestion()`, which returns `null` or `{ language, native, text, switchLabel, dismissLabel, accept, dismiss }`.

## SEO (opt-in)

By default react-autolocale does not touch your SEO: the only changes to `<head>` are one inline script holding that page's translations, plus `lang` and `dir` on `<html>`.

Turn it on with `seo` on the provider:

```tsx
<AutoScale original="en" languages={["fr", "es"]} seo siteUrl="https://example.com">
  <App />
</AutoScale>
```

With `seo` the build also:
- translates `<title>` and the description / Open Graph / Twitter meta tags,
- adds `<link rel="canonical">` and `hreflang` alternates (plus `x-default`) to every page,
- writes `sitemap.xml` with the alternates (needs `siteUrl`; reference it from your `robots.txt`).

With `seo`, switching language navigates to the real page (so its head tags are correct) instead of swapping in place. Brand names in the title are translated like any text, so add them to `exclude`.

## Troubleshooting

- **`init` says `"fr, es" is not a supported code` at "Source language"**: that question takes one code (your code's language, usually `en`). The list of languages to add comes at the next question.
- **The site is still in English after `generate`**: wrap your app in `<AutoScale>` (step 3 of the quick start), restart `npm run dev`, and open `/fr/` or `/es/`.
- **`init` printed instructions with `original="en" languages={...}`**: you have the older 0.2.0, which works differently. Upgrade: `npm install react-autolocale@latest` (see [Upgrading from earlier versions](#upgrading-from-earlier-versions)).
- **"No translations in src/generated/auto-locale/ yet" during a build**: run `npx react-autolocale generate`, then commit the folder.
- **"OPENAI_API_KEY is not set"**: add it to `.env` in the project root or export it in your shell, then rerun `translate`. No request was made.
- **Gemini says "model not found" or "no longer available"**: Google retires models over time. Set `model` in the provider to a current id from [AI Studio](https://aistudio.google.com) (`provider: { name: "gemini", model: "<id>" }`) and run `generate` again; strings that already succeeded are kept.
- **"This provider needs the openai package"** (or `@anthropic-ai/sdk`): install it as a dev dependency of your app.
- **Some strings failed**: the report lists them by id, language and reason. Rerun `npx react-autolocale translate`, or write the value into the catalog or the overrides file yourself.
- **The local model is slow**: NLLB languages run one string at a time on the CPU. Translate a subset with `--lang`, or switch `provider` to OpenAI or Claude for big jobs. Existing translations are kept either way.
- **Interrupted run**: everything finished before the interruption was saved; run the same command again.
- **Corrupted JSON**: commands stop and name the file instead of treating it as empty; fix it or restore it from Git.

## Limits

- Data that arrives at runtime (API responses, user-written content) is not translated: it does not exist at build time. Text you write in JSX around those values is.
- No plural rules: write `{count} message(s)` or branch in your code (`count === 1 ? "1 message" : `${count} messages``; both branches are translated).
- Strings your code compares, uses as keys or names in types are left as written (see "How it tells text from code"). Lowercase single words in data (`["red", "green"]`) look like code and are skipped; wrap them with `msg()`.
- Dynamic routes (`/users/:id`) only get pages you list in `routes`, or that are linked.
- `<AutoScale>` props must be literals so the plugin can read them at build time.
- The CLI reads `auto-locale.config.ts`, not `vite.config`. Set `include` there if you change the plugin's `include`.
- Identical text always shares one translation.
- Use Vite's default `base: "/"`.
- Machine translation is draft quality. Short labels, long sentences with variables and less common languages need a human look: use the overrides file.
