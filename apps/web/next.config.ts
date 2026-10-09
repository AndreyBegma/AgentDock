import type { NextConfig } from 'next';

const apiUrl = process.env.API_URL ?? 'http://localhost:8180';

const nextConfig: NextConfig = {
  output: 'standalone',
  reactStrictMode: true,
  transpilePackages: ['@agentdock/shared', 'glass-ui'],
  // Same-origin API access (spec D12): cookies stay first-party.
  async rewrites() {
    return [{ source: '/api/:path*', destination: `${apiUrl}/:path*` }];
  },
};

export default nextConfig;
