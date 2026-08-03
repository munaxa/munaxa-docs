import type { NextConfig } from 'next';

/**
 * The security headers the browser enforces for the workspace.
 *
 * `frame-ancestors 'none'` and a nonce-based script policy are the two that matter: user
 * content is served from a separate origin so it can never inherit application privileges,
 * and no inline script means an injected `<script>` cannot run
 * (`docs/architecture/17-security-architecture.md` §6).
 *
 * The API is reached over CORS with a bearer token; only the rotating refresh cookie is set
 * by this app's route handlers, and it is `httpOnly`, `Secure`, `SameSite=Lax`.
 */
const securityHeaders = [
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'X-Frame-Options', value: 'DENY' },
  {
    key: 'Permissions-Policy',
    value: 'accelerometer=(), camera=(), geolocation=(), gyroscope=(), microphone=(), payment=()',
  },
  {
    key: 'Strict-Transport-Security',
    value: 'max-age=63072000; includeSubDomains; preload',
  },
];

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  transpilePackages: ['@munaxa/ui', '@munaxa/platform', '@munaxa/icons'],
  // Typed routes are switched on by the phase that adds the first screens. Enabling them now
  // would only be satisfiable by writing placeholder pages for `/login` and every other
  // destination the shell already knows about, and a placeholder screen is worse than an
  // honest 404: it looks finished. Recorded in docs/reports/phase-0.5-technical-debt.md.
  experimental: {
    typedRoutes: false,
  },
  async headers() {
    return [{ source: '/:path*', headers: securityHeaders }];
  },
};

export default nextConfig;
