/** @type {import('next').NextConfig} */

// In development, proxy /api and /uploads through the Next server so a single
// origin (e.g. a Cloudflare quick tunnel on :3000) can reach the API too.
// Production is untouched: nginx routes /api to the API container directly.
const isDev = process.env.NODE_ENV !== 'production';
const apiProxyTarget = process.env.API_PROXY_TARGET ?? 'http://localhost:4000';

/**
 * NEXT_PUBLIC_* values are inlined at build time, so a deployable image is only
 * as correct as the values present while it was built. Both of these are load
 * bearing in a way that fails quietly rather than loudly:
 *
 *   NEXT_PUBLIC_SITE_URL — written into sitemap.xml, robots.txt and OG tags.
 *     A localhost value there gets crawled and indexed.
 *   NEXT_PUBLIC_API_URL  — every browser request goes to it. A localhost value
 *     means the site loads and then nothing works, for everyone.
 *
 * The check covers both ways the value can be wrong. Unset is the Docker case:
 * the root .dockerignore keeps .env out of the build context, so an omitted
 * build arg arrives as nothing at all. Localhost is the case where a value is
 * supplied but points at the build machine — SITE_URL left at localhost in
 * .env.production, or a deploy build run on a developer's box, where .env is
 * read straight off disk. Either one produces an image that looks fine and is
 * not.
 *
 * It runs only when the Dockerfile marks the build as one that produces a
 * deployable image (CLOWE_DEPLOY_BUILD=1). A plain local `npm run build` is
 * untouched and keeps working off the localhost fallback.
 */
function assertDeployableUrl(name) {
  const value = (process.env[name] ?? '').trim();
  const problem = !value
    ? 'is not set'
    : /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(:|\/|$)/i.test(value)
      ? `points at the build machine (${value})`
      : null;
  if (!problem) return;

  throw new Error(
    `\n\n  ${name} ${problem}.\n\n` +
      `  This value is baked into the bundle at build time and cannot be changed\n` +
      `  afterwards, so the image would ship pointing at the wrong host.\n\n` +
      `  Pass it as a build arg:\n` +
      `    docker build -f apps/web/Dockerfile \\\n` +
      `      --build-arg NEXT_PUBLIC_API_URL=https://yourdomain.com \\\n` +
      `      --build-arg NEXT_PUBLIC_SITE_URL=https://yourdomain.com \\\n` +
      `      -t clowe-web .\n\n` +
      `  With docker compose it comes from SITE_URL in .env.production.\n`,
  );
}

export default function config(phase) {
  // 'phase-production-build' is next build; the marker narrows that to builds
  // that produce an image, so local production builds stay unaffected.
  if (phase === 'phase-production-build' && process.env.CLOWE_DEPLOY_BUILD === '1') {
    assertDeployableUrl('NEXT_PUBLIC_SITE_URL');
    assertDeployableUrl('NEXT_PUBLIC_API_URL');
  }

  return {
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
}
