/** @type {import('next').NextConfig} */

// In development, proxy /api and /uploads through the Next server so a single
// origin (e.g. a Cloudflare quick tunnel on :3000) can reach the API too.
// Production is untouched: nginx routes /api to the API container directly.
const isDev = process.env.NODE_ENV !== 'production';
const apiProxyTarget = process.env.API_PROXY_TARGET ?? 'http://localhost:4400';

const nextConfig = {
  transpilePackages: ['@clowe/shared'],
  // Self-contained server bundle for the production Docker image.
  output: 'standalone',
  async rewrites() {
    if (!isDev) return [];
    return [
      { source: '/api/:path*', destination: `${apiProxyTarget}/api/:path*` },
      { source: '/uploads/:path*', destination: `${apiProxyTarget}/uploads/:path*` },
    ];
  },
};

export default nextConfig;
