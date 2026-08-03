import type { HelmetOptions } from 'helmet';

/**
 * Response security headers.
 *
 * The API serves JSON only, so its own CSP can be maximally restrictive — the web app ships
 * its own nonce-based policy, and user content is served from a separate origin so it can
 * never inherit application privileges
 * (`docs/architecture/17-security-architecture.md` §5–6).
 */
export const helmetOptions: HelmetOptions = {
  contentSecurityPolicy: {
    useDefaults: false,
    directives: {
      'default-src': ["'none'"],
      'frame-ancestors': ["'none'"],
      'base-uri': ["'none'"],
      'form-action': ["'none'"],
    },
  },
  crossOriginResourcePolicy: { policy: 'same-site' },
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
  // 2 years, preloadable. Set at the edge as well; duplicated here so a direct-to-origin
  // deployment is not silently weaker than one behind the CDN.
  strictTransportSecurity: { maxAge: 63_072_000, includeSubDomains: true, preload: true },
  xContentTypeOptions: true,
  xFrameOptions: { action: 'deny' },
  xPoweredBy: false,
};

/** Permissions-Policy: everything off. The API has no use for a camera. */
export const PERMISSIONS_POLICY =
  'accelerometer=(), camera=(), geolocation=(), gyroscope=(), microphone=(), payment=(), usb=()';
