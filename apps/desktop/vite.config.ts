import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Tauri ignores ports listed via `tauri.conf.json -> build.devUrl`,
// so we hardcode 1420 to match the Tauri config.
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
  },
  envPrefix: ["VITE_", "TAURI_"],
  build: {
    target: "esnext",
    sourcemap: false,
  },
});
