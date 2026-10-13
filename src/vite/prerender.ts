import fs from "node:fs";
import path from "node:path";
import { JSDOM, VirtualConsole } from "jsdom";
import { createServer } from "vite";
import { getLanguage } from "../core/languages.js";
import type { Dict } from "../core/cache.js";
import type { SiteConfig } from "../core/site.js";
import { redirectScript } from "../core/redirect.js";
import { applySeo, type RenderedPage } from "./seo.js";
import { isSourceFile, walk } from "../core/scan.js";

export interface PrerenderOptions {
  root: string;
  outDir: string;
  site: SiteConfig;
  /** Source folders (relative to root); their files are pre-compiled so lazy routes resolve quickly. */
  include: string[];
  /** Extra paths to build even though no page links to them, e.g. ["/thank-you"]. */
  routes?: string[];
  /** Message id -> translation per language, embedded in each page for the runtime. */
  dicts: Record<string, Dict>;
  /** Source text -> translation per language, for the <head> title and meta tags. Defaults to `dicts`. */
  headDicts?: Record<string, Dict>;
  log: (msg: string) => void;
}

const MAX_PAGES = 500;

/** Normalizes an internal link like "/fr/about?x=1#y" to "/fr/about/", or returns [] for anything else. */
export function pageLink(href: string, lang: string): string[] {
  let url: URL;
  try {
    url = new URL(href, `http://localhost/${lang}/`);
  } catch {
    return [];
  }
  if (url.origin !== "http://localhost") return [];
  const p = url.pathname.replace(/\/+$/, "");
  if (p !== `/${lang}` && !p.startsWith(`/${lang}/`)) return [];
  if (/\.[a-z0-9]+$/i.test(p)) return []; // files such as .pdf or .png, not pages
  return [p + "/"];
}

