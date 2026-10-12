import path from "node:path";
import type { Plugin, ResolvedConfig, ViteDevServer } from "vite";
import { readBanner } from "../core/banner.js";
import { loadDicts, type LoadedDicts } from "../core/catalog.js";
import { messageId } from "../core/ids.js";
import { getLanguage } from "../core/languages.js";
import { mergeOverrides, OVERRIDES_FILE, readOverrides } from "../core/overrides.js";
import { loadProject, type Project } from "../core/project.js";
import { discoverRoutes } from "../core/routes.js";
import { isSourceFile } from "../core/scan.js";
import type { BannerText } from "../core/suggestion.js";
import { ollama, type TranslateFn, type Translator } from "../core/translate.js";
import { transformJsx } from "../core/transform.js";
import { prerender } from "./prerender.js";

const VIRTUAL_ID = "virtual:react-autolocale";
const RESOLVED_ID = "\0" + VIRTUAL_ID;
/** One module per language, so each dictionary is fetched only when that language is used. */
const DICT_PREFIX = VIRTUAL_ID + "/dict/";

export interface ReactAutolocaleOptions {
  /** Folders (relative to the project root) scanned for JSX. Prefer `include` in auto-locale.config.ts, which the CLI also reads. */
  include?: string[];
  /** Fix individual translations in code, e.g. { fr: { Contact: "Contact" } }. Adds to (and wins over) react-autolocale.overrides.json. */
  overrides?: Record<string, Record<string, string>>;
  /**
   * Extra pages to build, mainly dynamic ones such as "/users/1" (a function can fetch them). Pages reached
   * by links and fixed routes written in your router (<Route path="/thank-you">) are found automatically.
   */
  routes?: string[] | (() => string[] | Promise<string[]>);
  /** @deprecated Builds no longer translate. Set `provider` in auto-locale.config.ts; `react-autolocale translate` uses it. */
  engine?: Translator | TranslateFn;
  /** @deprecated Builds no longer translate. Set `glossary` in auto-locale.config.ts. */
  glossary?: Record<string, Record<string, string>>;
}

/**
 * Reads the generated catalogs and serves them to the runtime. It never translates, downloads a model or calls
 * a translation API: missing translations show the source text, and `react-autolocale sync` fills them.
 */
