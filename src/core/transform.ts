import { parse } from "@babel/parser";
import _traverse from "@babel/traverse";
import _generate from "@babel/generator";
import * as t from "@babel/types";
import type { NodePath } from "@babel/traverse";
import { looksLikeCopy, NON_COPY_KEYS, NON_DISPLAY_ATTRS } from "./classify.js";
import type { ProjectFacts } from "./facts.js";
import { messageId } from "./ids.js";

// Babel ships CJS-style default exports in some setups; normalise both shapes.
const traverse: typeof _traverse = (_traverse as any).default ?? _traverse;
const generate: typeof _generate = (_generate as any).default ?? _generate;

/** Attributes whose string value is user-visible text. */
const TRANSLATABLE_ATTRS = new Set(["placeholder", "title", "alt", "aria-label", "aria-placeholder", "aria-description"]);
/** Elements whose text content is code, not copy. */
const SKIP_ELEMENTS = new Set(["script", "style", "code", "pre", "kbd", "samp", "svg", "textarea"]);

const T_IMPORT = "__RLT";
const TD_IMPORT = "__RLTD";
const HOOK_IMPORT = "__rlUseT";
const HOOK_VAR = "__rl";
const GLOBAL_TEXT = "__rlText";
const GLOBAL_FMT = "__rlFmt";
const RUNTIME = "react-autolocale";

export interface TransformResult {
  code: string;
  map: any;
  /** Every source string found in the file. */
  strings: string[];
  /** For each string, the element or attribute it appears in. */
  contexts: Record<string, string>;
}

/** Calls whose string arguments are code: selectors, event names, storage keys, paths, class helpers, logging, analytics. */
const NON_COPY_CALLS = new Set([
  "require", "import", "fetch", "axios", "get", "post", "put", "patch", "delete", "request", "querySelector", "querySelectorAll",
  "getElementById", "getElementsByClassName", "getElementsByTagName", "getAttribute", "setAttribute", "removeAttribute", "hasAttribute",
  "closest", "matches", "matchMedia", "addEventListener", "removeEventListener", "dispatchEvent", "emit", "on", "off", "once",
  "createElementNS", "classList", "add", "remove", "toggle", "contains", "clsx", "classnames", "classNames", "cn",
  "cx", "twMerge", "tw", "css", "styled", "keyframes", "createContext", "getItem", "setItem", "removeItem", "stringify", "parse",
  "parseInt", "parseFloat", "Number", "String", "Boolean", "Date", "URL", "URLSearchParams", "RegExp", "Symbol", "Intl", "NumberFormat",
  "DateTimeFormat", "split", "join", "replace", "replaceAll", "includes", "indexOf", "lastIndexOf", "startsWith", "endsWith", "match",
  "matchAll", "search", "test", "exec", "localeCompare", "padStart", "padEnd", "repeat", "normalize", "charAt", "log", "warn", "error",
  "info", "debug", "trace", "assert", "table", "group", "defineProperty", "hasOwnProperty", "has", "set", "oneOf", "oneOfType", "enum",
  "literal", "nativeEnum", "useQuery", "useQueries", "useInfiniteQuery", "useMutation", "invalidateQueries", "setQueryData", "getQueryData",
  "prefetchQuery", "track", "trackEvent", "logEvent", "capture", "captureMessage", "captureException", "gtag", "navigate", "redirect",
  "createSlice", "createAction", "createAsyncThunk", "registerPlugin", "lazy", "loadScript", "useRef", "useId", "useMedia",
]);
/** Variable names that hold code. */
const NON_COPY_VARS = /(?:class|style|url|href|src|path|color|font|slug|route|selector|regex|pattern|format|mime|token|secret|env|event|icon|image|img|logo|key|id)s?$/i;
const COMPARISON_OPS = new Set(["===", "!==", "==", "!=", "<", ">", "<=", ">=", "in", "instanceof"]);
const IGNORE_COMMENT = /(?:i18n|autolocale|auto-locale)[- ]ignore|translate\s*:\s*no/i;

