import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["ws"],
  env: {
    NEXT_PUBLIC_BUILD_TIME: new Date().toISOString(),
  },
  webpack: (config) => {
    // Suppress "Critical dependency" warnings from onnxruntime-web (used by @ricky0123/vad-web).
    // The WASM loader uses dynamic require() that webpack can't statically analyze — harmless.
    config.module.exprContextCritical = false;
    config.ignoreWarnings = [
      ...(config.ignoreWarnings ?? []),
      { module: /onnxruntime-web/ },
    ];
    return config;
  },
};

export default nextConfig;
