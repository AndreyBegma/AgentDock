import type { NextConfig } from 'next';
import pkg from './package.json';

const apiUrl = process.env.API_URL ?? 'http://localhost:8180';

const nextConfig: NextConfig = {
  output: 'standalone',
  reactStrictMode: true,
  // F-27: do not advertise the framework.
  poweredByHeader: false,
  // C-293: the About page shows the version this build was made from.
  env: { NEXT_PUBLIC_APP_VERSION: pkg.version },
  transpilePackages: ['@agentdock/shared'],
  // Same-origin API access (spec D12): cookies stay first-party.
  async rewrites() {
    return [{ source: '/api/:path*', destination: `${apiUrl}/:path*` }];
  },
};

export default nextConfig;
