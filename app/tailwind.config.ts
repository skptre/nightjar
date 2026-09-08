import type { Config } from 'tailwindcss';

export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        gray: Object.fromEntries([50,100,200,300,400,500,600,700,800,900,950].map(n => [n, `rgb(var(--gray-${n}) / <alpha-value>)`])),
        white: 'rgb(var(--white) / <alpha-value>)',
        violet: { 50: 'var(--surface-2)', 100: 'var(--border)', 500: 'var(--muted)', 700: 'var(--action-solid)', 800: 'var(--action-hover)', 900: 'var(--text)' },
        nj: {
          bg: '#171717',
          surface: '#1c1c1b',
          'surface-2': '#242423',
          border: '#30302e',
          'border-bright': '#454540',
          muted: '#989891',
          text: '#edede7',
          'text-dim': '#aeaea5',

          accent: '#65783c',
          'accent-bright': '#d5ea97',
          'accent-dim': '#52632f',

          eligible: '#accb93',
          'eligible-bg': 'rgba(0, 230, 118, 0.12)',
          unclear: '#d4b57e',
          'unclear-bg': 'rgba(255, 171, 0, 0.12)',
          ineligible: '#db9992',
          'ineligible-bg': 'rgba(255, 82, 82, 0.12)',

          'score-high': '#accb93',
          'score-mid': '#d4b57e',
          'score-low': '#db9992',

          'tier-1': '#d4b57e',
          'tier-2': '#aab9c3',
          'tier-3': '#a9aaa2',

          'cat-swe': '#b6bdb0',
          'cat-quant': '#b6bdb0',
          'cat-ml': '#b6bdb0',
          'cat-hw': '#b6bdb0',
          'cat-other': '#a9aaa2',
        },
      },
      boxShadow: {
        'nj-glow': '0 0 20px rgba(0, 0, 0, 0.2)',
        'nj-glow-lg': '0 0 40px rgba(0, 0, 0, 0.15)',
      },
    },
  },
  plugins: [],
} satisfies Config;