export function parserPlugins(file: string): any[] {
  if (/\.tsx$/.test(file)) return ["typescript", "jsx"];
  if (/\.ts$/.test(file)) return ["typescript"];
  return ["jsx"];
}

/** Collapses JSX text the way React does: lines are trimmed and joined with one space. */
function cleanJsxText(raw: string): string {
  const lines = raw.split(/\r\n|\n|\r/);
  let last = 0;
  for (let i = 0; i < lines.length; i++) if (/[^ \t]/.test(lines[i]!)) last = i;
  let out = "";
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i]!.replace(/\t/g, " ");
    if (i !== 0) line = line.replace(/^[ ]+/, "");
    if (i !== lines.length - 1) line = line.replace(/[ ]+$/, "");
    if (line) {
      if (i !== last) line += " ";
      out += line;
    }
  }
  return out;
}

/** Text worth translating: must contain at least one letter in any script. */
function isTranslatable(text: string): boolean {
  return /\p{L}/u.test(text);
}

function isComponentName(name: string | undefined): boolean {
  return !!name && /^[A-Z]/.test(name);
}

/** A function that may call hooks: a component, or a custom hook named useX. */
function canCallHooks(name: string | undefined): boolean {
  return isComponentName(name) || (!!name && /^use[A-Z0-9]/.test(name));
}

function functionName(fn: NodePath<t.Function>): string | undefined {
  if ((fn.node.type === "FunctionDeclaration" || fn.node.type === "FunctionExpression") && fn.node.id) return fn.node.id.name;
  let up: NodePath | null = fn.parentPath;
  while (up && up.isCallExpression()) up = up.parentPath; // memo(...) / forwardRef(...)
  if (up?.isVariableDeclarator() && t.isIdentifier(up.node.id)) return up.node.id.name;
  return undefined;
}

/**
 * The component (or custom hook) whose body contains `path`, so a translation hook can be added to it. Callbacks
 * inside a component count; a default parameter value does not (it runs before the hook line), and neither does
 * module-level code: those use the global lookup instead.
 */
function enclosingComponent(path: NodePath): NodePath<t.Function> | null {
  let prev: NodePath = path;
  for (let p: NodePath | null = path.parentPath; p; prev = p, p = p.parentPath) {
    if (!p.isFunction()) continue;
    if (prev.listKey === "params") return null;
    if (canCallHooks(functionName(p as NodePath<t.Function>))) return p as NodePath<t.Function>;
  }
  return null;
}

function calleeName(callee: t.Node): string {
  if (t.isIdentifier(callee)) return callee.name;
  if ((t.isMemberExpression(callee) || t.isOptionalMemberExpression(callee)) && !callee.computed && t.isIdentifier(callee.property)) return callee.property.name;
  return "";
}

const HTML_DISPLAY_ATTRS = new Set([...TRANSLATABLE_ATTRS, "aria-roledescription", "aria-valuetext", "label"]);
/** data-* attributes that tooltip libraries show to people. */
const DISPLAY_DATA_ATTR = /^data-(?:[\w-]*(?:tooltip|tip|title|label|content))/;
const isDisplayAttr = (name: string, html: boolean): boolean => (html ? HTML_DISPLAY_ATTRS.has(name) : false) || DISPLAY_DATA_ATTR.test(name);

