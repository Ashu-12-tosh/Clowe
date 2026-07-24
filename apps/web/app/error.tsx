'use client';

export default function GlobalError({ reset }: { error: Error; reset: () => void }) {
  return (
    <main className="mx-auto max-w-xl px-4 py-24 text-center">
      <p className="text-6xl">🪡</p>
      <h1 className="mt-4 text-2xl font-bold">Something went wrong</h1>
      <p className="mt-2 text-sm text-gray-600">
        An unexpected error occurred. Please try again — if it keeps happening, refresh the page.
      </p>
      <button
        onClick={reset}
        className="mt-6 rounded-lg bg-brand-600 px-6 py-2.5 text-sm font-semibold text-white hover:bg-brand-700"
      >
        Try again
      </button>
    </main>
  );
}
