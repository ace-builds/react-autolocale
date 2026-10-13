import fs from "node:fs";
import path from "node:path";
import { parse } from "@babel/parser";
import _traverse from "@babel/traverse";
import * as t from "@babel/types";
import { walk } from "./walk.js";
import { parserPlugins } from "./transform.js";

const traverse: typeof _traverse = (_traverse as any).default ?? _traverse;

/** Facts about the whole project that decide which strings are safe to translate. */
export interface ProjectFacts {
  /**
   * Strings the code uses as values rather than text: compared (`status === "Active"`), switched on, used as object
   * keys or lookup keys, checked with `.includes("x")`, or named in TypeScript types. Translating one of them in
   * one place would break the code that compares it somewhere else, so they are never translated anywhere.
   */
  codeValues: Set<string>;
}

export const emptyFacts = (): ProjectFacts => ({ codeValues: new Set() });

/** Methods whose string argument is compared against something. */
const COMPARING_METHODS = new Set(["includes", "indexOf", "lastIndexOf", "startsWith", "endsWith", "has", "equals", "localeCompare"]);
const COMPARISONS = new Set(["===", "!==", "==", "!=", "in", "instanceof"]);

/** String values this file uses as code. */
export function codeValuesIn(code: string, file: string): Set<string> {
  const out = new Set<string>();
  let ast: t.File;
  try {
    ast = parse(code, { sourceType: "module", plugins: parserPlugins(file) });
  } catch {
    return out;
  }
  const add = (n: t.Node | null | undefined) => {
    if (t.isStringLiteral(n)) out.add(n.value);
    else if (t.isTemplateLiteral(n) && n.expressions.length === 0) out.add(n.quasis[0]!.value.cooked ?? "");
  };
  traverse(ast, {
    BinaryExpression(p) {
      if (COMPARISONS.has(p.node.operator)) {
        add(p.node.left);
        add(p.node.right);
      }
    },
    SwitchCase(p) {
      add(p.node.test);
    },
    ObjectProperty(p) {
      const k = p.node.key;
      if (!p.node.computed && t.isIdentifier(k)) out.add(k.name);
      else add(k);
    },
    ObjectMethod(p) {
      if (!p.node.computed && t.isIdentifier(p.node.key)) out.add(p.node.key.name);
    },
    MemberExpression(p) {
      if (p.node.computed) add(p.node.property);
    },
    CallExpression(p) {
      const c = p.node.callee;
      const name = t.isIdentifier(c) ? c.name : t.isMemberExpression(c) && t.isIdentifier(c.property) ? c.property.name : "";
      if (COMPARING_METHODS.has(name)) p.node.arguments.forEach((a) => add(a as t.Node));
      // ["Active", "Pending"].includes(status)
      if (t.isMemberExpression(c) && t.isIdentifier(c.property) && COMPARING_METHODS.has(c.property.name) && t.isArrayExpression(c.object)) {
        c.object.elements.forEach((e) => add(e));
      }
    },
    TSLiteralType(p) {
      add(p.node.literal as t.Node);
    },
    TSEnumMember(p) {
      add(p.node.initializer);
      if (t.isIdentifier(p.node.id)) out.add(p.node.id.name);
    },
    // const STATUSES = ["open", "closed"] as const
    TSAsExpression(p) {
      if (t.isTSTypeReference(p.node.typeAnnotation) && t.isIdentifier(p.node.typeAnnotation.typeName, { name: "const" })) {
        const e = p.node.expression;
        if (t.isArrayExpression(e)) e.elements.forEach((x) => add(x));
        if (t.isObjectExpression(e)) e.properties.forEach((pr) => t.isObjectProperty(pr) && add(pr.value));
      }
    },
  });
  return out;
}

/** Per-file code values, so one edited file can be re-read without scanning the project again. */
export class FactsIndex {
  private perFile = new Map<string, Set<string>>();
  private union: Set<string> | null = null;

  set(file: string, code: string): void {
    this.perFile.set(file, codeValuesIn(code, file));
    this.union = null;
  }

  delete(file: string): void {
    this.perFile.delete(file);
    this.union = null;
  }

  facts(): ProjectFacts {
    this.union ??= new Set([...this.perFile.values()].flatMap((s) => [...s]));
    return { codeValues: this.union };
  }
}

/** Reads every source file under `include` once. */
export function buildFactsIndex(root: string, include: string[]): FactsIndex {
  const index = new FactsIndex();
  for (const dir of include) {
    for (const file of walk(path.resolve(root, dir))) index.set(file, fs.readFileSync(file, "utf8"));
  }
  return index;
}

export function collectProjectFacts(root: string, include: string[]): ProjectFacts {
  return buildFactsIndex(root, include).facts();
}
