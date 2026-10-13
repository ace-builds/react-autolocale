/**
 * End-to-end test of the many ways text can be written. Packs the library, installs it into a copy of
 * examples/patterns-app (text in arrays, objects, JSON, ternaries, template literals, concatenation, createElement,
 * msg(), sentences with links, state), generates translations with a stand-in engine that prefixes every string with
 * its language, builds, and checks in Chrome that each pattern is translated and that code which compares strings
 * still works.
 *
 *   node e2e/patterns.mjs        (needs network for installs and Chrome)
 *   CHROME_PATH=/path/to/chrome node e2e/patterns.mjs
 */
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rl-patterns-"));
const run = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, stdio: "inherit" });
const CHROME =
  process.env.CHROME_PATH ??
  ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/google-chrome", "/usr/bin/chromium"].find((p) => fs.existsSync(p));
if (!CHROME) throw new Error("Chrome not found. Set CHROME_PATH.");

run("pnpm", ["build"], root);
const packed = execFileSync("npm", ["pack", "--pack-destination", tmp, "--silent"], { cwd: root }).toString().trim().split("\n").pop();
const app = path.join(tmp, "app");
fs.cpSync(path.join(root, "examples/patterns-app"), app, { recursive: true });
fs.writeFileSync(path.join(app, "package.json"), JSON.stringify({ name: "patterns-app", private: true, type: "module" }));
run("npm", ["install", "--silent", "react", "react-dom", "vite", "@vitejs/plugin-react", path.join(tmp, packed)], app);
run("npx", ["react-autolocale", "generate"], app);
run("npx", ["vite", "build"], app);

const PORT = 5192;
const server = spawn("npx", ["vite", "preview", "--port", String(PORT), "--strictPort"], { cwd: app, stdio: "ignore" });
const BASE = `http://localhost:${PORT}`;
for (let i = 0; i < 40; i++) {
  if (await fetch(BASE).then(() => true, () => false)) break;
  await new Promise((r) => setTimeout(r, 500));
}

