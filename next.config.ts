import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  webpack: (config) => {
    config.resolve.alias = {
      ...config.resolve.alias,
      "zod/v4": "zod",
    };
    return config;
  },
  // In Next.js 16, turbopack is a top-level property
  // @ts-ignore - Turbopack types might not be updated in the environment's NextConfig type yet
  turbopack: {
    resolveAlias: {
      "zod/v4": "zod",
    },
  },
  experimental: {
    serverActions: {
      bodySizeLimit: '50mb',
    },
  },
};

export default nextConfig;
