import { notFound } from 'next/navigation';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000';

/**
 * A store that does not exist, or is suspended or closed, answers a real
 * HTTP 404 with the "not found" page (the API already hides it). Asked on
 * the server before the page renders; if the API cannot be reached, the page
 * renders and decides in the browser as before.
 */
export default async function StoreLayout({ children, params }: { children: React.ReactNode; params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  let missing = false;
  try {
    const res = await fetch(`${API_URL}/api/stores/${encodeURIComponent(slug)}`, { next: { revalidate: 30 } });
    missing = res.status === 404;
  } catch {
    missing = false;
  }
  if (missing) notFound();
  return children;
}
