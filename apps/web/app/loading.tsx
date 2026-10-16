export default function Loading() {
  return (
    // A full screen tall, so the footer stays out of view while a page renders
    // (and is not pushed away, a layout shift, when the page arrives).
    <main className="flex min-h-screen items-center justify-center">
      <div className="h-10 w-10 animate-spin rounded-full border-4 border-brand-100 border-t-brand-600" />
    </main>
  );
}