/** True where the code needs the exact value of a string: comparisons, keys, types, selectors, paths, class helpers... */
function inCodePosition(path: NodePath): boolean {
  const parent = path.parent;
  if (path.findParent((p) => p.isTSType() || p.isTSTypeAnnotation() || p.isTSInterfaceDeclaration() || p.isTSTypeAliasDeclaration() || p.isTSEnumDeclaration() || p.isTSModuleDeclaration())) return true;
  if (t.isImportDeclaration(parent) || t.isExportNamedDeclaration(parent) || t.isExportAllDeclaration(parent)) return true;
  if ((t.isObjectProperty(parent) || t.isObjectMethod(parent) || t.isClassProperty(parent) || t.isClassMethod(parent)) && path.key === "key" && !(parent as any).computed) return true;
  if (t.isMemberExpression(parent) && parent.computed && path.key === "property") return true;
  if (t.isBinaryExpression(parent) && COMPARISON_OPS.has(parent.operator)) return true;
  if (t.isSwitchCase(parent) && path.key === "test") return true;
  if (t.isTaggedTemplateExpression(parent)) return true;
  if (t.isAssignmentExpression(parent) && path.key === "right") {
    const l = parent.left;
    const nm = t.isMemberExpression(l) && !l.computed && t.isIdentifier(l.property) ? l.property.name : "";
    if (NON_COPY_KEYS.has(nm) || nm === "cookie") return true;
  }
  let prev: NodePath = path;
  for (let p: NodePath | null = path.parentPath; p; prev = p, p = p.parentPath) {
    if (p.isFunction()) break; // an inline handler's body is ordinary code: judge each string there on its own
    if (p.isJSXAttribute()) {
      const n = t.isJSXIdentifier(p.node.name) ? p.node.name.name : "";
      const opening = p.parent as t.JSXOpeningElement;
      const html = t.isJSXIdentifier(opening.name) && /^[a-z]/.test(opening.name.name);
      if (NON_DISPLAY_ATTRS.has(n) || /^on[A-Z]/.test(n)) return true;
      if (n.startsWith("data-") && !DISPLAY_DATA_ATTR.test(n)) return true;
      if (html && !isDisplayAttr(n, true)) return true;
      break;
    }
    if ((p.isCallExpression() || p.isNewExpression()) && prev.listKey === "arguments" && NON_COPY_CALLS.has(calleeName(p.node.callee))) return true;
    if (p.isThrowStatement()) return true; // developer-facing error text
    if (p.isObjectProperty() && prev.key === "value") {
      const k = p.node.key;
      const name = t.isIdentifier(k) ? k.name : t.isStringLiteral(k) ? k.value : "";
      if (NON_COPY_KEYS.has(name)) return true;
    }
    if (p.isVariableDeclarator() && prev.key === "init" && t.isIdentifier(p.node.id) && NON_COPY_VARS.test(p.node.id.name)) return true;
    if (p.isBinaryExpression() && COMPARISON_OPS.has(p.node.operator)) return true;
  }
  return false;
}

/** Hook calls whose arguments are read once or kept between renders, so a hook-based lookup would go stale. */
const DEFERRED_HOOKS = new Set(["useState", "useReducer", "useRef", "useMemo", "useCallback", "useEffect", "useLayoutEffect", "useInsertionEffect", "useImperativeHandle", "useSyncExternalStore", "useTransition", "useDeferredValue", "createContext", "createRef", "memo", "forwardRef"]);

/** Is the string inside the arguments of one of those calls (up to the component that owns it)? */
function inDeferredHookArgs(path: NodePath): boolean {
  for (let p: NodePath | null = path.parentPath; p; p = p.parentPath) {
    if (p.isCallExpression() && DEFERRED_HOOKS.has(calleeName(p.node.callee))) return true;
    if (p.isFunction() && canCallHooks(functionName(p as NodePath<t.Function>))) break;
  }
  return false;
}

/** `// i18n-ignore` (or autolocale-ignore) on the string or its statement leaves it alone. */
function hasIgnoreComment(path: NodePath): boolean {
  for (let p: NodePath | null = path; p; p = p.parentPath) {
    const n = p.node as t.Node;
    if ([...(n.leadingComments ?? []), ...(n.trailingComments ?? [])].some((c) => IGNORE_COMMENT.test(c.value))) return true;
    if (p.isStatement()) break;
  }
  return false;
}

/** The element, attribute, property or call a string belongs to, so engines can translate it with context. */
function contextOf(path: NodePath): string {
  for (let p: NodePath | null = path.parentPath; p; p = p.parentPath) {
    if (p.isJSXAttribute() && t.isJSXIdentifier(p.node.name)) return p.node.name.name;
    if (p.isObjectProperty()) {
      const k = p.node.key;
      if (t.isIdentifier(k)) return k.name;
      if (t.isStringLiteral(k)) return k.value;
    }
    if (p.isJSXElement() && t.isJSXIdentifier(p.node.openingElement.name)) return p.node.openingElement.name.name;
    if (p.isCallExpression()) {
      const n = calleeName(p.node.callee);
      if (n) return n;
    }
    if (p.isFunction()) break;
  }
  return "text";
}

