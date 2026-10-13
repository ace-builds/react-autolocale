import http from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { geminiTranslator } from "../src/core/providers.js";
import { TranslationError } from "../src/core/translate.js";

type Reply = { status?: number; body: unknown; headers?: Record<string, string> };

/** A stand-in for Gemini's generateContent endpoint that records requests and replies from a queue. */
async function fakeGemini(replies: Reply[] | ((req: any) => Reply)) {
  const requests: { url: string; key: string | undefined; body: any }[] = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = JSON.parse(raw);
      requests.push({ url: req.url!, key: req.headers["x-goog-api-key"] as string | undefined, body });
      const reply = typeof replies === "function" ? replies(body) : replies.shift()!;
      res.statusCode = reply.status ?? 200;
      res.setHeader("content-type", "application/json");
      for (const [k, v] of Object.entries(reply.headers ?? {})) res.setHeader(k, v);
      res.end(JSON.stringify(reply.body));
    });
  });
  await new Promise<void>((r) => server.listen(0, r));
  const baseURL = `http://localhost:${(server.address() as { port: number }).port}/v1beta`;
  return { baseURL, requests, close: () => server.close() };
}

const ok = (translations: string[]) => ({
  candidates: [{ finishReason: "STOP", content: { parts: [{ text: JSON.stringify({ translations }) }] } }],
});
const noWait = { sleep: async () => {} };
let closers: (() => void)[] = [];
afterEach(() => {
  closers.forEach((c) => c());
  closers = [];
  delete process.env.RL_GEMINI_TEST_KEY;
});
const setup = async (replies: Reply[] | ((req: any) => Reply), extra = {}) => {
  process.env.RL_GEMINI_TEST_KEY = "test-key-123";
  const g = await fakeGemini(replies);
  closers.push(g.close);
  const t = geminiTranslator({ name: "gemini", apiKeyEnv: "RL_GEMINI_TEST_KEY", baseURL: g.baseURL, ...extra }, noWait);
  return { t, ...g };
};

describe("gemini provider", () => {
  it("sends the key in a header, the element as context, and asks for structured JSON", async () => {
    const { t, requests } = await setup([{ body: ok(["Accueil", "Contact"]) }]);
    const out = await t.translate(["Home", "Contact"], "en", "fr", ["a", "a"]);
    expect(out).toEqual(["Accueil", "Contact"]);
    const r = requests[0]!;
    expect(r.url).toBe("/v1beta/models/gemini-2.5-flash:generateContent");
    expect(r.key).toBe("test-key-123");
    expect(JSON.stringify(r.body)).not.toContain("test-key-123"); // never in the body
    expect(r.body.generationConfig.responseMimeType).toBe("application/json");
    expect(r.body.generationConfig.responseSchema.properties.translations.type).toBe("ARRAY");
    expect(r.body.generationConfig.temperature).toBe(0);
    expect(r.body.systemInstruction.parts[0].text).toContain("French (fr)");
    expect(JSON.parse(r.body.contents[0].parts[0].text)).toEqual({ items: [{ text: "Home", element: "a" }, { text: "Contact", element: "a" }] });
  });

  it("uses the configured model", async () => {
    const { t, requests } = await setup([{ body: ok(["x"]) }], { model: "gemini-pro-test" });
    await t.translate(["x"], "en", "fr");
    expect(requests[0]!.url).toBe("/v1beta/models/gemini-pro-test:generateContent");
  });

  it("retries rate limits and server errors, then succeeds", async () => {
    const { t, requests } = await setup([
      { status: 429, body: { error: { message: "slow down" } }, headers: { "retry-after": "1" } },
      { status: 503, body: { error: { message: "busy" } } },
      { body: ok(["Bonjour"]) },
    ]);
    expect(await t.translate(["Hello"], "en", "fr")).toEqual(["Bonjour"]);
    expect(requests).toHaveLength(3);
  });

  it("stops with a clear fatal error for a rejected key, and never echoes the key", async () => {
    const { t } = await setup([{ status: 400, body: { error: { message: "API key not valid. Please pass a valid API key." } } }]);
    const err = await t.translate(["Hello"], "en", "fr").catch((e) => e);
    expect(err).toBeInstanceOf(TranslationError);
    expect(err.fatal).toBe(true);
    expect(err.message).toMatch(/key was rejected/);
    expect(err.message).not.toContain("test-key-123");
  });

  it("treats a wrong model name and an exhausted quota as fatal", async () => {
    const a = await setup([{ status: 404, body: { error: { message: "models/nope is not found" } } }]);
    expect((await a.t.translate(["x"], "en", "fr").catch((e) => e)).message).toMatch(/model not found/);
    const quota = Array.from({ length: 4 }, () => ({ status: 429, body: { error: { message: "quota" } } }));
    const b = await setup(quota);
    const err = await b.t.translate(["x"], "en", "fr").catch((e) => e);
    expect(err.fatal).toBe(true);
    expect(err.message).toMatch(/rate limit or quota/);
    expect(b.requests).toHaveLength(4); // first try + 3 retries
  });

  it("retries a batch one string at a time when the reply has the wrong number of items", async () => {
    const { t, requests } = await setup((body) => {
      const items = JSON.parse(body.contents[0].parts[0].text).items as { text: string }[];
      return { body: ok(items.length === 2 ? ["only one"] : [`fr:${items[0]!.text}`]) };
    });
    expect(await t.translate(["A", "B"], "en", "fr")).toEqual(["fr:A", "fr:B"]);
    expect(requests).toHaveLength(3); // the pair, then A, then B
  });

  it("reports a truncated reply as a failed string instead of storing it", async () => {
    const { t } = await setup([{ body: { candidates: [{ finishReason: "MAX_TOKENS", content: { parts: [{ text: '{"translations": ["cut' }] } }] } }]);
    expect(await t.translate(["Hello"], "en", "fr")).toEqual([""]);
  });

  it("treats blocked or declined content as a batch error", async () => {
    const a = await setup([{ body: { promptFeedback: { blockReason: "SAFETY" } } }]);
    expect(await a.t.translate(["x"], "en", "fr").catch((e) => e)).toBeInstanceOf(TranslationError);
    const b = await setup([{ body: { candidates: [{ finishReason: "PROHIBITED_CONTENT" }] } }]);
    expect((await b.t.translate(["x"], "en", "fr").catch((e) => e)).message).toMatch(/declined/);
  });

  it("fails before any request when the key is missing", () => {
    delete process.env.RL_GEMINI_TEST_KEY;
    expect(() => geminiTranslator({ name: "gemini", apiKeyEnv: "RL_GEMINI_TEST_KEY" })).toThrow(/RL_GEMINI_TEST_KEY is not set/);
  });
});
