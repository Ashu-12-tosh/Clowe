/** Map product colour names to CSS colours for swatch dots (visual only). */
const COLOR_HEX: Record<string, string> = {
  black: '#141414',
  white: '#ffffff',
  grey: '#9ca3af',
  gray: '#9ca3af',
  navy: '#1e3a5f',
  blue: '#3b82f6',
  'sky blue': '#7dd3fc',
  'light blue': '#93c5fd',
  'dark blue': '#1e40af',
  red: '#dc2626',
  maroon: '#7f1d1d',
  wine: '#722f37',
  green: '#16a34a',
  olive: '#6b8e23',
  teal: '#0d9488',
  yellow: '#eab308',
  mustard: '#d4a017',
  gold: '#D4AF37',
  orange: '#f97316',
  peach: '#fdba9c',
  pink: '#ec4899',
  purple: '#9333ea',
  lavender: '#c4b5fd',
  champagne: '#f5e6c8',
  beige: '#d9c7a7',
  brown: '#8b5e3c',
};

export function colorToHex(name: string): string | null {
  return COLOR_HEX[name.trim().toLowerCase()] ?? null;
}
