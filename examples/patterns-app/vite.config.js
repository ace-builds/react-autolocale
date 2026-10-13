import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import reactAutolocale from "react-autolocale/vite";
export default defineConfig({ plugins: [reactAutolocale(), react()] });
