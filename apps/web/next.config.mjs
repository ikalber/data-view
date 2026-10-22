import { readFileSync } from "node:fs";

const { version } = JSON.parse(
  readFileSync(new URL("./package.json", import.meta.url), "utf8"),
);

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Shown on the login page; kept in sync by scripts/release.sh bumping package.json.
  env: { NEXT_PUBLIC_APP_VERSION: version },
  transpilePackages: ["@data-view/ui", "@data-view/core"],
  // Native modules and DB drivers must be left as runtime require()s, not
  // bundled by webpack. Otherwise `bindings` can't find the .node file and
  // pg / mysql2 / mssql break in similar ways.
  serverExternalPackages: [
    "better-sqlite3",
    "bindings",
    "pg",
    "pg-native",
    "mysql2",
    "mssql",
    "tedious",
    "bcryptjs",
  ],
};

export default nextConfig;
