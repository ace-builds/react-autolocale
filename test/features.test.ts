import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { messageId } from "../src/core/ids.js";
import { describe, expect, it } from "vitest";
import { ensureTranslations } from "../src/core/cache.js";
import { digitsPreserved, mask, ollama, toTranslator, unmask, type Translator } from "../src/core/translate.js";
import { extractItems, transformJsx } from "../src/core/transform.js";

describe("dynamic templates", () => {
  it("turns text with variables into one template", () => {
    const code = `const A = ({ user, count }) => <p>Welcome, {user.name}. You have {count} new messages</p>;`;
    expect(extractItems(code, "A.tsx").strings).toEqual(["Welcome, {name}. You have {count} new messages"]);
    const out = transformJsx(code, "A.tsx")!.code;
    expect(out).toContain(`<__RLTD i="${messageId("Welcome, {name}. You have {count} new messages")}" s="Welcome, {name}. You have {count} new messages"`);
    expect(out).toContain("name: user.name");
    expect(out).toContain("count: count");
    expect(out).toContain(`import { __TD as __RLTD } from "react-autolocale"`);
  });

  it("disambiguates repeated variable names", () => {
    const code = `const A = ({ a, b }) => <p>{a.id} and {b.id} are friends</p>;`;
    expect(extractItems(code, "A.tsx").strings).toEqual(["{id} and {id_2} are friends"]);
    expect(transformJsx(code, "A.tsx")!.code).toMatch(/id: a\.id,\s*id_2: b\.id/);
  });

  it("keeps meaningful outer spaces", () => {
    const out = transformJsx(`const A = ({ n }) => <p> Hello {n} </p>;`, "A.tsx")!.code;
    expect(out).toMatch(/\{" "\}\s*<__RLTD i="msg_[0-9a-f]{10}" s="Hello \{n\}"[^>]*\/>\s*\{" "\}/);
  });

  it("does not touch calls, conditions or nested elements", () => {
    expect(extractItems(`const A = () => <p>Total {fmt(x)} due</p>;`, "A.tsx").strings).toEqual([]);
    expect(extractItems(`const A = () => <p>Hello {ok && "x"}!</p>;`, "A.tsx").strings).toEqual([]);
    expect(extractItems(`const A = () => <p>Hello <b>{name}</b></p>;`, "A.tsx").strings).toEqual(["Hello"]);
  });
});

describe("translate=\"no\"", () => {
  it("leaves the element, its children and its attributes alone", () => {
    const code = `const A = () => (
      <div>
        <p translate="no">Acme Cloud <b>Pro</b></p>
        <section translate="no"><input placeholder="Your email" /></section>
        <p>Keep this</p>
      </div>
    );`;
    expect(extractItems(code, "A.tsx").strings).toEqual(["Keep this"]);
  });
});

describe("contexts", () => {
  it("records where each string appears", () => {
    const code = `function A() { return <div><button>Save</button><h1>Title</h1><input placeholder="Email" /></div>; }`;
    expect(extractItems(code, "A.tsx").contexts).toEqual({ Save: "button", Title: "h1", Email: "placeholder" });
  });
});

describe("number protection", () => {
  it("locks prices, phone numbers, versions, hours and percentages", () => {
    const source = "Call 555-1234, open 9am-5pm, only $19.99 (-50%) on v2.5.1 for {name}";
    const { masked, phrases } = mask(source, []);
    expect(masked).not.toMatch(/555|1234|19\.99|2\.5/);
    expect([...phrases].sort()).toEqual(["$19.99", "2.5.1", "50%", "555-1234", "5pm", "9am", "{name}"].sort());
    expect(unmask(masked, phrases)).toBe(source);
  });

  it("applies glossary terms and keeps them out of the model's hands", () => {
    const { masked, phrases } = mask("See the Roadmap", [], { glossary: { Roadmap: "Feuille de route" } });
    expect(masked).toBe("See the X0X");
    expect(unmask("Voir le X0X", phrases)).toBe("Voir le Feuille de route");
  });

  it("re-translates with numbers locked only when the model changed them", async () => {
    const site = { original: "en", languages: ["fr"], exclude: [], seo: false };
    const calls: string[][] = [];
    const sloppy: Translator = {
      async translate(texts) {
        calls.push(texts);
        // changes the digits unless they are locked behind a placeholder
        return texts.map((t) => (/X\d+X/.test(t) ? t.replace("Call", "Appelez") : "Appelez le 555-5234"));
      },
    };
    const dicts = await ensureTranslations({
      site, strings: ["Call 555-1234"], getTranslator: () => sloppy,
    });
    expect(dicts.fr!["Call 555-1234"]).toBe("Appelez 555-1234");
    expect(calls[0]![0]).toBe("Call 555-1234"); // first pass: natural
    expect(calls[1]![0]).toMatch(/^Call X\d+X$/); // second pass: locked
  });

  it("checks digits survive", () => {
    expect(digitsPreserved("Join 1,250,000 users", "Rejoignez 1 250 000 utilisateurs")).toBe(true);
    expect(digitsPreserved("Call 555-1234", "Appelez le 555-5234")).toBe(false);
  });
});

describe("ensureTranslations", () => {
  const site = { original: "en", languages: ["fr"], exclude: ["Acme"], seo: false };
  const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "rl-feat-"));

  it("sends contexts, applies the glossary, and falls back safely", async () => {
    const seen: { texts: string[]; contexts?: string[] }[] = [];
    const engine: Translator = {
      async translate(texts, _f, _t, contexts) {
        seen.push({ texts, contexts });
        // a model that drops every placeholder in strings mentioning "broken", and translates the rest
        return texts.map((t) => (t.includes("broken") ? "traduction sans jetons" : `fr(${t})`));
      },
    };
    const dicts = await ensureTranslations({
      site,
      strings: ["Home", "Call 555-1234 now", "Roadmap", "Acme is broken 42"],
      contexts: { Home: "a", "Call 555-1234 now": "p", Roadmap: "h2" },
      glossary: { fr: { Roadmap: "Feuille de route" } },
      getTranslator: () => engine,
    });
    expect(dicts.fr!["Home"]).toBe("fr(Home)");
    expect(dicts.fr!["Call 555-1234 now"]).toBe("fr(Call 555-1234 now)"); // digits survived: no need to lock them
    expect(dicts.fr!["Roadmap"]).toBe("Feuille de route");
    // placeholders lost twice -> left in English rather than risking a wrong number
    expect(dicts.fr!["Acme is broken 42"]).toBeUndefined();
    expect(seen[0]!.contexts).toContain("a");
  });
});

describe("ollama engine", () => {
  it("sends the context and returns the model's reply", async () => {
    const requests: any[] = [];
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const parsed = JSON.parse(body);
        requests.push(parsed);
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ message: { content: " Accueil " } }));
      });
    });
    await new Promise<void>((r) => server.listen(0, r));
    const { port } = server.address() as { port: number };
    try {
      const engine = toTranslator(ollama({ model: "test", url: `http://localhost:${port}` }));
      const out = await engine.translate(["Home"], "en", "fr", ["a"]);
      expect(out).toEqual(["Accueil"]);
      expect(requests[0].model).toBe("test");
      expect(requests[0].messages[0].content).toContain("website a element");
      expect(requests[0].messages[1].content).toBe("Home");
    } finally {
      server.close();
    }
  });
});
