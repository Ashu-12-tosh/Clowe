'use client';

import { useEffect, useState } from 'react';
import { DEFAULT_LEGAL_ENTITY, legalDisplayName } from '@clowe/shared';
import { getPublicSettings } from '@/lib/settings';

/** "© 2026 Clowe Partners LLP. All rights reserved." — the legal name from settings. */
export default function LegalCopyright({ className }: { className?: string }) {
  const [name, setName] = useState(DEFAULT_LEGAL_ENTITY.name);
  useEffect(() => {
    getPublicSettings()
      .then((s) => setName(s.legalEntity.name))
      .catch(() => {});
  }, []);
  return (
    <p className={className}>
      © {new Date().getFullYear()} {legalDisplayName(name)}. All rights reserved.
    </p>
  );
}
