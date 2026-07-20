import type { NextConfig } from "next";

const nextConfig: NextConfig = {
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
