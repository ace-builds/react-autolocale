import { describe, expect, it } from "vitest";
import { extractStrings, transformJsx } from "../src/core/transform.js";
import { patchViteConfig } from "../src/cli/viteConfig.js";
import { messageId as id } from "../src/core/ids.js";

describe("extractStrings", () => {
  it("finds static text and translatable attributes", () => {
    const code = `
      function App() {
        return (
          <div>
            <h1>Welcome to my website</h1>
            <p>
              Build something
              amazing
            </p>
            <input placeholder="Your email" />
            <button>Get Started</button>
          </div>
        );
      }`;
    expect(extractStrings(code, "App.tsx")).toEqual([
      "Welcome to my website",
      "Build something amazing",
      "Your email",
      "Get Started",
    ]);
  });

  it("leaves bare variables, code blocks and symbol-only text alone, but reads props on your components", () => {
    const code = `
      const A = () => (
        <div>
          <p>{name}</p>
          <p>{a} {b}</p>
          <code>npm install</code>
          <span>—</span>
          <span>42</span>
          <Foo title="Not html" />
        </div>
      );`;
    expect(extractStrings(code, "A.tsx")).toEqual(["Not html"]);
  });

  it("works with TypeScript syntax and ignores files without JSX", () => {
    expect(extractStrings(`const x: number = 1 < 2;`, "a.ts")).toEqual([]);
    expect(extractStrings(`const A = ({ n }: { n: number }) => <b>Count</b>;`, "A.tsx")).toEqual(["Count"]);
  });
});

describe("transformJsx", () => {
  it("replaces text with <__RLT> and imports the runtime", () => {
    const out = transformJsx(`export const A = () => <button>Get Started</button>;`, "A.tsx")!;
    expect(out.code).toContain(`import { __T as __RLT } from "react-autolocale"`);
    expect(out.code).toContain(`<__RLT i="${id("Get Started")}" s="Get Started" />`);
  });

  it("translates a sentence with an inline element as one message, keeping the element's own text separate", () => {
    const out = transformJsx(`const A = () => <p>Read the <b>docs</b> now</p>;`, "A.tsx")!;
    expect(out.strings).toEqual(["Read the {1} now", "docs"]);
    expect(out.code).toMatch(/<__RLTD i="msg_[0-9a-f]{10}" s="Read the \{1\} now" v=\{\{\s*1: /);
    expect(out.code).toContain('s="docs"'); // the bold word is translated on its own inside the placeholder
  });

  it("uses the load-time lookup for text kept by hooks (useState, useMemo, useCallback), the hook lookup elsewhere", () => {
    const code = `function A() {
      const [note] = useState("Ready to go");
      const tabs = useMemo(() => ["Overview", "Pricing"], []);
      return <p title="Plain tooltip">{note}{tabs}{open ? "Close it" : "Open it"}</p>;
    }`;
    const out = transformJsx(code, "A.tsx")!.code;
    expect(out).toMatch(/useState\(__rlText\("msg_[0-9a-f]{10}", "Ready to go"\)\)/);
    expect(out).toMatch(/useMemo\(\(\) => \[__rlText\([^)]*"Overview"\)/);
    expect(out).toMatch(/title=\{__rl\("msg_[0-9a-f]{10}", "Plain tooltip"\)\}/); // rendered directly: follows the language
    expect(out).toMatch(/open \? __rl\(/);
  });

  it("keeps decorative elements (icons, images) out of the sentence", () => {
    const out = transformJsx(`const A = () => <li><Icon /> Settings</li>;`, "A.tsx")!;
    expect(out.strings).toEqual(["Settings"]);
  });

  it("translates attributes through a hook inserted into the component", () => {
    const out = transformJsx(
      `export function Form() { return <input placeholder="Your email" />; }`,
      "Form.tsx",
    )!;
    expect(out.code).toContain(`const __rl = __rlUseT();`);
    expect(out.code).toContain(`placeholder={__rl("${id("Your email")}", "Your email")}`);
  });

  it("puts the hook in the component, not in a .map callback", () => {
    const out = transformJsx(
      `function List() { return items.map(i => <img alt="Product photo" />); }`,
      "List.tsx",
    )!;
    expect(out.code.indexOf("__rlUseT()")).toBeLessThan(out.code.indexOf("items.map"));
  });

  it("converts expression-bodied components to blocks when a hook is needed", () => {
    const out = transformJsx(`const Box = () => <input title="Search" />;`, "Box.tsx")!;
    expect(out.code).toMatch(/const Box = \(\) => \{\s*const __rl = __rlUseT\(\);\s*return/);
  });

  it("translates attributes at module level with the global lookup", () => {
    const out = transformJsx(`const el = <input placeholder="Hi there" />;`, "x.tsx")!;
    expect(out.strings).toEqual(["Hi there"]);
    expect(out.code).toContain("__rlText(");
    expect(out.code).not.toContain("__rlUseT");
  });
});


describe("patchViteConfig", () => {
  it("adds import and plugin to a standard config", () => {
    const src = `import { defineConfig } from "vite";\nimport react from "@vitejs/plugin-react";\n\nexport default defineConfig({\n  plugins: [react()],\n});\n`;
    const { code } = patchViteConfig(src)!;
    expect(code).toContain(`import reactAutolocale from "react-autolocale/vite";`);
    expect(code).toContain("plugins: [reactAutolocale(), react()]");
  });

  it("is idempotent", () => {
    const once = patchViteConfig(`import { defineConfig } from "vite";\nexport default defineConfig({ plugins: [] });`)!.code;
    expect(patchViteConfig(once)).toEqual({ code: once, changed: false });
  });
});
