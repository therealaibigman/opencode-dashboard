import type { Config } from 'tailwindcss';

export default {
  darkMode: ['class'],
  content: ['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        bg: {
          DEFAULT: '#05070a',
          2: '#070b10'
        },
        matrix: {
          50: '#e9ffee',
          100: '#c9ffd6',
          200: '#93ffad',
          300: '#4dff7b',
          400: '#18ff52',
          500: '#00e63a',
          600: '#00b82e',
          700: '#008a22',
          800: '#006317',
          900: '#003b0c'
        }
      },
      boxShadow: {
        neon: '0 0 0 1px rgba(0, 230, 58, 0.35), 0 0 30px rgba(0, 230, 58, 0.15)'
      }
    }
  },
  plugins: []
} satisfies Config;
