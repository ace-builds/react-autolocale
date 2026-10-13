import { defineConfig } from "react-autolocale/config";
export default defineConfig({
  sourceLocale: "en",
  locales: ["en", "fr", "es"],
  provider: async ({ texts, to }: { texts: string[]; to: string }) => texts.map((t) => `[${to.toUpperCase()}] ${t}`),
});
