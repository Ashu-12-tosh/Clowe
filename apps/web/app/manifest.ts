import type { MetadataRoute } from 'next';

/** Installable app details: the Clowe Shop icon at 192 and 512 (and a maskable one for Android). */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'Clowe Shop',
    short_name: 'Clowe',
    description: 'Everything you need, one marketplace.',
    start_url: '/',
    display: 'standalone',
    background_color: '#0b0b0c',
    theme_color: '#0b0b0c',
    icons: [
      { src: '/brand/icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: '/brand/icon-512.png', sizes: '512x512', type: 'image/png' },
      { src: '/brand/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  };
}
