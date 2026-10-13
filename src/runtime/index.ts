import {
  createContext,
  createElement,
  Fragment,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type CSSProperties,
  type ReactElement,
  type ReactNode,
} from "react";
import { redirectTarget, STORAGE_KEY } from "../core/redirect.js";
import { BANNER_EN, DISMISSED_KEY, suggestLanguage } from "../core/suggestion.js";
import { original, originalNative, seo, banner, languages, loaders } from "virtual:react-autolocale";

type Dict = Record<string, string>;

declare global {
  interface Window {
    /** Written into every generated page so the first render already has its translations. */
    __AUTOSCALE__?: { lang: string; dict: Dict };
  }
}

const hasDom = typeof window !== "undefined" && typeof document !== "undefined";
const codes = new Set([original, ...languages.map((l) => l.code)]);
const cache = new Map<string, Dict>();
const PREFIX = /^\/([a-z]{2,3})(?=\/|$)/i;

function prefixOf(pathname: string): string | null {
  const code = PREFIX.exec(pathname)?.[1]?.toLowerCase();
  return code && codes.has(code) ? code : null;
}

function pathFor(code: string): string {
  const { pathname, search, hash } = window.location;
  const rest = prefixOf(pathname) ? pathname.replace(PREFIX, "") || "/" : pathname;
  return `/${code}${rest}${search}${hash}`;
}

function load(code: string): Promise<Dict> {
  const hit = cache.get(code);
  if (hit) return Promise.resolve(hit);
  const loader = loaders[code];
  if (!loader) return Promise.resolve({});
  return loader()
    .then((m) => m.default)
    .catch(() => ({}))
    .then((dict) => (cache.set(code, dict), dict));
}

interface State {
  language: string;
  dict: Dict;
}

interface Ctx extends State {
  setLanguage: (code: string) => Promise<void>;
}

const Context = createContext<Ctx>({ language: original, dict: {}, setLanguage: async () => {} });

function initialState(): State {
  if (!hasDom) return { language: original, dict: {} };
  const boot = window.__AUTOSCALE__;
  if (boot) cache.set(boot.lang, boot.dict);
  const { pathname, search, hash } = window.location;
  const fromUrl = prefixOf(pathname);
  if (fromUrl === null) {
    // An un-prefixed URL such as "/": send the visitor to their language, or settle on the original language's
    // prefixed URL so a router with basename "/en" can match. The URL is the source of truth for the language.
    let saved: string | null = null;
    try {
      saved = window.localStorage.getItem(STORAGE_KEY);
    } catch {
      /* storage unavailable */
    }
    const to = redirectTarget({
      pathname,
      search,
      hash,
      saved,
      browser: window.navigator.languages?.length ? window.navigator.languages : [window.navigator.language],
      codes: [...codes],
      original,
    });
    if (to) window.location.replace(to);
    else window.history.replaceState(window.history.state, "", `/${original}${pathname}${search}${hash}`);
  }
  const language = fromUrl ?? original;
  return { language, dict: language === original ? {} : (cache.get(language) ?? {}) };
}

export interface AutoScaleProps {
  /** Language the app is written in, e.g. "en". Must be a literal so the build can read it. */
  original: string;
  /** Languages to generate, e.g. ["fr", "es"]. Must be a literal. */
  languages: string[];
  /** Phrases that must never be translated, such as brand names. Must be a literal. */
  exclude?: string[];
  /**
   * Opt in to SEO changes at build time: translated title/meta tags, canonical and hreflang links,
   * and a sitemap. Off by default: nothing in <head> is touched. Must be a literal.
   */
  seo?: boolean | "true";
  /** Public site URL (e.g. "https://example.com"); used by `seo` for absolute links and the sitemap. */
  siteUrl?: string;
  children?: ReactNode;
}

/**
 * Wrap your app once. Language comes from the URL (/fr/...), so every language is a real, static page.
 * The props are read at build time by the Vite plugin.
 */
