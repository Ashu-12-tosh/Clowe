'use client';

import { createContext, useContext } from 'react';
import type { SellerProfileInfo } from '@clowe/shared';

export type SellerState =
  | { kind: 'loading' }
  | { kind: 'logged-out' }
  | { kind: 'not-registered' }
  | { kind: 'ready'; profile: SellerProfileInfo };

export const SellerContext = createContext<{
  state: SellerState;
  reload: () => void;
}>({ state: { kind: 'loading' }, reload: () => {} });

export const useSeller = () => useContext(SellerContext);
