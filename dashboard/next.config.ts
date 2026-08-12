import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import type { NextConfig } from "next";

/**
 * The dashboard is its own npm project inside the backend repository, so there
 * are two lockfiles above it. Left to infer, Turbopack walks up and picks the
 * repository root — which would put the Encore services inside the bundler's
 * workspace. Stating the root here keeps the two builds apart.
 */
const projectRoot = dirname(fileURLToPath(import.meta.url));

const nextConfig: NextConfig = {
  reactStrictMode: true,
  turbopack: {
    root: projectRoot,
  },
};

export default nextConfig;