/** Normalizes a user-supplied route like "thank-you" or "/users/1" to "/thank-you/"; null if unusable. */
export function routePath(route: string): string | null {
  const p = route.trim().split(/[?#]/)[0]!.replace(/^\/+|\/+$/g, "");
  if (/^[a-z]{2,3}$/i.test(p) || /\.[a-z0-9]+$/i.test(p)) return p ? null : "/";
  return p ? `/${p}/` : "/";
}

/** The module script in the project's index.html, e.g. "/src/main.tsx". */
function findEntry(root: string): string {
  const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
  for (const tag of html.match(/<script\b[^>]*>/gi) ?? []) {
    if (/type=["']module["']/i.test(tag)) {
      const src = /src=["']([^"']+)["']/i.exec(tag)?.[1];
      if (src) return src;
    }
  }
  throw new Error("Could not find <script type=\"module\" src=...> in index.html.");
}

/** Makes the jsdom window the global scope, so browser-only code in the app can run in Node. Returns an undo function. */
function installDom(dom: JSDOM): () => void {
  const win = dom.window as unknown as Record<string, unknown>;
  const keys = new Set(["window", "document", "navigator", "localStorage", "sessionStorage", "location", "history"]);
  for (const k of Object.getOwnPropertyNames(win)) if (!(k in globalThis)) keys.add(k);
  const saved = new Map<string, PropertyDescriptor | undefined>();
  for (const k of keys) {
    saved.set(k, Object.getOwnPropertyDescriptor(globalThis, k));
    try {
      Object.defineProperty(globalThis, k, { configurable: true, get: () => win[k] });
    } catch {
      /* non-configurable global, leave it */
    }
  }
  return () => {
    for (const [k, d] of saved) {
      if (d) Object.defineProperty(globalThis, k, d);
      else delete (globalThis as any)[k];
    }
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Waits until the page has content and has stopped changing (so lazy routes and Suspense have resolved). */
async function waitForRender(dom: JSDOM): Promise<void> {
  const doc = dom.window.document;
  const root = doc.getElementById("root");
  const deadline = Date.now() + 10_000;
  let last = "";
  let changedAt = Date.now();
  while (Date.now() < deadline) {
    const now = (root ?? doc.body).innerHTML;
    if (now !== last) (last = now, (changedAt = Date.now()));
    else if (now && Date.now() - changedAt >= 400) return;
    await sleep(25);
  }
}

/** Browser APIs apps commonly call during render that jsdom does not implement. */
function polyfill(win: any): void {
  class Noop {
    observe() {}
    unobserve() {}
    disconnect() {}
    takeRecords() {
      return [];
    }
  }
  win.matchMedia ??= (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener() {},
    removeListener() {},
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent: () => false,
  });
  win.ResizeObserver ??= Noop;
  win.IntersectionObserver ??= Noop;
  win.scrollTo ??= () => {};
  win.Element.prototype.scrollIntoView ??= () => {};
}

/**
 * Renders the app once per language in a DOM and writes static pages: dist/<lang>/index.html
 * (and dist/index.html for the original language). Only #root's content and one inline state script
 * are added; everything else in the page is left as built.
 */
export async function prerender(opts: PrerenderOptions): Promise<void> {
  const { root, outDir, site, include, dicts, log } = opts;
  const extraRoutes = (opts.routes ?? []).map(routePath).filter((r): r is string => r !== null);
  const sourceUrls = include
    .flatMap((dir) => [...walk(path.resolve(root, dir))])
    .filter(isSourceFile)
    .map((f) => "/" + path.relative(root, f).split(path.sep).join("/"));
  const template = fs.readFileSync(path.join(outDir, "index.html"), "utf8");
  const entry = findEntry(root);

  const server = await createServer({
    root,
    appType: "custom",
    logLevel: "silent",
    server: { middlewareMode: true, hmr: false, watch: null },
  });

  const failures: { pathname: string; error: string }[] = [];
  const pages: RenderedPage[] = [];

  // Vite 6+: a module runner can drop evaluated modules (fresh state per page) while keeping compiled code.
  // Older Vite: fall back to ssrLoadModule + invalidateAll.
  const ssrEnv = (server as any).environments?.ssr;
  const runner = ssrEnv?.runner;
  const loadModule = (url: string): Promise<unknown> => (runner ? runner.import(url) : server.ssrLoadModule(url));
  const resetModules = (): void => (runner ? runner.clearCache() : server.moduleGraph.invalidateAll());
  // Compile every source file once up front so lazy routes resolve quickly.
  await Promise.all(
    sourceUrls.map((u) => (ssrEnv?.transformRequest ? ssrEnv.transformRequest(u) : server.transformRequest(u, { ssr: true })).catch(() => null)),
  );

  /** Renders one URL and returns the same-language page links found in it. */
  async function renderPage(lang: string, pathname: string): Promise<string[]> {
    const dict = lang === site.original ? {} : (dicts[lang] ?? {});
    const errors: string[] = [];
    const virtualConsole = new VirtualConsole();
    virtualConsole.on("jsdomError", (e: Error) => errors.push(String(e.message).split("\n")[0]!));
    const dom = new JSDOM(template, { url: `http://localhost${pathname}`, pretendToBeVisual: true, virtualConsole });
    const win = dom.window as any;
    win.__AUTOSCALE__ = { lang, dict };
    // React reports uncaught render errors as window "error" events.
    win.addEventListener("error", (e: any) => errors.push(String(e.error?.message ?? e.message ?? e)));
    polyfill(win);
    const restore = installDom(dom);
    try {
      resetModules();
      await loadModule(entry);
      await waitForRender(dom);
    } catch (err) {
      errors.push((err as Error).message);
    } finally {
      restore();
    }

    const rootEl = dom.window.document.getElementById("root");
    if (errors.length || (rootEl && !rootEl.childElementCount)) {
      failures.push({ pathname, error: errors[0] ?? "the page rendered nothing" });
      dom.window.close();
      return [];
    }

    const doc = dom.window.document;
    doc.documentElement.lang = lang;
    doc.documentElement.dir = getLanguage(lang)?.rtl ? "rtl" : "ltr";
    const state = doc.createElement("script");
    state.textContent = `window.__AUTOSCALE__=${JSON.stringify({ lang, dict }).replace(/</g, "\\u003c")}`;
    doc.head.prepend(state);

    const links = [...doc.querySelectorAll("a[href]")].flatMap((a) => pageLink(a.getAttribute("href")!, lang));
    const html = dom.serialize();
    const dir = path.join(outDir, ...pathname.split("/").filter(Boolean));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "index.html"), html);
    pages.push({ lang, pathname, file: path.join(dir, "index.html") });
    if (pathname === `/${site.original}/`) {
      // The root page is the original language plus a redirect for visitors whose browser prefers another language.
      const rootDoc = new JSDOM(html).window.document;
      const redirect = rootDoc.createElement("script");
      redirect.textContent = redirectScript([site.original, ...site.languages], site.original);
      rootDoc.head.prepend(redirect);
      const rootFile = path.join(outDir, "index.html");
      fs.writeFileSync(rootFile, "<!DOCTYPE html>" + rootDoc.documentElement.outerHTML);
      pages.push({ lang, pathname, file: rootFile });
    }
    log(`[react-autolocale] wrote ${pathname}`);
    dom.window.close();
    return links;
  }

  try {
    for (const lang of [site.original, ...site.languages]) {
      // Follow links from the language's home page so every route becomes a static page.
      const queue = [`/${lang}/`, ...extraRoutes.map((r) => `/${lang}${r}`)];
      const seen = new Set(queue);
      if (seen.size < queue.length) queue.splice(0, queue.length, ...seen);
      for (let i = 0; i < queue.length; i++) {
        for (const next of await renderPage(lang, queue[i]!)) {
          if (!seen.has(next) && seen.size < MAX_PAGES) (seen.add(next), queue.push(next));
        }
      }
    }
    if (failures.length) {
      throw new Error(
        `${failures.length} page(s) failed to prerender:\n` +
          failures.map((f) => `  ${f.pathname}  ${f.error}`).join("\n"),
      );
    }
    if (site.seo) applySeo({ outDir, site, dicts: opts.headDicts ?? dicts, pages, log });
  } finally {
    await server.close();
  }
}
