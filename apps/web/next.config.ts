import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["@copilotkit/runtime"],
  // Required for Docker standalone deployment
  output: "standalone",
  // Allow builds to succeed despite type errors in generated/third-party code
  typescript: { ignoreBuildErrors: true },
  // Allow Turbopack to resolve workspace packages from the monorepo root
  turbopack: { root: "../.." },
};

export default nextConfig;
