/**
 * End-to-end test in a real browser. Packs the library, installs it into a copy of examples/router-app,
 * builds that app, serves it, and drives Chrome through the behaviors users depend on.
 *
 *   node e2e/run.mjs            (needs network for installs and the first-run translation models)
 *
 * Translation is its own step (`react-autolocale generate`, local models); the build must not translate.
 *   CHROME_PATH=/path/to/chrome node e2e/run.mjs
 */
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rl-e2e-"));
const run = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, stdio: "inherit" });
const CHROME =
  process.env.CHROME_PATH ??
  ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/google-chrome", "/usr/bin/chromium"].find((p) => fs.existsSync(p));
if (!CHROME) throw new Error("Chrome not found. Set CHROME_PATH.");

console.log("Packing the library...");
run("pnpm", ["build"], root);
const packed = execFileSync("npm", ["pack", "--pack-destination", tmp, "--silent"], { cwd: root }).toString().trim().split("\n").pop();
const tarball = path.join(tmp, packed);

const app = path.join(tmp, "app");
fs.cpSync(path.join(root, "examples/router-app"), app, { recursive: true });
fs.writeFileSync(path.join(app, "package.json"), JSON.stringify({ name: "e2e-app", private: true, type: "module" }));
console.log("Installing the example app...");
run("npm", ["install", "--silent", "react", "react-dom", "react-router", "vite", "@vitejs/plugin-react", tarball], app);
console.log("Generating translations (first run downloads the local models)...");
run("npx", ["react-autolocale", "generate"], app);
console.log("Building it (no translation happens here)...");
const buildLog = execFileSync("npx", ["vite", "build"], { cwd: app }).toString();
process.stdout.write(buildLog);

const PORT = 5191;
const server = spawn("npx", ["vite", "preview", "--port", String(PORT), "--strictPort"], { cwd: app, stdio: "ignore" });
const BASE = `http://localhost:${PORT}`;
for (let i = 0; i < 40; i++) {
  if (await fetch(BASE).then(() => true, () => false)) break;
  await new Promise((r) => setTimeout(r, 500));
}

const { chromium } = await import("playwright-core");
const browser = await chromium.launch({ executablePath: CHROME, headless: true });
let failed = 0;
const check = (name, ok, detail = "") => {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  -> " + detail : ""}`);
};

async function visit(locale, url, fn) {
  const ctx = await browser.newContext({ locale });
  const page = await ctx.newPage();
  page.setDefaultTimeout(8000);
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && !/favicon|Failed to load resource/.test(m.text() + m.location().url) && errors.push(m.text()));
  try {
    await page.goto(BASE + url, { waitUntil: "networkidle" });
    await fn(page, errors);
  } catch (e) {
    check(`${locale} ${url}`, false, String(e.message).split("\n")[0]);
  }
  await ctx.close();
}
const h1 = (page) => page.locator("h1").first().textContent();
const path_ = (page) => new URL(page.url()).pathname;

check("the build did no translation work", !/translating|Loading model|download/i.test(buildLog));
check("catalogs were written to src/generated/auto-locale/", fs.existsSync(path.join(app, "src/generated/auto-locale/fr.json")));

// Static HTML, as search engines and no-JS visitors get it
const frHtml = await (await fetch(`${BASE}/fr/about/`)).text();
check("static /fr/about/ is already translated", /<h1>[^<]+<\/h1>/.test(frHtml) && !frHtml.includes("<h1>About us"));
check("static /en/about/ is English", (await (await fetch(`${BASE}/en/about/`)).text()).includes("<h1>About us"));
check("route with no links to it was built (/fr/thank-you/)", (await fetch(`${BASE}/fr/thank-you/`)).status === 200);

await visit("fr-FR", "/", async (page, errors) => {
  check("French browser on / is sent to /fr/", path_(page) === "/fr/", page.url());
  check("...and sees a translated heading", (await h1(page)) !== "Welcome home", await h1(page));
  check("<html lang> is fr", (await page.getAttribute("html", "lang")) === "fr");
  check("no console errors", errors.length === 0, errors.join(" | "));
});

await visit("en-US", "/", async (page) => {
  check("English browser on / settles on /en/ and renders", path_(page) === "/en/" && (await h1(page)) === "Welcome home", `${page.url()} ${await h1(page)}`);
});

await visit("fr-FR", "/en/about/", async (page) => {
  check("explicit /en/about/ is not redirected", path_(page) === "/en/about/");
  const banner = page.locator("[role=region]");
  await banner.waitFor();
  check("French browser sees the suggestion banner in French", /Français/.test(await banner.textContent()), await banner.textContent());
  await banner.locator("button").first().click();
  await page.waitForURL("**/fr/about/");
  check("accepting it goes to /fr/about/ in French", (await h1(page)) !== "About us", await h1(page));
});

await visit("en-US", "/en/contact/", async (page) => {
  await page.evaluate(() => (window.__marker = "same-document"));
  await page.selectOption("select", "es");
  await page.waitForURL("**/es/contact/");
  check("switcher changes URL without reloading", (await page.evaluate(() => window.__marker)) === "same-document");
  await page.waitForFunction(() => document.querySelector("h1")?.textContent !== "Contact us");
  check("...and the page is translated", (await h1(page)) !== "Contact us", await h1(page));
  check("text with a variable keeps its value", (await page.locator("section p").textContent()).includes("Ada"), await page.locator("section p").textContent());
  await page.goBack();
  await page.waitForURL("**/en/contact/");
  check("Back returns to English", (await h1(page)) === "Contact us");
});

await visit("en-US", "/fr/about", async (page) => {
  await page.waitForFunction(() => document.querySelector("h1")?.textContent !== "About us");
  check("hard load of /fr/about (no slash, root fallback) still shows French", path_(page).startsWith("/fr/") && (await h1(page)) !== "About us", await h1(page));
});

await visit("fr-FR", "/en/", async (page) => {
  await page.locator("[role=region]").waitFor();
  await page.locator("[role=region] button").nth(1).click();
  await page.reload({ waitUntil: "networkidle" });
  check("a dismissed banner stays hidden", (await page.locator("[role=region]").count()) === 0);
});

await browser.close();
server.kill();
console.log(failed ? `\n${failed} check(s) failed` : "\nall checks passed");
process.exit(failed ? 1 : 0);
