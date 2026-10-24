import type { NextConfig } from 'next';

const apiUrl = process.env.API_URL ?? 'http://localhost:8180';

const nextConfig: NextConfig = {
  output: 'standalone',
  reactStrictMode: true,
  // F-27: do not advertise the framework.
  poweredByHeader: false,
  transpilePackages: ['@nautelle/shared'],
  // `next dev` serves its dev resources only to localhost by default; demo
  // recordings (C-383) open the app on 127.0.0.1 and would never hydrate.
  allowedDevOrigins: ['127.0.0.1'],
  // Same-origin API access (spec D12): cookies stay first-party.
  async rewrites() {
    return [{ source: '/api/:path*', destination: `${apiUrl}/:path*` }];
  },
};

export default nextConfig;
