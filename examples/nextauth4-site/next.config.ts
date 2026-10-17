import type { NextConfig } from "next";
import path from "node:path";
const config: NextConfig = {
  turbopack: { root: path.resolve(import.meta.dirname, "../..") },
  // Pages Router: the keyring posts to /klicenka/login, the handler lives under /api.
  async rewrites() { return [{ source: "/klicenka/:path*", destination: "/api/klicenka/:path*" }]; },
};
export default config;