export function AutoScale({ children }: AutoScaleProps): ReactElement {
  const [state, setState] = useState<State>(initialState);

  const apply = useCallback(async (code: string, push: boolean) => {
    if (!codes.has(code)) return;
    if (push && hasDom) {
      try {
        window.localStorage.setItem(STORAGE_KEY, code);
      } catch {
        /* storage unavailable */
      }
      // With seo on, every language is a real page with its own head tags, so navigate to it.
      if (seo) {
        window.location.assign(pathFor(code));
        return;
      }
    }
    const dict = code === original ? {} : await load(code);
    setState({ language: code, dict });
    if (push && hasDom) window.history.pushState(null, "", pathFor(code));
  }, []);

  const setLanguage = useCallback((code: string) => apply(code, true), [apply]);

  useEffect(() => {
    document.documentElement.lang = state.language;
    document.documentElement.dir = languages.find((l) => l.code === state.language)?.rtl ? "rtl" : "ltr";
  }, [state.language]);

  // Dev server has no pre-rendered dictionary: fetch it on first load.
  useEffect(() => {
    if (state.language !== original && !cache.has(state.language)) void apply(state.language, false);
    const onPop = () => void apply(prefixOf(window.location.pathname) ?? original, false);
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [apply]);

  const value = useMemo(() => ({ ...state, setLanguage }), [state, setLanguage]);
  return createElement(Context.Provider, { value }, children);
}

/** @internal Inserted by the Vite plugin in place of static JSX text: message id and source text (the fallback). */
export function __T({ i, s }: { i: string; s: string }): ReactElement {
  const { dict } = useContext(Context);
  return createElement(Fragment, null, dict[i] || s);
}

/** @internal Inserted by the Vite plugin for translated attributes (placeholder, alt, ...). */
export function __useT(): (i: string, s: string) => string {
  const { dict } = useContext(Context);
  return useCallback((i: string, s: string) => dict[i] || s, [dict]);
}

/** @internal Inserted by the Vite plugin for text with variables, e.g. `Hello {name}`. */
export function __TD({ i, s, v }: { i: string; s: string; v: Record<string, unknown> }): ReactElement {
  const { dict } = useContext(Context);
  const template = dict[i] || s;
  // Odd entries are variable names; anything React can render (strings, numbers, elements) is allowed.
  const parts = template.split(/\{(\w+)\}/g).map((part, i) => (i % 2 ? (v[part] as ReactNode) : part));
  return createElement(Fragment, null, ...parts.map((p, i) => createElement(Fragment, { key: i }, p)));
}

/**
 * Pick a value by language: `useLocalized({ en: "/pricing", fr: "/tarifs", default: "/pricing" })`.
 * Falls back to `default`, then to the original language's value.
 */
export function useLocalized<T>(values: Record<string, T | undefined> & { default?: T }): T {
  const { language } = useContext(Context);
  return (values[language] ?? values.default ?? values[original]) as T;
}

/** Component form of `useLocalized`: `<Localized en={<A />} fr={<B />} default={<A />} />`. */
export function Localized(props: Record<string, ReactNode>): ReactElement {
  return createElement(Fragment, null, useLocalized<ReactNode>(props));
}

export interface ForLanguagesProps {
  /** Show only for these languages. */
  only?: string[];
  /** Show for every language except these. */
  except?: string[];
  children?: ReactNode;
}

/** Content that appears for some languages only, such as a local offer or legal notice. */
export function ForLanguages({ only, except, children }: ForLanguagesProps): ReactElement | null {
  const { language } = useContext(Context);
  if (only && !only.includes(language)) return null;
  if (except?.includes(language)) return null;
  return createElement(Fragment, null, children);
}

export interface Format {
  language: string;
  number: (value: number, options?: Intl.NumberFormatOptions) => string;
  currency: (value: number, currency: string, options?: Intl.NumberFormatOptions) => string;
  percent: (value: number, options?: Intl.NumberFormatOptions) => string;
  date: (value: Date | number | string, options?: Intl.DateTimeFormatOptions) => string;
}

/** Numbers, prices and dates formatted for the current language: `format.currency(19.99, "EUR")`. */
export function useFormat(): Format {
  const { language } = useContext(Context);
  return useMemo(
    () => ({
      language,
      number: (value, options) => new Intl.NumberFormat(language, options).format(value),
      currency: (value, currency, options) => new Intl.NumberFormat(language, { style: "currency", currency, ...options }).format(value),
      percent: (value, options) => new Intl.NumberFormat(language, { style: "percent", ...options }).format(value),
      date: (value, options) => new Intl.DateTimeFormat(language, options ?? { dateStyle: "medium" }).format(new Date(value)),
    }),
    [language],
  );
}

export interface LanguageSuggestion {
  /** Code of the suggested language, e.g. "fr". */
  language: string;
  /** The suggested language's own name, e.g. "Français". */
  native: string;
  /** Full sentence in the visitor's language, e.g. "This page is also available in Français. Switch?" */
  text: string;
  switchLabel: string;
  dismissLabel: string;
  /** Go to this page in the suggested language. */
  accept: () => void;
  /** Hide the suggestion and don't offer this language again. */
  dismiss: () => void;
}

function readDismissed(): string[] {
  try {
    const v = JSON.parse(window.localStorage.getItem(DISMISSED_KEY) ?? "[]");
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

/**
 * For building your own banner. Returns null when there is nothing to suggest: the visitor's browser language
 * is the page's language, is not supported, was dismissed, or they already picked a language.
 */
export function useLanguageSuggestion(): LanguageSuggestion | null {
  const { language, setLanguage } = useContext(Context);
  const [code, setCode] = useState<string | null>(null);

  useEffect(() => {
    let chosen = false;
    try {
      chosen = window.localStorage.getItem(STORAGE_KEY) !== null;
    } catch {
      /* storage unavailable */
    }
    setCode(
      suggestLanguage({
        browser: window.navigator.languages?.length ? window.navigator.languages : [window.navigator.language],
        codes: [...codes],
        current: language,
        dismissed: readDismissed(),
        chosen,
      }),
    );
  }, [language]);

  if (!code) return null;
  const text = banner[code] ?? BANNER_EN;
  const native = code === original ? originalNative : (languages.find((l) => l.code === code)?.native ?? code);
  return {
    language: code,
    native,
    text: text.prompt.split("{language}").join(native),
    switchLabel: text.switch.split("{language}").join(native),
    dismissLabel: text.dismiss.split("{language}").join(native),
    accept: () => void setLanguage(code),
    dismiss: () => {
      try {
        window.localStorage.setItem(DISMISSED_KEY, JSON.stringify([...readDismissed(), code]));
      } catch {
        /* storage unavailable */
      }
      setCode(null);
    },
  };
}

export interface LanguageBannerProps {
  className?: string;
  style?: CSSProperties;
  /** Replace the markup entirely: `{(s) => <MyBar>{s.text}</MyBar>}`. */
  children?: (suggestion: LanguageSuggestion) => ReactNode;
}

const BAR: CSSProperties = {
  position: "fixed",
  left: 0,
  right: 0,
  bottom: 0,
  display: "flex",
  gap: 12,
  alignItems: "center",
  justifyContent: "center",
  padding: "10px 16px",
  background: "#111",
  color: "#fff",
  font: "14px system-ui, sans-serif",
  zIndex: 2147483000,
};

/** A ready-made suggestion bar. Style it with `className`/`style`, or pass a render function to build your own. */
export function LanguageBanner({ className, style, children }: LanguageBannerProps): ReactElement | null {
  const s = useLanguageSuggestion();
  if (!s) return null;
  if (children) return createElement(Fragment, null, children(s));
  return createElement(
    "div",
    { role: "region", "aria-label": s.native, className, style: className ? style : { ...BAR, ...style } },
    createElement("span", null, s.text),
    createElement("button", { type: "button", onClick: s.accept, lang: s.language }, s.switchLabel),
    createElement("button", { type: "button", onClick: s.dismiss }, s.dismissLabel),
  );
}

export interface LanguageApi {
  language: string;
  /** Switches language and updates the URL; resolves once translations are loaded. */
  setLanguage: (code: string) => Promise<void>;
  /** All languages, original first. */
  languages: { code: string; native: string }[];
  /** "/fr" - pass to your router's basename if you use client-side routing. */
  basePath: string;
}

export function useLanguage(): LanguageApi {
  const { language, setLanguage } = useContext(Context);
  return useMemo(
    () => ({
      language,
      setLanguage,
      languages: [{ code: original, native: originalNative }, ...languages],
      basePath: `/${language}`,
    }),
    [language, setLanguage],
  );
}

export interface LanguageSwitcherProps {
  className?: string;
  style?: CSSProperties;
  /** Accessible label for the dropdown. */
  label?: string;
}

/** A dropdown that switches the whole app's language instantly, without a reload. */
export function LanguageSwitcher({ className, style, label = "Language" }: LanguageSwitcherProps): ReactElement {
  const { language, languages: all, setLanguage } = useLanguage();
  return createElement(
    "select",
    {
      className,
      style,
      value: language,
      "aria-label": label,
      onChange: (e: { target: { value: string } }) => void setLanguage(e.target.value),
    },
    all.map((l) => createElement("option", { key: l.code, value: l.code }, l.native)),
  );
}
