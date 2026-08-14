import type { Config } from 'tailwindcss';

export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        nj: {
          bg: '#070a12',
          surface: '#0e1220',
          'surface-2': '#161c2e',
          border: '#1e2642',
          'border-bright': '#2d3a5c',
          muted: '#4e5a78',
          text: '#edf0f7',
          'text-dim': '#8892ae',

          accent: '#7c3aed',
          'accent-bright': '#a78bfa',
          'accent-dim': '#5b21b6',

          eligible: '#00e676',
          'eligible-bg': 'rgba(0, 230, 118, 0.12)',
          unclear: '#ffab00',
          'unclear-bg': 'rgba(255, 171, 0, 0.12)',
          ineligible: '#ff5252',
          'ineligible-bg': 'rgba(255, 82, 82, 0.12)',

          'score-high': '#00e676',
          'score-mid': '#ffd600',
          'score-low': '#ff5252',

          'tier-1': '#ffc400',
          'tier-2': '#448aff',
          'tier-3': '#90a4ae',

          'cat-swe': '#00e5ff',
          'cat-quant': '#ff6d00',
          'cat-ml': '#d500f9',
          'cat-hw': '#1de9b6',
          'cat-other': '#90a4ae',
        },
      },
      boxShadow: {
        'nj-glow': '0 0 20px rgba(124, 58, 237, 0.25)',
        'nj-glow-lg': '0 0 40px rgba(124, 58, 237, 0.15)',
      },
    },
  },
  plugins: [],
} satisfies Config;
