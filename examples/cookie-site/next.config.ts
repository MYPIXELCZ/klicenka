import type { NextConfig } from "next";
import path from "node:path";
// The package is linked from the repo root (file:../..), so Turbopack's root is the repo.
const config: NextConfig = { turbopack: { root: path.resolve(import.meta.dirname, "../..") } };
export default config;