/** `translate="no"` on an element (or any ancestor) keeps its text and attributes exactly as written. */
function hasNoTranslate(opening: t.JSXOpeningElement): boolean {
  return opening.attributes.some(
    (a) =>
      t.isJSXAttribute(a) &&
      t.isJSXIdentifier(a.name, { name: "translate" }) &&
      (t.isStringLiteral(a.value, { value: "no" }) ||
        (t.isJSXExpressionContainer(a.value) && t.isStringLiteral(a.value.expression, { value: "no" }))),
  );
}

function insideNoTranslate(path: NodePath): boolean {
  for (let p: NodePath | null = path; p; p = p.parentPath) {
    if (p.isJSXElement() && hasNoTranslate(p.node.openingElement)) return true;
  }
  return false;
}

/** A readable placeholder name for `name`, `user.name`, `this.props.count`; null for anything else. */
function simpleValueName(node: t.Node): string | null {
  const root = (n: t.Node): boolean =>
    t.isIdentifier(n) ||
    t.isThisExpression(n) ||
    ((t.isMemberExpression(n) || t.isOptionalMemberExpression(n)) &&
      root(n.object) &&
      (n.computed ? t.isNumericLiteral(n.property) || t.isStringLiteral(n.property) : t.isIdentifier(n.property)));
  if (!root(node)) return null;
  if (t.isIdentifier(node)) return node.name;
  if ((t.isMemberExpression(node) || t.isOptionalMemberExpression(node)) && !node.computed && t.isIdentifier(node.property)) {
    return node.property.name;
  }
  return null;
}

/** Hands out placeholder names: readable ones where possible ({name}), otherwise {1}, {2}, ... */
function namer() {
  const used = new Set<string>();
  let n = 0;
  return (expr: t.Node): string => {
    const base = simpleValueName(expr);
    if (base) {
      let name = base;
      for (let i = 2; used.has(name); i++) name = `${base}_${i}`;
      used.add(name);
      return name;
    }
    let name: string;
    do name = String(++n);
    while (used.has(name));
    used.add(name);
    return name;
  };
}

interface Template {
  text: string;
  values: { name: string; expr: t.Expression }[];
  lead: boolean;
  trail: boolean;
}

/** Does this JSX element show any text of its own (as opposed to being an icon, image or spacer)? */
function carriesText(el: t.JSXElement | t.JSXFragment): boolean {
  return el.children.some(
    (c) =>
      (t.isJSXText(c) && isTranslatable(cleanJsxText(c.value))) ||
      (t.isJSXExpressionContainer(c) && !t.isJSXEmptyExpression(c.expression) && !t.isStringLiteral(c.expression)) ||
      (t.isJSXElement(c) && carriesText(c)),
  );
}

/**
 * A sentence made of text plus variables, links, bold words or other elements becomes one message with
 * placeholders: "Read the {1} now", "Welcome, {name}". The pieces keep their own markup and are filled in at
 * runtime, so word order can change per language. Elements that only decorate (icons, images) stay out of it.
 */
