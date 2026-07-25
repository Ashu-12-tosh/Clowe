import type { Config } from 'tailwindcss';

const config: Config = {
  content: ['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // Clowe design system — white base, near-black ink, gold accent.
        // `brand` is the accent (gold) so existing `brand-*` classes re-skin
        // automatically; `ink` is the near-black used for nav/buttons.
        brand: {
          50: '#FBF8F1', // warm cream tint (backgrounds)
          100: '#F3EAD3', // light gold wash (active tints, badges)
          400: '#D4AF37', // bright gold (stars, highlights)
          500: '#C79A22',
          600: '#B8860B', // primary gold (CTAs, prices, links)
          700: '#96700A', // gold hover
          900: '#141414', // near-black (headings)
        },
        ink: {
          950: '#0D0D0D',
          900: '#141414', // sidebar / primary black buttons
          800: '#1F1F1F', // black button hover
          700: '#2A2A2A',
          600: '#3D3D3D',
        },
        cream: {
          50: '#FAFAF8', // page background
          100: '#F5F2EC', // product image background
          200: '#EDE8DE',
        },
      },
      fontFamily: {
        sans: ['var(--font-sans)', 'system-ui', 'sans-serif'],
        display: ['var(--font-display)', 'Georgia', 'serif'],
      },
    },
  },
  plugins: [],
};

export default config;
