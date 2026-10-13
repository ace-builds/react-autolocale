import { parse } from "@babel/parser";
import _traverse from "@babel/traverse";
import _generate from "@babel/generator";
import * as t from "@babel/types";
import type { NodePath } from "@babel/traverse";
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
const RUNTIME = "react-autolocale";

export interface TransformResult {
  code: string;
  map: any;
  /** Every source string found in the file. */
  strings: string[];
  /** For each string, the element or attribute it appears in. */
  contexts: Record<string, string>;
}

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

/** Finds the function that is a React component (PascalCase name, possibly wrapped in memo/forwardRef). */
function enclosingComponent(path: NodePath): NodePath<t.Function> | null {
  let p: NodePath | null = path.parentPath;
  while (p) {
    if (p.isFunction()) {
      const fn = p as NodePath<t.Function>;
      let name: string | undefined;
      if ((fn.node.type === "FunctionDeclaration" || fn.node.type === "FunctionExpression") && fn.node.id) {
        name = fn.node.id.name;
      }
      if (!name) {
        let up: NodePath | null = fn.parentPath;
        // unwrap memo(...) / forwardRef(...)
        while (up && up.isCallExpression()) up = up.parentPath;
        if (up?.isVariableDeclarator() && t.isIdentifier(up.node.id)) name = up.node.id.name;
      }
      if (isComponentName(name)) return fn;
    }
    p = p.parentPath;
  }
  return null;
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

/** A value we can safely hand to the runtime: `name`, `user.name`, `this.props.count`, `items?.[0]`. */
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
  return "value";
}

interface Template {
  text: string;
  values: { name: string; expr: t.Expression }[];
  lead: boolean;
  trail: boolean;
}

/**
 * "Hello {name}!" -> template "Hello {name}!" plus the values to fill in at runtime.
 * Only text mixed with plain variables qualifies: no nested elements, calls, conditions or JSX.
 */
function buildTemplate(node: t.JSXElement | t.JSXFragment): Template | null {
  let text = "";
  const values: Template["values"] = [];
  const used = new Set<string>();
  for (const child of node.children) {
    if (t.isJSXText(child)) {
      text += cleanJsxText(child.value);
    } else if (t.isJSXExpressionContainer(child)) {
      const e = child.expression;
      if (t.isJSXEmptyExpression(e)) continue;
      if (t.isStringLiteral(e)) {
        text += e.value;
        continue;
      }
      const base = simpleValueName(e);
      if (!base) return null;
      let name = base;
      for (let i = 2; used.has(name); i++) name = `${base}_${i}`;
      used.add(name);
      values.push({ name, expr: e as t.Expression });
      text += `{${name}}`;
    } else {
      return null; // nested JSX element, spread child, ...
    }
  }
  const letters = text.replace(/\{\w+\}/g, "");
  if (!values.length || !isTranslatable(letters)) return null;
  return { text: text.trim(), values, lead: /^\s/.test(text), trail: /\s$/.test(text) };
}

/** Parses a file, extracts translatable strings, and rewrites JSX to render translations. */
export function transformJsx(code: string, file: string, opts: { rewrite?: boolean } = {}): TransformResult | null {
  const rewrite = opts.rewrite !== false;
  if (!code.includes("<")) return null;

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
  let usedT = false;
  let usedTD = false;
  const space = () => t.jsxExpressionContainer(t.stringLiteral(" "));

  traverse(ast, {
    // Children are rebuilt per parent: replacing a text node in place makes Babel skip its next sibling.
    "JSXElement|JSXFragment"(path) {
      const node = path.node as t.JSXElement | t.JSXFragment;
      const name = t.isJSXElement(node) && t.isJSXIdentifier(node.openingElement.name) ? node.openingElement.name.name : null;
      if (name && SKIP_ELEMENTS.has(name)) return;
      if (insideNoTranslate(path)) return;
      const context = name ?? "text";

      const dynamic = node.children.some(
        (c) => t.isJSXExpressionContainer(c) && !t.isJSXEmptyExpression(c.expression) && !t.isStringLiteral(c.expression),
      );
      if (dynamic) {
        // "Hello {name}": translate the whole sentence as one template.
        const tpl = buildTemplate(node);
        if (!tpl) return; // anything more complex stays as written
        record(tpl.text, context);
        if (!rewrite) return;
        const valueObject = t.objectExpression(
          tpl.values.map((v) => t.objectProperty(t.identifier(v.name), t.cloneNode(v.expr))),
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
      if (!t.isJSXIdentifier(name) || !TRANSLATABLE_ATTRS.has(name.name)) return;
      if (!t.isStringLiteral(value)) return;
      // Only plain HTML elements: a component's `title` prop may not be display text.
      const opening = path.parent as t.JSXOpeningElement;
      if (!t.isJSXIdentifier(opening.name) || !/^[a-z]/.test(opening.name.name)) return;
      if (insideNoTranslate(path.parentPath!.parentPath!)) return;
      const text = value.value.trim();
      if (!text || !isTranslatable(text)) return;
      const component = enclosingComponent(path);
      if (!component) return; // no safe place for a hook
      record(text, name.name);
      if (!rewrite) return;

      path.node.value = t.jsxExpressionContainer(
        t.callExpression(t.identifier(HOOK_VAR), [t.stringLiteral(messageId(text)), t.stringLiteral(text)]),
      );
      hookTargets.add(component);
    },
  });

  if (strings.size === 0) return null;
  if (!rewrite) return { code, map: null, strings: [...strings], contexts };

  // Add `const __rl = __rlUseT();` at the top of each component that translates attributes.
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
  ast.program.body.unshift(t.importDeclaration(specifiers, t.stringLiteral(RUNTIME)));

  const out = generate(ast, { sourceMaps: true, sourceFileName: file }, code);
  return { code: out.code, map: out.map, strings: [...strings], contexts };
}

/** Strings (and where they appear), without rewriting. */
export function extractItems(code: string, file: string): { strings: string[]; contexts: Record<string, string> } {
  const r = transformJsx(code, file, { rewrite: false });
  return { strings: r?.strings ?? [], contexts: r?.contexts ?? {} };
}

export function extractStrings(code: string, file: string): string[] {
  return extractItems(code, file).strings;
}
