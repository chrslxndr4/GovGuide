export default {
  content: ['./src/**/*.{astro,html,js,jsx,ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // Core civic palette — refined for a polished, data-dashboard aesthetic
        civic: {
          navy:    '#1B2A4A',
          'navy-dark': '#111C33',
          'navy-light': '#243659',
          blue:    '#2563EB',
          'blue-hover': '#1D4ED8',
          'blue-muted': '#EFF6FF',
          red:     '#DC2626',
          gold:    '#D97706',
          slate:   '#475569',
          light:   '#F8FAFC',
        },

        // Granular grays for data-dense UIs — used for surfaces, borders, and text hierarchy
        surface: {
          DEFAULT: '#FFFFFF',
          50:  '#F8FAFC',   // page background
          100: '#F1F5F9',   // section alt / table stripe
          200: '#E2E8F0',   // card background
          300: '#CBD5E1',   // divider
        },

        border: {
          DEFAULT: '#E2E8F0',
          strong:  '#CBD5E1',
          focus:   '#2563EB',
        },

        muted: {
          DEFAULT: '#64748B',
          light:   '#94A3B8',
          xlight:  '#CBD5E1',
        },

        // Semantic data colors — green/red for positive/negative values
        positive: {
          DEFAULT: '#16A34A',
          light:   '#DCFCE7',
          dark:    '#15803D',
        },
        negative: {
          DEFAULT: '#DC2626',
          light:   '#FEE2E2',
          dark:    '#B91C1C',
        },
        warning: {
          DEFAULT: '#D97706',
          light:   '#FEF3C7',
          dark:    '#B45309',
        },
      },

      fontFamily: {
        sans:    ['Inter', 'system-ui', 'sans-serif'],
        display: ['Plus Jakarta Sans', 'system-ui', 'sans-serif'],
        mono:    ['JetBrains Mono', 'monospace'],
      },

      fontSize: {
        // Tight numeric sizing for dense data tables
        'data-xs': ['0.6875rem', { lineHeight: '1rem' }],   // 11px
        'data-sm': ['0.75rem',   { lineHeight: '1.125rem' }], // 12px
        'data':    ['0.8125rem', { lineHeight: '1.25rem' }],  // 13px
      },

      boxShadow: {
        // Subtle elevation — QuiverQuant uses thin borders + minimal shadow, not heavy drop shadows
        card:   '0 1px 3px 0 rgb(0 0 0 / 0.06), 0 1px 2px -1px rgb(0 0 0 / 0.04)',
        'card-hover': '0 4px 12px 0 rgb(0 0 0 / 0.08), 0 2px 4px -1px rgb(0 0 0 / 0.04)',
        modal:  '0 8px 32px 0 rgb(0 0 0 / 0.12), 0 2px 8px -2px rgb(0 0 0 / 0.08)',
        inset:  'inset 0 1px 2px 0 rgb(0 0 0 / 0.05)',
      },

      borderRadius: {
        card: '0.5rem',   // 8px — matches QuiverQuant card rounding
      },

      spacing: {
        // Named spacing tokens for consistent layout
        'section':    '3rem',
        'section-sm': '1.5rem',
        'card-pad':   '1.25rem',
      },

      transitionDuration: {
        fast: '120ms',
      },
    },
  },
  plugins: [],
};
