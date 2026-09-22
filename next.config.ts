import type { NextConfig } from "next";
let storageOrigin = "";
try {
  if (process.env.S3_ENDPOINT)
    storageOrigin = new URL(process.env.S3_ENDPOINT).origin;
} catch {
  // The storage adapter will report an invalid endpoint at runtime.
}
const config: NextConfig = {
  turbopack: { root: process.cwd() },
  serverExternalPackages: ["postgres"],
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "same-origin" },
          {
            key: "Content-Security-Policy",
            value: `default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'${storageOrigin ? ` ${storageOrigin}` : ""}; font-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'`,
          },
        ],
      },
    ];
  },
};
export default config;