const { chromium } = await import("playwright-core");
const browser = await chromium.launch({ executablePath: CHROME, headless: true });
let failed = 0, total = 0;
const check = (name, ok, detail = "") => { total++; if (!ok) failed++; console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : "  -> " + detail}`); };

for (const lang of ["fr", "en"]) {
  const M = lang === "en" ? "" : `[${lang.toUpperCase()}] `;
  console.log(`\n######## /${lang}/`);
  const ctx = await browser.newContext({ locale: "en-US" });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message.slice(0, 140)));
  page.on("console", (m) => m.type() === "error" && !/favicon|Failed to load resource/.test(m.text()) && errors.push(m.text().slice(0, 140)));
  await page.goto(`${BASE}/${lang}/`, { waitUntil: "networkidle" });
  const t = (sel) => page.locator(sel).first().innerText();
  const all = (sel) => page.$$eval(sel, (els) => els.map((e) => e.innerText.trim()));

  check("no console errors", errors.length === 0, errors.join(" | "));
  check("nav (array of strings)", JSON.stringify(await all("#nav a")) === JSON.stringify(["Home", "Pricing", "Contact us"].map((x) => M + x)), JSON.stringify(await all("#nav a")));
  check("cards (array of objects)", (await t("#cards h2")) === M + "Fast builds" && (await t("#cards p")) === M + "Ship in seconds, not minutes.", await t("#cards h2"));
  check("specs (array of tuples)", (await all("#specs dt")).join() === ["Weight", "Range"].map((x) => M + x).join(), (await all("#specs dt")).join());
  check("FAQ from a JSON file", (await t("#faq h2")) === M + "Frequently asked questions" && (await all("#faq summary"))[0] === M + "How does it work?", await t("#faq h2"));
  check("ternary text + ternary aria-label", (await t("#toggle")) === M + "Show details" && (await page.getAttribute("#toggle", "aria-label")) === M + "Open menu", await t("#toggle"));
  await page.click("#toggle");
  check("...and after a click (state change)", (await t("#toggle")) === M + "Hide details" && (await page.getAttribute("#toggle", "aria-label")) === M + "Close menu", await t("#toggle"));
  check("template literal", (await t("#template")) === M + "Copyright 2026 Acme. All rights reserved.", await t("#template"));
  check("concatenation with numbers", (await t("#concat")) === M + "Page 1 of 3", await t("#concat"));
  const g = await t("#greeting");
  check("concatenation + default param + sentence", g.includes(M + "Hello, " + M + "Ada!") && g.includes("You have 3 messages."), g);
  check("sentence with two links keeps both links", (await page.$$eval("#mixed a", (as) => as.map((a) => a.getAttribute("href")))).join() === "/terms,/privacy" && (await all("#mixed a")).join() === ["Terms", "Privacy Policy"].map((x) => M + x).join(), (await all("#mixed a")).join());
  check("sentence text around the links", (await t("#mixed")).startsWith(M + "By continuing you agree to our"), await t("#mixed"));
  check("useState initial text", (await t("#state")) === M + "Ready to go", await t("#state"));
  await page.click("#save");
  check("text set later from data", (await t("#state")) === M + "Saved successfully", await t("#state"));
  check("createElement children", (await t("#el h3")) === M + "Built with createElement", await t("#el h3"));
  check("msg() marker", (await t("#marked")) === `${M}open / ${M}Hello ${M}Bob`, await t("#marked"));
  check("placeholder", (await page.getAttribute("#email", "placeholder")) === M + "Your email address");
  check("link target is untouched", (await page.getAttribute("#docs", "href")) === "https://example.com/docs");
  // The logic that compares strings must keep working
  check("tabs: 'All' is compared in code, so it is untouched", (await all("#tabs button"))[0] === "All", JSON.stringify(await all("#tabs button")));
  check("filter starts on All and shows both products", (await all("#products li")).length === 2, JSON.stringify(await all("#products li")));
  await page.click("#tabs button:nth-child(2)");
  check("clicking a tab filters the products (translated values still match)", (await all("#products li")).length === 1 && (await all("#products li"))[0] === M + "Hammer", JSON.stringify(await all("#products li")));
  await page.click("#tabs button:nth-child(1)");
  check("clicking All shows both again", (await all("#products li")).length === 2);
  await ctx.close();
}

// Switching language reloads the page (the strings that live in data can only change on a fresh page)
{
  const ctx = await browser.newContext({ locale: "en-US" });
  const page = await ctx.newPage();
  await page.goto(`${BASE}/en/`, { waitUntil: "networkidle" });
  await page.evaluate(() => (window.__marker = "same-document"));
  await page.selectOption("select", "fr");
  await page.waitForURL("**/fr/");
  await page.waitForLoadState("networkidle");
  check("switching language goes to /fr/", new URL(page.url()).pathname === "/fr/");
  check("...as a fresh page, because data strings were translated at load", (await page.evaluate(() => window.__marker)) === undefined);
  check("...and the page is French", (await page.locator("#nav a").first().innerText()) === "[FR] Home");
  await ctx.close();
}

// The dev server loads translations differently from a build, so check it too.
{
  const dev = spawn("npx", ["vite", "--port", "5193", "--strictPort"], { cwd: app, stdio: "ignore" });
  for (let i = 0; i < 60; i++) {
    if (await fetch("http://localhost:5193").then(() => true, () => false)) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  const page = await (await browser.newContext({ locale: "en-US" })).newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message.slice(0, 120)));
  await page.goto("http://localhost:5193/fr/", { waitUntil: "networkidle" });
  check("dev server: data translated", (await page.locator("#nav a").first().innerText()) === "[FR] Home");
  check("dev server: useState starting text translated", (await page.locator("#state").innerText()) === "[FR] Ready to go");
  check("dev server: no errors", errors.length === 0, errors.join(" | "));
  dev.kill();
}

await browser.close();
server.kill();
console.log(`\n${total - failed}/${total} checks passed`);
process.exit(failed ? 1 : 0);
