import { panFromGstin } from './kyc';
/**
 * The version of the Terms and Conditions of Use and the Privacy Policy a
 * person accepts when they sign in ("By continuing you confirm you are 18+
 * and agree to…"). Stored on the account; change it when either document
 * changes in a way that needs accepting again.
 */
export const TERMS_VERSION = '2026-10-16';

/**
 * The version of the Vendor Terms and Seller Agreement (with the Terms and
 * Conditions and the Privacy Policy) a seller accepts — the document's "last
 * updated" date. Raise it when the document changes in a way that needs
 * accepting again: every seller is then asked once more on their next visit.
 */
export const VENDOR_TERMS_VERSION = '2026-10-21';

export const VENDOR_TERMS_ACCEPT_TEXT =
  'I have read and accept the Vendor Terms & Seller Agreement, the Terms & Conditions and the Privacy Policy';

/**
 * The legal entity behind the site — what payment gateways (Cashfree) check
 * the website for. Admin-editable platform settings, never hard-coded on a
 * page: the footer, Contact Us, About and every policy page read them.
 *
 * An empty field is hidden wherever it would appear, never shown blank.
 */
export interface LegalEntity {
  /** As registered, e.g. "CLOWE PARTNERS LLP". Always set. */
  name: string;
  registeredAddress: string;
  /** LLP Identification Number, e.g. "ACB-1234". */
  llpin: string;
  gstin: string;
  supportEmail: string;
  supportPhone: string;
  /** A second public number (shown beside the first). */
  supportPhoneAlt: string;
}

export const DEFAULT_LEGAL_ENTITY: LegalEntity = {
  name: 'CLOWE PARTNERS LLP',
  registeredAddress: '',
  llpin: '',
  gstin: '',
  supportEmail: '',
  supportPhone: '',
  supportPhoneAlt: '',
};

/** Words that stay in capitals when a registered name is shown in title case. */
const KEEP_UPPER = new Set(['LLP', 'LLC', 'LTD', 'PVT', 'OPC', 'INC', 'PLC', 'AI', 'IT']);

/**
 * The name for running text: "CLOWE PARTNERS LLP" → "Clowe Partners LLP".
 * A name already in mixed case is the admin's own styling and is kept.
 */
export function legalDisplayName(name: string): string {
  if (/[a-z]/.test(name)) return name;
  return name
    .split(/(\s+)/)
    .map((word) =>
      KEEP_UPPER.has(word.replace(/[^A-Z]/g, '')) || !/[A-Z]/.test(word)
        ? word
        : word.charAt(0) + word.slice(1).toLowerCase(),
    )
    .join('');
}

/** Suffixes of a registered name and the entity type they mean, longest first. */
const ENTITY_TYPES: [RegExp, string][] = [
  [/\bLLP$/i, 'Limited Liability Partnership (LLP)'],
  [/\b(PRIVATE|PVT\.?) (LIMITED|LTD\.?)$/i, 'Private Limited Company'],
  [/\b(LIMITED|LTD\.?)$/i, 'Public Limited Company'],
];

/**
 * The kind of entity, read off the registered name: "CLOWE PARTNERS LLP" →
 * "Limited Liability Partnership (LLP)". Empty when the name does not say.
 */
export function legalEntityType(name: string): string {
  const trimmed = name.trim();
  return ENTITY_TYPES.find(([suffix]) => suffix.test(trimmed))?.[1] ?? '';
}

const TOKEN = /\{\{legal\.(name|displayName|entityType|registeredAddress|llpin|gstin|pan|supportEmail|supportPhoneAlt|supportPhone)\}\}/g;

/**
 * Fill {{legal.*}} tokens in a policy page's markdown. A line naming a field
 * that is empty is dropped whole, so "GSTIN: {{legal.gstin}}" disappears
 * rather than reading "GSTIN: ". Values are admin-typed: anything the page's
 * markdown would read as formatting or a link is taken out first.
 */
export function fillLegalEntity(markdown: string, legal: LegalEntity | null | undefined): string {
  const entity = { ...DEFAULT_LEGAL_ENTITY, ...(legal ?? {}) };
  const values: Record<string, string> = {
    ...entity,
    displayName: legalDisplayName(entity.name),
    entityType: legalEntityType(entity.name),
    pan: panFromGstin(entity.gstin) ?? '',
  };
  // A multi-line address reads as one line, without doubling a comma the line already ends with.
  const clean = (v: string) => v.replace(/[[\]*`]/g, '').replace(/\s*,?\s*\n\s*/g, ', ').trim();
  return markdown
    .split('\n')
    .flatMap((line) => {
      let empty = false;
      const filled = line.replace(TOKEN, (_m, key: string) => {
        const value = clean(values[key] ?? '');
        if (!value) empty = true;
        return value;
      });
      return empty ? [] : [filled];
    })
    .join('\n');
}

