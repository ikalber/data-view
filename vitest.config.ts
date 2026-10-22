import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      // apps/web uses `@/…` for imports from its src folder.
      "@": fileURLToPath(new URL("./apps/web/src", import.meta.url)),
    },
  },
  test: {
    include: ["{packages,apps}/**/*.test.{ts,tsx}"],
    exclude: ["**/node_modules/**", "**/.next/**", "**/dist/**", ".claude/**"],
    environment: "node",
    // Integration tests talk to real databases; give slow servers some room.
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
