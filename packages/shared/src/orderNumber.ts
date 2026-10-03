/**
 * Order numbers.
 *
 * New orders get "CLW-" and 10 random characters from an alphabet without
 * look-alikes (no 0/O, no 1/I/L), e.g. CLW-7KQ3MX9P2T. Orders placed before
 * this format keep their numbers, CLW-<year>-<6 digits>, and both kinds are
 * accepted everywhere an order number is typed in.
 */

export const ORDER_NUMBER_PREFIX = 'CLW-';
export const ORDER_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const ORDER_CODE_LENGTH = 10;

/** An order number in either format, any letter case. */
export const ORDER_NUMBER_PATTERN = new RegExp(
  `^${ORDER_NUMBER_PREFIX}(?:\\d{4}-\\d{6}|[${ORDER_CODE_ALPHABET}]{${ORDER_CODE_LENGTH}})$`,
  'i',
);

/**
 * A new order number from `pick(n)`, which returns a random whole number
 * from 0 to n - 1 (the API passes a cryptographic one).
 */
export function newOrderNumber(pick: (n: number) => number): string {
  let code = '';
  for (let i = 0; i < ORDER_CODE_LENGTH; i++) code += ORDER_CODE_ALPHABET[pick(ORDER_CODE_ALPHABET.length)];
  return `${ORDER_NUMBER_PREFIX}${code}`;
}
