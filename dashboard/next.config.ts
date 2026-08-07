import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  experimental: {
    // Uploads de ZIP podem passar facilmente de alguns MB.
    // Route Handlers / proxy bufferizam o body — sem isso o Next corta em ~10MB.
    proxyClientMaxBodySize: "50mb",
    serverActions: {
      bodySizeLimit: "50mb",
    },
  },
};

export default nextConfig;
