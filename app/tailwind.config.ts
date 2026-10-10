import type { Config } from 'tailwindcss';

// Legacy Tailwind colors resolve to the monochrome theme tokens in index.css,
// so screens still styled with utilities follow the light/dark theme.
const fg = (alpha: number): string => `rgba(var(--fg-rgb), ${String(alpha)})`;

export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      fontFamily: { sans: ['"Geist Variable"', 'Geist', 'ui-sans-serif', 'system-ui', 'sans-serif'] },
      colors: {
        gray: Object.fromEntries([50,100,200,300,400,500,600,700,800,900,950].map(n => [n, `rgb(var(--gray-${n}) / <alpha-value>)`])),
        white: 'rgb(var(--white) / <alpha-value>)',
        violet: { 50: fg(0.05), 100: fg(0.14), 500: fg(0.55), 700: 'var(--fg)', 800: 'var(--solid-hover)', 900: 'var(--fg)' },
        nj: {
          bg: 'var(--bg)',
          surface: 'var(--bg)',
          'surface-2': fg(0.05),
          border: fg(0.14),
          'border-bright': fg(0.26),
          muted: fg(0.5),
          text: 'var(--fg)',
          'text-dim': fg(0.7),
          accent: 'var(--fg)',
          'accent-bright': 'var(--fg)',
          'accent-dim': 'var(--solid-hover)',
          eligible: '#2eb86c',
          'eligible-bg': 'rgba(46, 184, 108, 0.14)',
          unclear: '#dea034',
          'unclear-bg': 'rgba(222, 160, 52, 0.14)',
          ineligible: '#e5484d',
          'ineligible-bg': 'rgba(229, 72, 77, 0.14)',
          'score-high': '#2eb86c',
          'score-mid': '#dea034',
          'score-low': '#e5484d',
          'tier-1': fg(0.9),
          'tier-2': fg(0.7),
          'tier-3': fg(0.5),
          'cat-swe': fg(0.7),
          'cat-quant': fg(0.7),
          'cat-ml': fg(0.7),
          'cat-hw': fg(0.7),
          'cat-other': fg(0.5),
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
