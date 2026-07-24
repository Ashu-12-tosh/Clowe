/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: ['@clowe/shared'],
  // Self-contained server bundle for the production Docker image.
  output: 'standalone',
};

export default nextConfig;
