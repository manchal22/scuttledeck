import path from "node:path";
import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Self-contained server bundle for the Docker/k8s image.
  output: "standalone",
  outputFileTracingRoot: path.join(path.dirname(fileURLToPath(import.meta.url)), "../.."),
  // Workspace packages ship TypeScript source; Next transpiles them in place.
  transpilePackages: ["@scuttledeck/db"],
  webpack: (config) => {
    // Workspace TS uses NodeNext `.js` specifiers — map them back to `.ts`.
    config.resolve.extensionAlias = {
      ".js": [".ts", ".js"],
      ".mjs": [".mts", ".mjs"],
    };
    return config;
  },
};

export default nextConfig;
