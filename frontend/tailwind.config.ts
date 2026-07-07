import type { Config } from "tailwindcss";

/**
 * Waypoint design tokens. `wp-*` colors are consumed via Tailwind utilities
 * like `bg-wp-red` or `text-wp-slate`. Swap the hex values here to rebrand
 * without touching component code.
 */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        wp: {
          red: "#E01F2D",
          "red-dark": "#B0141F",
          ink: "#101828",
          slate: "#475467",
          stone: "#EAECF0",
          bg: "#F8F9FB",
          accent: "#F26E22",
        },
        health: {
          red: "#DC2626",
          yellow: "#EAB308",
          green: "#16A34A",
          white: "#E5E7EB",
        },
      },
      fontFamily: {
        sans: [
          "-apple-system", "BlinkMacSystemFont", "Segoe UI", "Roboto",
          "Helvetica Neue", "Arial", "sans-serif",
        ],
      },
    },
  },
  plugins: [],
} satisfies Config;
