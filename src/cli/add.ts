import fs from "node:fs";
import path from "node:path";

const SWITCHER = `import { useLanguage } from "react-autolocale";

// This file is yours: change the markup, style it, or replace it entirely.
export function LanguageSwitcher() {
  const { language, languages, setLanguage } = useLanguage();
  return (
    <div role="group" aria-label="Language">
      {languages.map((l) => (
        <button
          key={l.code}
          lang={l.code}
          aria-pressed={l.code === language}
          onClick={() => setLanguage(l.code)}
        >
          {l.native}
        </button>
      ))}
    </div>
  );
}
`;

const BANNER = `import { useLanguageSuggestion } from "react-autolocale";

// This file is yours: change the markup, style it, or replace it entirely.
// It renders nothing unless the visitor's browser language differs from this page's language.
export function LanguageBanner() {
  const suggestion = useLanguageSuggestion();
  if (!suggestion) return null;
  return (
    <div role="region" aria-label={suggestion.native}>
      <span>{suggestion.text}</span>
      <button onClick={suggestion.accept}>{suggestion.switchLabel}</button>
      <button onClick={suggestion.dismiss}>{suggestion.dismissLabel}</button>
    </div>
  );
}
`;

export const COMPONENTS = { switcher: "LanguageSwitcher", banner: "LanguageBanner" } as const;

/** Copies an editable component into the project. Returns the file written, relative to `root`. */
export function addComponent(root: string, which: keyof typeof COMPONENTS, dirFlag?: string): { file: string; name: string } {
  const name = COMPONENTS[which];
  const dir = path.resolve(root, dirFlag ?? (fs.existsSync(path.join(root, "src")) ? "src/components" : "components"));
  const ts = fs.existsSync(path.join(root, "tsconfig.json"));
  const file = path.join(dir, `${name}.${ts ? "tsx" : "jsx"}`);
  if (fs.existsSync(file)) throw new Error(`${path.relative(root, file)} already exists.`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, which === "banner" ? BANNER : SWITCHER);
  return { file: path.relative(root, file), name };
}