function buildTemplate(node: t.JSXElement | t.JSXFragment): Template | null {
  let text = "";
  const values: Template["values"] = [];
  const name = namer();
  let hasTextRun = false;
  let hasMoving = false;
  for (const child of node.children) {
    if (t.isJSXText(child)) {
      const run = cleanJsxText(child.value);
      if (isTranslatable(run)) hasTextRun = true;
      text += run;
    } else if (t.isJSXExpressionContainer(child)) {
      const e = child.expression;
      if (t.isJSXEmptyExpression(e)) continue;
      if (t.isStringLiteral(e)) {
        text += e.value;
        continue;
      }
      const n = name(e);
      values.push({ name: n, expr: e as t.Expression });
      text += `{${n}}`;
      hasMoving = true;
    } else if (t.isJSXElement(child) || t.isJSXFragment(child)) {
      const n = name(child);
      values.push({ name: n, expr: child as unknown as t.Expression });
      text += `{${n}}`;
      if (carriesText(child)) hasMoving = true;
    } else {
      return null; // spread children
    }
  }
  const letters = text.replace(/\{\w+\}/g, "");
  if (!values.length || !hasTextRun || !hasMoving || !isTranslatable(letters)) return null;
  return { text: text.trim(), values, lead: /^\s/.test(text), trail: /\s$/.test(text) };
}

export interface TransformOptions {
  /** false: only list the strings, rewrite nothing (used by `scan`). */
  rewrite?: boolean;
  /** Project-wide facts; strings the code compares or uses as keys are never translated. */
  facts?: ProjectFacts;
}

