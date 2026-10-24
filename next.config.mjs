/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // v0.4.0: baseline security headers. No CSP: the App Router pages use
  // inline scripts/styles, and a strict CSP would break them — CSP stays a
  // documented follow-up, not a silent breakage.
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
        ],
      },
    ];
  },
  experimental: {
    // keep default; server actions not used heavily
    // Perf: rewrite barrel imports into per-module imports so tree-shaking
    // is robust for these heavy ESM packages (lucide-react icons are imported
    // across most app pages; recharts + @xyflow/react are page-specific).
    optimizePackageImports: ["lucide-react", "recharts", "@xyflow/react"],
  },
};

export default nextConfig;
