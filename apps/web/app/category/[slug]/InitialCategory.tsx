'use client';

import { createContext, useContext } from 'react';
import type { CategoryDetail } from '@clowe/shared';

/**
 * The category the server fetched with the page, so its banner and
 * subcategory row are in place on first paint (nothing pushed down when they
 * arrive). Null when the server could not fetch it: the page loads it itself.
 */
const InitialCategoryContext = createContext<CategoryDetail | null>(null);

export function InitialCategoryProvider({ value, children }: { value: CategoryDetail | null; children: React.ReactNode }) {
  return <InitialCategoryContext.Provider value={value}>{children}</InitialCategoryContext.Provider>;
}

export function useInitialCategory(slug: string): CategoryDetail | null {
  const initial = useContext(InitialCategoryContext);
  return initial?.slug === slug ? initial : null;
}
