import { describe, expect, it } from "vitest";
import { looksLikeCopy } from "../src/core/classify.js";

const copy = [
  // single words people read
  "Home", "Specs", "Contact", "Über", "FAQ", "OK", "你好", "Ñandú", "Dashboard",
  // phrases and sentences
  "Close menu", "Design your system", "How it works", "Terms & conditions", "Privacy policy",
  "The Bee launches on its own, flies saved routes with obstacle avoidance.", "Weight", "Operational flight time",
  "4 m/s · 14.5 km/h", "1.56 kg incl. battery", "−10 °C to 40 °C", "Industrial · Rail", "SBB — Swiss Federal Railways",
  "Something went wrong", "Please enter a valid email", "Are you sure?", "VEHICLE · DELIVERY VAN", "Welcome back!",
  "learn more", "Sign in", "Powered by GitHub", "Follow us on YouTube", "Built with createElement", "Buy the new iPhone", "Ada Lovelace", "Loading...", "Saved!", "Name:", "Done.", "Really?", "Retry…", "Hello, {name}!", "{count} items", "Save 20% on your first order", "Next →",
];
const code = [
  // addresses and files
  "https://sunflower-labs.com/specs", "http://localhost:3000", "/pricing", "./components/Button", "../lib/x", "#how-it-works",
  "@company/pkg", "mailto:hi@x.com", "tel:+123", "data:image/png;base64,AAA", "hi@example.com", "image.png", "data.json",
  "index.html", "application/json", "text/html", "//cdn.x.com/a.js", "~/src/app",
  // identifiers and tokens
  "primary", "btnPrimary", "snake_case", "kebab-case", "UPPER_SNAKE", "a.b.c", "useState", "div", "button", "submit",
  "GET", "POST", "UTF-8", "en", "fr", "en-US", "zh-Hans", "auto", "none", "flex",
  // CSS and SVG and code
  "flex items-center", "btn btn-primary", "text-sm font-bold", "w-1/2 md:w-full", "mt-4", "#fff", "rgba(0,0,0,0.5)",
  "var(--accent)", "calc(100% - 2px)", "translate(430,278) rotate(4)", "rotate(25 18 14)", "'Inter Tight', sans-serif",
  "'JetBrains Mono', ui-monospace, monospace", "12px", "0.5s ease", "M12,3 V9 H4", "M 10 20 L 30 40", "color: red;",
  "YYYY-MM-DD", "HH:mm:ss", "<div>hi</div>", "() => x", "{}", "function foo", "import x", "const y",
  // no letters
  "btnPrimary btnLarge", "my_var other_var", "x...", "123", "---", "Loading_state", "btn-primary:", "· · ·", "→", "", " ",
];

describe("looksLikeCopy", () => {
  for (const s of copy) it(`reads as text: ${JSON.stringify(s)}`, () => expect(looksLikeCopy(s)).toBe(true));
  for (const s of code) it(`is a code value: ${JSON.stringify(s)}`, () => expect(looksLikeCopy(s)).toBe(false));
});
