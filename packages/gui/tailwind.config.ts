import type { Config } from 'tailwindcss';

const config: Config = {
  darkMode: 'class',
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // M3-style surface tokens — Technical Precision palette.
        surface: {
          DEFAULT: '#10131a',
          dim: '#10131a',
          bright: '#363941',
        },
        'surface-container': {
          lowest: '#0b0e15',
          low: '#191b23',
          DEFAULT: '#1d2027',
          high: '#272a31',
          highest: '#32353c',
        },
        'on-surface': {
          DEFAULT: '#e1e2ec',
          variant: '#c2c6d6',
        },
        outline: {
          DEFAULT: '#8c909f',
          variant: '#424754',
        },
        primary: {
          DEFAULT: '#adc6ff',
          container: '#4d8eff',
          on: '#002e6a',
          'on-container': '#00285d',
        },
        secondary: {
          DEFAULT: '#b9c8de',
          container: '#39485a',
          on: '#233143',
          'on-container': '#a7b6cc',
        },
        tertiary: {
          DEFAULT: '#ffb786',
          container: '#df7412',
          on: '#502400',
          'on-container': '#461f00',
        },
        error: {
          DEFAULT: '#ffb4ab',
          container: '#93000a',
          on: '#690005',
          'on-container': '#ffdad6',
        },

        // Back-compat aliases: existing pages still use these names.
        // Map them onto the new palette so the rest of the app keeps rendering.
        bg: {
          DEFAULT: '#10131a',
          elevated: '#1d2027',
          subtle: '#272a31',
        },
        fg: {
          DEFAULT: '#e1e2ec',
          muted: '#c2c6d6',
          subtle: '#8c909f',
        },
        border: {
          DEFAULT: '#424754',
        },
        accent: {
          DEFAULT: '#adc6ff',
          hover: '#4d8eff',
        },
        danger: {
          DEFAULT: '#ffb4ab',
        },
      },
      fontFamily: {
        sans: [
          'var(--font-sans)',
          'ui-sans-serif',
          'system-ui',
          '-apple-system',
          'Segoe UI',
          'sans-serif',
        ],
        display: ['var(--font-display)', 'var(--font-sans)', 'ui-sans-serif', 'sans-serif'],
        mono: ['var(--font-mono)', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
      // Documented layering scale (spec §3.6) — replaces scattered z-* literals
      // for every new overlay/nav/toast layer. Use the tokens (z-overlay,
      // z-backdrop, …) rather than raw numbers going forward.
      zIndex: {
        sticky: '30',
        nav: '40',
        backdrop: '50',
        overlay: '60',
        popover: '70',
        toast: '80',
        tooltip: '90',
      },
      fontSize: {
        'label-caps': ['11px', { lineHeight: '16px', letterSpacing: '0.05em', fontWeight: '600' }],
      },
      borderRadius: {
        sm: '0.125rem',
        DEFAULT: '0.25rem',
        md: '0.375rem',
        lg: '0.5rem',
        xl: '0.75rem',
      },
      spacing: {
        sidebar: '260px',
        topbar: '56px',
      },
      boxShadow: {
        ambient: '0 8px 24px rgba(0, 0, 0, 0.5)',
        'focus-primary': '0 0 0 3px rgba(173, 198, 255, 0.18)',
      },
    },
  },
};

export default config;
