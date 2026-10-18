import { defineConfig } from "tsdown";

export default defineConfig({
  entry: { index: "src/runtime/index.ts", vite: "src/vite/index.ts", config: "src/config.ts", cli: "src/cli/bin.ts", "cli-commands": "src/cli/index.ts" },
  format: "esm",
  platform: "neutral",
  dts: true,
  clean: true,
  external: [/^virtual:react-autolocale/, /^node:/, "openai", "@anthropic-ai/sdk", "@huggingface/transformers"],
});
