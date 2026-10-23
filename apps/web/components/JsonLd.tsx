/**
 * Structured data for search engines. A data block, not a script that runs,
 * so the Content-Security-Policy does not apply to it. `<` is escaped so no
 * value can close the tag early.
 */
export default function JsonLd({ data }: { data: Record<string, unknown> | Record<string, unknown>[] }) {
  return (
    <script
      type="application/ld+json"
      dangerouslySetInnerHTML={{ __html: JSON.stringify(data).replace(/</g, '\\u003c') }}
    />
  );
}
