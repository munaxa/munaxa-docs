import { TEXT_DIRECTION, isLocale } from '@edms/i18n';

/**
 * The HTML envelope an email body is wrapped in — 18 §6's "tenant branding" and "RTL email
 * layouts", in the one place raw hexes are permitted.
 *
 * ## Why the hexes arrive as arguments
 *
 * §6 names `platform/themes/docs/brand.ts` as their source, and this file does not import it.
 * The API depends on no `@munaxa/*` package: it renders no UI, and adding the design system to a
 * NestJS process to read four strings would put a React peer dependency in the API's tree to
 * avoid passing four arguments. So the values arrive as a `Branding` record, resolved by the
 * caller from the settings catalogue — whose defaults *are* the Docs brand, recorded there with
 * their provenance. A tenant that sets its own colour and logo gets them, which is what "tenant
 * branding" means and what importing a fixed module could not have given.
 *
 * ## Why the layout is tables and inline styles
 *
 * Because mail clients are not browsers. Outlook's rendering engine is Word's, Gmail strips
 * `<style>` blocks it dislikes, and no client can be relied on for flexbox, grid or a stylesheet.
 * A single-column table with inline styles is the only layout that renders the same in all of
 * them, and it has been for twenty years.
 *
 * ## RTL is a document direction, not a stylesheet
 *
 * `dir="rtl"` on the `<html>` element and `direction: rtl; text-align: right` on the container.
 * That is the whole of it: the layout is one column, so there is no mirroring to do beyond the
 * text direction itself — which is the reason it is one column.
 */

/** The raw values a semantic palette has no slot for, per 18 §6. */
export interface Branding {
  /** The product or tenant name in the header and the footer. */
  readonly name: string;
  /** Primary brand hex, `#RRGGBB`. Validated where it is stored. */
  readonly color: string;
  /** An absolute URL to a logo, or null for a wordmark rendered as text. */
  readonly logoUrl: string | null;
}

const INK = '#101828';
const MUTED = '#667085';
const SURFACE = '#F2F4F7';
const PAPER = '#FFFFFF';

/**
 * Wraps a rendered HTML body in the product's email layout.
 *
 * The body is inserted **as it was rendered** — its values were already escaped by the renderer,
 * and re-escaping here would show a person `&amp;lt;`. Nothing in this function substitutes,
 * evaluates or interprets: it concatenates.
 */
export function wrapEmailHtml(
  bodyHtml: string,
  options: { readonly locale: string; readonly branding: Branding; readonly preheader: string },
): string {
  // Unknown locales read left to right, because English is the fallback everything else takes.
  const dir = isLocale(options.locale) ? TEXT_DIRECTION[options.locale] : 'ltr';
  const rtl = dir === 'rtl';
  const align = rtl ? 'right' : 'left';
  const { branding } = options;

  const masthead = branding.logoUrl
    ? `<img src="${attribute(branding.logoUrl)}" alt="${attribute(branding.name)}" height="32" style="display:block;border:0;height:32px" />`
    : `<span style="font:600 18px/1.2 Helvetica,Arial,sans-serif;color:${attribute(PAPER)}">${text(branding.name)}</span>`;

  return [
    `<!DOCTYPE html><html lang="${attribute(options.locale)}" dir="${dir}">`,
    '<head><meta charset="utf-8" /><meta name="viewport" content="width=device-width,initial-scale=1" />',
    `<title>${text(options.preheader)}</title></head>`,
    `<body style="margin:0;padding:0;background:${attribute(SURFACE)};direction:${dir}">`,
    // The preheader: what a mail client shows beside the subject in a list. Hidden in the body
    // itself, because a person who has opened the message does not need to read the subject twice.
    `<div style="display:none;max-height:0;overflow:hidden;opacity:0">${text(options.preheader)}</div>`,
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${attribute(SURFACE)}">`,
    '<tr><td align="center" style="padding:24px 12px">',
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;width:100%">',
    `<tr><td style="background:${attribute(branding.color)};padding:20px 24px;border-radius:8px 8px 0 0;text-align:${align}">${masthead}</td></tr>`,
    `<tr><td style="background:${attribute(PAPER)};padding:24px;font:400 15px/1.6 Helvetica,Arial,sans-serif;color:${attribute(INK)};text-align:${align};direction:${dir}">`,
    bodyHtml,
    '</td></tr>',
    `<tr><td style="padding:16px 24px;font:400 12px/1.5 Helvetica,Arial,sans-serif;color:${attribute(MUTED)};text-align:${align};direction:${dir}">`,
    `${text(branding.name)}`,
    '</td></tr></table></td></tr></table></body></html>',
  ].join('');
}

/**
 * Escapes a value going into an attribute.
 *
 * Every caller here passes a value from configuration rather than from a user, and it is escaped
 * anyway: a tenant administrator setting a logo URL is a person who can edit configuration, not a
 * person who should be able to inject markup into everybody else's mail.
 */
function attribute(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');
}

function text(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}
