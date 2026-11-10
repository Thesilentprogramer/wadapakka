/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      fontFamily: { sans: ['Inter', 'sans-serif'], display: ['Inter', 'sans-serif'] },
      colors: {
        bg: '#eef2f8', surface: '#ffffff', ink: '#0b0b0f', muted: '#596579',
        primary: '#176be6', 'primary-deep': '#174fc4',
        amber: '#ad6900', confirmed: '#168246', interrupted: '#d83b46',
      },
    },
  },
  plugins: [],
}
