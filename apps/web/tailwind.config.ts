import type { Config } from 'tailwindcss';

const config: Config = {
  content: ['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // Clowe brand palette — refined in later phases.
        brand: {
          50: '#f4f6ff',
          100: '#e8ecff',
          500: '#4f5dff',
          600: '#3d49e6',
          900: '#1e2470',
        },
      },
    },
  },
  plugins: [],
};

export default config;
