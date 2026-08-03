import type { NextConfig } from 'next';

/**
 * The security headers the browser enforces for the workspace.
 *
 * `frame-ancestors 'none'` and a nonce-based script policy are the two that matter: user
 * content is served from a separate origin so it can never inherit application privileges,
 * and no inline script means an injected `<script>` cannot run
 * (`docs/architecture/17-security-architecture.md` §6).
 *
 * The API is reached from this application's *server*, never from the browser: it returns both
 * tokens in a JSON body and this app writes them into `httpOnly`, `Secure`, `SameSite=Lax`
 * cookies. No token is ever readable by script in the page, which is the property the script
 * policy above exists to protect.
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
  // On now that the screens the shell links to actually exist. It was deferred through Phase
  // 0.5 because enabling it then would have been satisfiable only by writing placeholder pages
  // for `/login` and every other destination, and a placeholder screen is worse than an honest
  // 404: it looks finished. A link to a route that does not exist is now a build error, which
  // is what closes technical debt #3 and risk R6 together.
  typedRoutes: true,
  async headers() {
    return [{ source: '/:path*', headers: securityHeaders }];
  },
};

export default nextConfig;