export default function reactAutolocale(options: ReactAutolocaleOptions = {}): Plugin {
  let config: ResolvedConfig;
  let root = process.cwd();
  let includeDirs: string[] = [];
  let project: Project;
  let dicts: LoadedDicts = { byId: {}, byText: {}, missing: {}, usedLegacy: false };
  let banner: Record<string, BannerText> = {};
  let server: ViteDevServer | undefined;
  let rendered = false;

  const log = (msg: string) => console.log(msg);
  const warn = (msg: string) => config?.logger ? config.logger.warn(`[react-autolocale] ${msg}`) : log(`[react-autolocale] ${msg}`);

  async function refresh(): Promise<void> {
    project = await loadProject(root, { log });
    if (options.include) project.include = options.include;
    includeDirs = project.include.map((d) => path.resolve(root, d) + path.sep);
    dicts = loadDicts(project, mergeOverrides(readOverrides(root), options.overrides));
    banner = readBanner(project.output, root);
  }

  /** One summary per build or server start, never a translation job. */
  function report(): void {
    if (options.engine || options.glossary) {
      warn("`engine` and `glossary` in vite.config are ignored: builds no longer translate. Move them to auto-locale.config.ts (provider, glossary).");
    }
    if (dicts.usedLegacy) {
      warn(`Using translations from node_modules/.cache/react-autolocale (older version). Run \`npx react-autolocale generate\` to move them into ${project.outputRel}/.`);
    }
    const gaps = Object.entries(dicts.missing).filter(([, n]) => n > 0);
    const anyDict = Object.values(dicts.byId).some((d) => Object.keys(d).length);
    if (!anyDict && project.site.languages.length) {
      warn(`No translations in ${project.outputRel}/ yet; pages show the source text. Run \`npx react-autolocale generate\`.`);
    } else if (gaps.length) {
      warn(`Untranslated strings (shown in ${project.site.original}): ${gaps.map(([l, n]) => `${l} ${n}`).join(", ")}. Run \`npx react-autolocale sync\`.`);
    }
  }

  function virtualModule(): string {
    const { site } = project;
    const meta = site.languages.map((code) => ({
      code,
      native: getLanguage(code)?.native ?? code,
      rtl: !!getLanguage(code)?.rtl,
    }));
    const loaders = site.languages.map((code) => `${JSON.stringify(code)}: () => import(${JSON.stringify(DICT_PREFIX + code)})`);
    return [
      `export const original = ${JSON.stringify(site.original)};`,
      `export const originalNative = ${JSON.stringify(getLanguage(site.original)?.native ?? site.original)};`,
      `export const seo = ${JSON.stringify(site.seo)};`,
      `export const banner = ${JSON.stringify(banner)};`,
      `export const languages = ${JSON.stringify(meta)};`,
      `export const loaders = { ${loaders.join(", ")} };`,
    ].join("\n");
  }

  // Dev server: when catalogs, the manifest, overrides or the config change (e.g. after `react-autolocale sync`
  // in another terminal), re-read them and reload the page. Nothing is translated here.
  let timer: NodeJS.Timeout | undefined;
  function scheduleRefresh(): void {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      if (!server) return;
      try {
        await refresh();
        for (const [id, mod] of server.moduleGraph.idToModuleMap) {
          if (id.startsWith(RESOLVED_ID)) server.moduleGraph.invalidateModule(mod);
        }
        server.ws.send({ type: "full-reload" });
      } catch (err) {
        warn((err as Error).message);
      }
    }, 300);
  }

  // Dev server: new text without a translation is reported (once per batch of edits), not translated.
  const untranslated = new Set<string>();
  let warnTimer: NodeJS.Timeout | undefined;
  function noteUntranslated(strings: string[]): void {
    const { site } = project;
    for (const s of strings) {
      if (site.exclude.includes(s.trim())) continue;
      const id = messageId(s);
      if (site.languages.some((l) => !dicts.byId[l]?.[id])) untranslated.add(s);
    }
    if (!untranslated.size) return;
    clearTimeout(warnTimer);
    warnTimer = setTimeout(() => {
      const list = [...untranslated];
      warn(`${list.length} string${list.length === 1 ? " has" : "s have"} no translation yet (e.g. "${list[0]}"). Run \`npx react-autolocale sync\`; the page reloads when it finishes.`);
      untranslated.clear();
    }, 1500);
  }

  return {
    name: "react-autolocale",
    enforce: "pre",

    config() {
      // Serve the runtime as source so it can import the virtual module; SSR and Vitest must bundle it too.
      return {
        optimizeDeps: { exclude: ["react-autolocale"] },
        ssr: { noExternal: ["react-autolocale"] },
        test: { server: { deps: { inline: ["react-autolocale"] } } },
      } as Record<string, unknown>;
    },

    configResolved(resolved) {
      config = resolved;
      root = resolved.root;
    },

    configureServer(s) {
      server = s;
      s.watcher.add([path.resolve(root, OVERRIDES_FILE), path.resolve(root, ".auto-locale/manifest.json")]);
      s.watcher.on("all", (_event, changed) => {
        if (!project) return;
        const watched =
          changed === path.resolve(root, OVERRIDES_FILE) ||
          changed === project.configFile ||
          (changed.startsWith(project.output + path.sep) && changed.endsWith(".json")) ||
          changed === path.join(project.meta, "manifest.json");
        if (watched) scheduleRefresh();
      });
    },

    async buildStart() {
      if (config.build.ssr) return;
      await refresh();
      // Catalogs live outside src/ when there is no src/ folder; watch them explicitly in dev.
      if (server) server.watcher.add(project.output);
      report();
    },

    resolveId(id) {
      if (id === VIRTUAL_ID) return RESOLVED_ID;
      if (id.startsWith(DICT_PREFIX)) return "\0" + id;
      return null;
    },

    load(id) {
      if (id === RESOLVED_ID) return virtualModule();
      if (id.startsWith("\0" + DICT_PREFIX)) {
        const lang = id.slice(1 + DICT_PREFIX.length);
        return `export default ${JSON.stringify(dicts.byId[lang] ?? {})};`;
      }
      return null;
    },

    transform(code, id) {
      const file = id.split("?")[0]!;
      if (file.startsWith("\0") || file.includes("node_modules") || !isSourceFile(file)) return null;
      if (!includeDirs.some((d) => file.startsWith(d))) return null;
      const result = transformJsx(code, file);
      if (!result) return null;
      if (config.command === "serve" && project) noteUntranslated(result.strings);
      return { code: result.code, map: result.map };
    },

    closeBundle: {
      order: "post",
      async handler() {
        if (config.command !== "build" || config.build.ssr || rendered) return;
        rendered = true;
        const extra = typeof options.routes === "function" ? await options.routes() : (options.routes ?? []);
        // Routes defined in the code are found automatically; `routes` adds dynamic ones such as "/users/1".
        const routes = [...new Set([...discoverRoutes(root, project.include), ...extra])];
        await prerender({
          root,
          outDir: path.resolve(root, config.build.outDir),
          site: project.site,
          include: project.include,
          routes,
          dicts: dicts.byId,
          headDicts: dicts.byText,
          log,
        });
      },
    },
  };
}

export { reactAutolocale, ollama };
export type { Translator, TranslateFn };
