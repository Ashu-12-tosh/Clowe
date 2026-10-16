// ---------------------------------------------------------------------------
// PAN and GSTIN: the format rules a seller's tax IDs must meet, shared by the
// web forms (an error under the field, before anything is sent) and the API
// (the same rule, so nothing reaches the database that the form would refuse).
//
// These are local checks only. Whether the ID is real and active is the KYC
// provider's question (kyc.ts), asked later and paid for.
// ---------------------------------------------------------------------------
import { z } from 'zod';
import { GSTIN_PATTERN, PAN_PATTERN, normalizeTaxId } from './kyc';

export const PAN_EXAMPLE = 'ABCDE1234F';
/** A well-formed GSTIN built on PAN_EXAMPLE, with a correct check character. */
export const GSTIN_EXAMPLE = '29ABCDE1234F1ZW';

/** GST state codes run from 01 (Jammu & Kashmir) to 38 (Ladakh). */
export function isGstStateCode(code: string): boolean {
  if (!/^\d{2}$/.test(code)) return false;
  const n = Number(code);
  return n >= 1 && n <= 38;
}

const BASE36 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/**
 * A GSTIN's 15th character, computed from the first 14 (GSTN's base-36
 * method): each character's value is weighted 1, 2, 1, 2…; every product
 * contributes its quotient and remainder by 36; the check character brings
 * the total to a multiple of 36.
 */
export function gstinCheckChar(first14: string): string {
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    const product = BASE36.indexOf(first14[i]!) * (i % 2 === 0 ? 1 : 2);
    sum += Math.floor(product / 36) + (product % 36);
  }
  return BASE36[(36 - (sum % 36)) % 36]!;
}

/** Why a PAN is not well-formed, or null when it is. */
export function panProblem(value: string): string | null {
  const pan = normalizeTaxId(value);
  if (PAN_PATTERN.test(pan)) return null;
  return `PAN is 5 letters, 4 digits and a letter, like ${PAN_EXAMPLE}`;
}

/**
 * Why a GSTIN is not acceptable, or null when it is: 15 characters, a state
 * code from 01 to 38, the PAN in characters 3–12 (the seller's own, when
 * given), and a check character that matches.
 */
export function gstinProblem(value: string, pan?: string | null): string | null {
  const gstin = normalizeTaxId(value);
  if (gstin.length !== 15) return `GSTIN is 15 characters — this one has ${gstin.length}`;
  if (!GSTIN_PATTERN.test(gstin)) return `GSTIN looks like ${GSTIN_EXAMPLE}: state code, PAN, entity number, Z, check character`;
  if (!isGstStateCode(gstin.slice(0, 2))) return `GSTIN starts with a state code from 01 to 38, not ${gstin.slice(0, 2)}`;
  const ownPan = pan ? normalizeTaxId(pan) : '';
  if (PAN_PATTERN.test(ownPan) && gstin.slice(2, 12) !== ownPan) {
    return `Characters 3–12 of a GSTIN are its PAN — this one carries ${gstin.slice(2, 12)}, not your PAN ${ownPan}`;
  }
  if (gstinCheckChar(gstin.slice(0, 14)) !== gstin[14]) return 'This GSTIN has a typo: its last character does not match the rest';
  return null;
}

/** Spaces dropped and uppercased, then held to the rule; '' means "not given". */
function taxIdField(problem: (value: string) => string | null) {
  return z
    .string()
    .transform(normalizeTaxId)
    .superRefine((value, ctx) => {
      const message = value === '' ? null : problem(value);
      if (message) ctx.addIssue({ code: z.ZodIssueCode.custom, message });
    });
}

export const panNumberField = taxIdField(panProblem);
export const gstNumberField = taxIdField((value) => gstinProblem(value));

/**
 * For an object schema holding both: a GSTIN must carry the PAN given next to
 * it. Reported on the GSTIN field.
 */
export function gstinMatchesPan(input: { gstNumber?: string | null; panNumber?: string | null }, ctx: z.RefinementCtx) {
  if (!input.gstNumber || !input.panNumber || panProblem(input.panNumber)) return;
  // Anything else wrong with the GSTIN is already reported by its own field.
  if (gstinProblem(input.gstNumber)) return;
  const message = gstinProblem(input.gstNumber, input.panNumber);
  if (message) ctx.addIssue({ code: z.ZodIssueCode.custom, message, path: ['gstNumber'] });
}
