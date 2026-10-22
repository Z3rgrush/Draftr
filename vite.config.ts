import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

// `npm run build` builds the desktop UI for Tauri. `npm run build:preview` builds
// a single self-contained HTML file so the prototype can be tried in a browser.
export default defineConfig(({ mode }) => ({
  clearScreen: false,
  server: { port: 1420, strictPort: true },
  build: {
    target: "es2022",
    outDir: mode === "preview" ? "dist-preview" : "dist",
  },
  plugins: mode === "preview" ? [viteSingleFile()] : [],
}));
