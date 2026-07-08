/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        // Surfaces / text driven by CSS variables → одинаковые классы в обеих темах
        bg: 'rgb(var(--bg) / <alpha-value>)',
        surface: 'rgb(var(--surface) / <alpha-value>)',
        elevated: 'rgb(var(--elevated) / <alpha-value>)',
        line: 'rgb(var(--line) / <alpha-value>)',
        fg: 'rgb(var(--fg) / <alpha-value>)',
        muted: 'rgb(var(--muted) / <alpha-value>)',
        faint: 'rgb(var(--faint) / <alpha-value>)',

        // spark — основной неоновый бренд (emerald→lime, "энергия инкубатора")
        spark: {
          50: '#effef4',
          100: '#d9ffe6',
          200: '#b4f9cf',
          300: '#77efab',
          400: '#34de83',
          500: '#0ec464',
          600: '#04a052',
          700: '#067d44',
          800: '#0a6239',
          900: '#0a5131',
        },
        // iris — вторичный (AI-фиолет)
        iris: {
          50: '#f2f1ff',
          100: '#e7e5ff',
          200: '#d1cdff',
          300: '#b1a8ff',
          400: '#8f78ff',
          500: '#7145ff',
          600: '#6427f5',
          700: '#5518d8',
          800: '#4716af',
          900: '#3c168f',
        },
      },
      opacity: {
        3: '0.03',
        5: '0.05',
        8: '0.08',
        12: '0.12',
        15: '0.15',
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', '-apple-system', 'Segoe UI', 'Roboto', 'sans-serif'],
        display: ['"Space Grotesk"', 'Inter', 'system-ui', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'ui-monospace', 'SFMono-Regular', 'monospace'],
      },
      boxShadow: {
        card: '0 1px 2px rgba(0,0,0,0.24), 0 8px 24px -12px rgba(0,0,0,0.5)',
        pop: '0 24px 60px -18px rgba(0,0,0,0.6)',
        'spark-glow': '0 0 0 1px rgba(14,196,100,0.35), 0 8px 32px -8px rgba(14,196,100,0.4)',
        'iris-glow': '0 0 0 1px rgba(113,69,255,0.35), 0 8px 32px -8px rgba(113,69,255,0.4)',
      },
      borderRadius: {
        xl: '0.9rem',
        '2xl': '1.25rem',
        '3xl': '1.75rem',
      },
      keyframes: {
        'fade-in': {
          '0%': { opacity: '0', transform: 'translateY(6px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        'scale-in': {
          '0%': { opacity: '0', transform: 'scale(0.96)' },
          '100%': { opacity: '1', transform: 'scale(1)' },
        },
        shimmer: { '100%': { transform: 'translateX(100%)' } },
        'pulse-ring': {
          '0%': { boxShadow: '0 0 0 0 rgba(14,196,100,0.5)' },
          '70%': { boxShadow: '0 0 0 8px rgba(14,196,100,0)' },
          '100%': { boxShadow: '0 0 0 0 rgba(14,196,100,0)' },
        },
        float: {
          '0%,100%': { transform: 'translateY(0)' },
          '50%': { transform: 'translateY(-6px)' },
        },
      },
      animation: {
        'fade-in': 'fade-in 0.24s ease-out',
        'scale-in': 'scale-in 0.16s ease-out',
        'pulse-ring': 'pulse-ring 1.8s infinite',
        float: 'float 6s ease-in-out infinite',
      },
      backgroundImage: {
        'grid-dark':
          'radial-gradient(rgba(255,255,255,0.035) 1px, transparent 1px)',
        'spark-gradient': 'linear-gradient(135deg, #0ec464 0%, #34de83 55%, #a3e635 100%)',
        'iris-gradient': 'linear-gradient(135deg, #7145ff 0%, #8f78ff 100%)',
      },
    },
  },
  plugins: [],
}