/** Parses a file, extracts translatable strings, and rewrites the code to look them up at runtime. */
export function transformJsx(code: string, file: string, opts: TransformOptions = {}): TransformResult | null {
  const rewrite = opts.rewrite !== false;
  const codeValues = opts.facts?.codeValues ?? new Set<string>();
  if (!/["'`<]/.test(code)) return null; // no strings, no JSX

  let ast: t.File;
  try {
    ast = parse(code, { sourceType: "module", sourceFilename: file, plugins: parserPlugins(file) });
  } catch {
    return null; // not our job to report syntax errors
  }

  const strings = new Set<string>();
  /** What kind of element each string sits in ("button", "h1", "placeholder", ...), for context-aware engines. */
  const contexts: Record<string, string> = {};
  const record = (text: string, context: string) => {
    strings.add(text);
    contexts[text] ??= context;
  };
  const hookTargets = new Set<NodePath<t.Function>>();
  const generated = new WeakSet<t.Node>();
  let usedT = false;
  let usedTD = false;
  let usedGlobal = false;
  let usedGlobalFmt = false;
  const space = () => t.jsxExpressionContainer(t.stringLiteral(" "));
  /** Local names of `msg` imported from react-autolocale: msg("text") always means "translate this". */
  const msgNames = new Set<string>();
  for (const node of ast.program.body) {
    if (!t.isImportDeclaration(node) || node.source.value !== RUNTIME) continue;
    for (const sp of node.specifiers) {
      if (t.isImportSpecifier(sp) && (t.isIdentifier(sp.imported, { name: "msg" }) || t.isStringLiteral(sp.imported, { value: "msg" }))) msgNames.add(sp.local.name);
    }
  }
  const lit = (v: string) => {
    const n = t.stringLiteral(v);
    generated.add(n);
    return n;
  };

  /** `__rl(id, text)` inside a component (follows language changes), `__rlText(id, text)` anywhere else. */
  const lookup = (path: NodePath, text: string): t.CallExpression => {
    const host = inDeferredHookArgs(path) ? null : enclosingComponent(path);
    if (host) {
      hookTargets.add(host);
      return t.callExpression(t.identifier(HOOK_VAR), [lit(messageId(text)), lit(text)]);
    }
    usedGlobal = true;
    return t.callExpression(t.identifier(GLOBAL_TEXT), [lit(messageId(text)), lit(text)]);
  };
  const lookupFmt = (path: NodePath, text: string, values: Template["values"]): t.CallExpression => {
    const vars = t.objectExpression(
      values.map((v) => t.objectProperty(/^\d+$/.test(v.name) ? t.numericLiteral(Number(v.name)) : t.identifier(v.name), v.expr)),
    );
    const host = inDeferredHookArgs(path) ? null : enclosingComponent(path);
    if (host) {
      hookTargets.add(host);
      return t.callExpression(t.memberExpression(t.identifier(HOOK_VAR), t.identifier("f")), [lit(messageId(text)), lit(text), vars]);
    }
    usedGlobalFmt = true;
    return t.callExpression(t.identifier(GLOBAL_FMT), [lit(messageId(text)), lit(text), vars]);
  };

  /** Common gate for a string found in code (not JSX text, which is always text). */
  const isCopyHere = (path: NodePath, text: string): boolean =>
    looksLikeCopy(text) && !codeValues.has(text.trim()) && !inCodePosition(path) && !hasIgnoreComment(path) && !insideNoTranslate(path);

  traverse(ast, {
    // Children are rebuilt per parent: replacing a text node in place makes Babel skip its next sibling.
    "JSXElement|JSXFragment"(path) {
      const node = path.node as t.JSXElement | t.JSXFragment;
      const name = t.isJSXElement(node) && t.isJSXIdentifier(node.openingElement.name) ? node.openingElement.name.name : null;
      if (name && (SKIP_ELEMENTS.has(name) || name === T_IMPORT || name === TD_IMPORT)) return;
      if (insideNoTranslate(path)) return;
      const context = name ?? "text";

      const mixed = node.children.some(
        (c) =>
          t.isJSXElement(c) ||
          t.isJSXFragment(c) ||
          (t.isJSXExpressionContainer(c) && !t.isJSXEmptyExpression(c.expression) && !t.isStringLiteral(c.expression)),
      );
      if (mixed) {
        // "Hello {name}", "Read the <a>docs</a> now": translate the whole sentence as one template.
        const tpl = buildTemplate(node);
        if (tpl) {
          record(tpl.text, context);
          if (!rewrite) return;
          const valueObject = t.objectExpression(
            tpl.values.map((v) =>
              t.objectProperty(/^\d+$/.test(v.name) ? t.numericLiteral(Number(v.name)) : t.identifier(v.name), t.cloneNode(v.expr)),
            ),
          );
          node.children = [
            ...(tpl.lead ? [space()] : []),
            t.jsxElement(
              t.jsxOpeningElement(
                t.jsxIdentifier(TD_IMPORT),
                [
                  t.jsxAttribute(t.jsxIdentifier("i"), t.stringLiteral(messageId(tpl.text))),
                  t.jsxAttribute(t.jsxIdentifier("s"), t.stringLiteral(tpl.text)),
                  t.jsxAttribute(t.jsxIdentifier("v"), t.jsxExpressionContainer(valueObject)),
                ],
                true,
              ),
              null,
              [],
            ),
            ...(tpl.trail ? [space()] : []),
          ];
          usedTD = true;
          return;
        }
      }

      const children: t.JSXElement["children"] = [];
      let changed = false;
      for (const child of node.children) {
        const cleaned = t.isJSXText(child) ? cleanJsxText(child.value) : "";
        const text = cleaned.trim();
        if (!t.isJSXText(child) || !text || !isTranslatable(text)) {
          children.push(child);
          continue;
        }
        record(text, context);
        if (!rewrite) {
          children.push(child);
          continue;
        }
        if (/^\s/.test(cleaned)) children.push(space());
        children.push(
          t.jsxElement(
            t.jsxOpeningElement(
              t.jsxIdentifier(T_IMPORT),
              [
                t.jsxAttribute(t.jsxIdentifier("i"), t.stringLiteral(messageId(text))),
                t.jsxAttribute(t.jsxIdentifier("s"), t.stringLiteral(text)),
              ],
              true,
            ),
            null,
            [],
          ),
        );
        if (/\s$/.test(cleaned)) children.push(space());
        usedT = true;
        changed = true;
      }
      if (changed) node.children = children;
    },

    JSXAttribute(path) {
      const { name, value } = path.node;
      if (!t.isJSXIdentifier(name) || !t.isStringLiteral(value)) return;
      const opening = path.parent as t.JSXOpeningElement;
      if (!t.isJSXIdentifier(opening.name)) return;
      const tag = opening.name.name;
      if (tag === T_IMPORT || tag === TD_IMPORT) return;
      if (insideNoTranslate(path.parentPath!.parentPath!) || hasIgnoreComment(path)) return;
      const html = /^[a-z]/.test(tag);
      const text = value.value.trim();
      if (!text || !isTranslatable(text)) return;
      const attr = (n: string) => opening.attributes.find((a): a is t.JSXAttribute => t.isJSXAttribute(a) && t.isJSXIdentifier(a.name, { name: n }));
      const literalOf = (a: t.JSXAttribute | undefined) => (a && t.isStringLiteral(a.value) ? a.value.value : undefined);

      let translate = false;
      if (html) {
        translate = isDisplayAttr(name.name, true);
        // <input type="submit" value="Send">  and  <meta name="description" content="...">
        if (name.name === "value" && tag === "input" && ["submit", "button", "reset"].includes(literalOf(attr("type")) ?? "")) translate = true;
        if (name.name === "content" && tag === "meta") {
          const who = literalOf(attr("name")) ?? literalOf(attr("property")) ?? "";
          translate = ["description", "og:title", "og:description", "twitter:title", "twitter:description"].includes(who);
        }
      } else if (
        !NON_DISPLAY_ATTRS.has(name.name) &&
        !/^on[A-Z]/.test(name.name) &&
        !(name.name.startsWith("data-") && !DISPLAY_DATA_ATTR.test(name.name))
      ) {
        // A prop on one of your components (<Hero title="Welcome" />): text if it reads like text.
        translate = looksLikeCopy(text) && !codeValues.has(text);
      }
      if (!translate) return;
      record(text, name.name);
      if (!rewrite) return;
      path.node.value = t.jsxExpressionContainer(lookup(path, text));
    },

    // msg("Text") and msg("Hello {name}", { name }): the explicit marker, for anything the automatic rules can't see
    CallExpression(path) {
      const callee = path.node.callee;
      if (!t.isIdentifier(callee) || !msgNames.has(callee.name)) return;
      const [arg, vars] = path.node.arguments;
      let text: string | null = null;
      let values: Template["values"] = [];
      let object: t.ObjectExpression | null = t.isObjectExpression(vars) ? vars : null;
      if (t.isStringLiteral(arg)) text = arg.value;
      else if (t.isTemplateLiteral(arg)) {
        const name = namer();
        text = arg.quasis[0]!.value.cooked ?? "";
        arg.expressions.forEach((e, i) => {
          const n = name(e);
          values.push({ name: n, expr: e as t.Expression });
          text += `{${n}}` + (arg.quasis[i + 1]!.value.cooked ?? "");
        });
      }
      if (text === null || !/\S/.test(text)) return;
      generated.add(arg as t.Node);
      record(text, "msg");
      if (!rewrite) return;
      const vs = object
        ? object.properties.flatMap((p) => (t.isObjectProperty(p) && !p.computed && (t.isIdentifier(p.key) || t.isStringLiteral(p.key)) ? [{ name: t.isIdentifier(p.key) ? p.key.name : p.key.value, expr: p.value as t.Expression }] : []))
        : values;
      path.replaceWith(vs.length ? lookupFmt(path, text, vs) : lookup(path, text));
    },

    StringLiteral(path) {
      if (generated.has(path.node) || t.isJSXAttribute(path.parent)) return;
      const text = path.node.value;
      if (text !== text.trim() || !isCopyHere(path, text)) return; // padded strings are pieces of a concatenation
      record(text, contextOf(path));
      if (rewrite) path.replaceWith(lookup(path, text));
    },

    TemplateLiteral(path) {
      if (generated.has(path.node)) return;
      const { quasis, expressions } = path.node;
      const name = namer();
      let text = quasis[0]!.value.cooked ?? "";
      const values: Template["values"] = [];
      expressions.forEach((e, i) => {
        if (t.isJSXElement(e) || t.isJSXFragment(e) || t.isTSType(e as t.Node)) return;
        const n = name(e);
        values.push({ name: n, expr: e as t.Expression });
        text += `{${n}}` + (quasis[i + 1]!.value.cooked ?? "");
      });
      if (values.length !== expressions.length) return;
      if (text !== text.trim() || !isCopyHere(path, text.replace(/\{\w+\}/g, "0"))) return;
      record(text, contextOf(path));
      if (rewrite) path.replaceWith(values.length ? lookupFmt(path, text, values) : lookup(path, text));
    },

    // "Hello, " + name + "!"   ->   one message "Hello, {name}!"
    BinaryExpression(path) {
      if (path.node.operator !== "+" || generated.has(path.node)) return;
      if (t.isBinaryExpression(path.parent, { operator: "+" })) return; // handle the whole chain from its top
      const leaves: t.Node[] = [];
      const flatten = (n: t.Node): void => {
        if (t.isBinaryExpression(n, { operator: "+" })) {
          flatten(n.left);
          flatten(n.right);
        } else leaves.push(n);
      };
      flatten(path.node);
      const isText = (n: t.Node) => t.isStringLiteral(n) || (t.isTemplateLiteral(n) && n.expressions.length === 0);
      const firstText = leaves.findIndex(isText);
      if (firstText < 0 || firstText > 1) return; // `a + b + "x"` adds numbers first: leave it alone
      if (leaves.some((n) => t.isJSXElement(n) || t.isJSXFragment(n))) return;
      const name = namer();
      let text = "";
      const values: Template["values"] = [];
      for (const leaf of leaves) {
        if (t.isStringLiteral(leaf)) text += leaf.value;
        else if (t.isTemplateLiteral(leaf) && leaf.expressions.length === 0) text += leaf.quasis[0]!.value.cooked ?? "";
        else {
          const n = name(leaf);
          values.push({ name: n, expr: leaf as t.Expression });
          text += `{${n}}`;
        }
      }
      if (text !== text.trim() || !isCopyHere(path, text.replace(/\{\w+\}/g, "0"))) return;
      record(text, contextOf(path));
      leaves.forEach((l) => generated.add(l)); // the pieces belong to this message; don't list them again
      if (rewrite) path.replaceWith(values.length ? lookupFmt(path, text, values) : lookup(path, text));
    },
  });

  if (strings.size === 0) return null;
  if (!rewrite) return { code, map: null, strings: [...strings], contexts };

  // Add `const __rl = __rlUseT();` at the top of each component that translates attributes or strings.
  for (const fn of hookTargets) {
    if (!t.isBlockStatement(fn.node.body)) {
      fn.node.body = t.blockStatement([t.returnStatement(fn.node.body as t.Expression)]);
    }
    (fn.node.body as t.BlockStatement).body.unshift(
      t.variableDeclaration("const", [
        t.variableDeclarator(t.identifier(HOOK_VAR), t.callExpression(t.identifier(HOOK_IMPORT), [])),
      ]),
    );
  }

  const specifiers: t.ImportSpecifier[] = [];
  if (usedT) specifiers.push(t.importSpecifier(t.identifier(T_IMPORT), t.identifier("__T")));
  if (usedTD) specifiers.push(t.importSpecifier(t.identifier(TD_IMPORT), t.identifier("__TD")));
  if (hookTargets.size) specifiers.push(t.importSpecifier(t.identifier(HOOK_IMPORT), t.identifier("__useT")));
  if (usedGlobal) specifiers.push(t.importSpecifier(t.identifier(GLOBAL_TEXT), t.identifier("__rlText")));
  if (usedGlobalFmt) specifiers.push(t.importSpecifier(t.identifier(GLOBAL_FMT), t.identifier("__rlFmt")));
  ast.program.body.unshift(t.importDeclaration(specifiers, t.stringLiteral(RUNTIME)));

  const out = generate(ast, { sourceMaps: true, sourceFileName: file }, code);
  return { code: out.code, map: out.map, strings: [...strings], contexts };
}

/** Strings (and where they appear), without rewriting. */
export function extractItems(code: string, file: string, facts?: ProjectFacts): { strings: string[]; contexts: Record<string, string> } {
  const r = transformJsx(code, file, { rewrite: false, facts });
  return { strings: r?.strings ?? [], contexts: r?.contexts ?? {} };
}

export function extractStrings(code: string, file: string): string[] {
  return extractItems(code, file).strings;
}
