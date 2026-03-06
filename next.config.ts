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
  // @ts-expect-error - Turbopack types may lag NextConfig in some environments.
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
