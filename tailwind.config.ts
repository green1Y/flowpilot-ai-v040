import type { Config } from "tailwindcss";

const config: Config = {
  darkMode: "class",
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // FlowPilot brand palette (dark-first)
        midnight: "#0B1020",
        navy: "#11182B",
        card: "#171F35",
        violet: { DEFAULT: "#8B5CF6" },
        cyan: { DEFAULT: "#22D3EE" },
        success: "#34D399",
        warning: "#FBBF24",
        danger: "#FB7185",
        ink: "#F8FAFC",
        muted: "#94A3B8",
        // Phase D — extended tokens. Faint text + info semantic (static),
        // surfaces / lines as CSS variables so light mode overrides apply.
        faint: "#64748B",
        info: "#38BDF8",
        surface: {
          raised: "var(--fp-surface-raised)",
          overlay: "var(--fp-overlay)",
        },
        line: {
          subtle: "var(--fp-line-subtle)",
          strong: "var(--fp-line-strong)",
        },
        // Chart series palette (static hexes, shared by all charts)
        chart: {
          1: "#8B5CF6",
          2: "#22D3EE",
          3: "#2DD4BF",
          4: "#FBBF24",
          5: "#FB7185",
          6: "#818CF8",
          7: "#34D399",
          8: "#94A3B8",
        },
      },
      boxShadow: {
        glow: "0 0 24px rgba(139,92,246,0.35)",
        card: "0 8px 30px rgba(0,0,0,0.35)",
        subtle: "0 1px 3px rgba(2,6,23,0.20), 0 1px 2px rgba(2,6,23,0.12)",
      },
      borderRadius: {
        xl2: "1rem",
      },
      fontFamily: {
        sans: ["Inter", "ui-sans-serif", "system-ui", "sans-serif"],
      },
    },
  },
  plugins: [],
};

export default config;
