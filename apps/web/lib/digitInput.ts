/**
 * What one box of a PIN/OTP row holds after an input event, as a pure step.
 *
 * A box can receive more than the one digit typed: a password manager or SMS
 * autofill puts the whole code in the first box, a paste lands wherever the
 * cursor is, and some Android keyboards ignore maxLength, so typing over a
 * filled box arrives as "old + new". Keeping only the last character (as the
 * login page used to) turned an autofilled "1234" into "4" — a PIN that then
 * read as wrong (pre-launch audit 2026-10-20, D2).
 */
export function applyDigitInput(
  value: string,
  index: number,
  typed: string,
  length: number,
  previousBoxValue = value[index] ?? '',
): { value: string; focus: number } {
  let digits = typed.replace(/\D/g, '');
  if (!digits) {
    // Cleared this box.
    return { value: value.slice(0, index) + value.slice(index + 1), focus: index };
  }
  // A whole code: it is the code, wherever it landed.
  if (digits.length >= length) return { value: digits.slice(0, length), focus: length - 1 };
  // Typed over a filled box on a keyboard that ignores maxLength: the new digit.
  if (digits.length === 2 && previousBoxValue && digits.startsWith(previousBoxValue)) digits = digits.slice(1);
  const next = (value.slice(0, index) + digits + value.slice(index + digits.length)).slice(0, length);
  return { value: next, focus: Math.min(index + digits.length, length - 1) };
}
