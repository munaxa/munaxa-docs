import type { MetadataRoute } from 'next';

import { brandManifest } from '@munaxa/ui';
import { en } from '@edms/i18n';

/**
 * The web app manifest — what an installed Munaxa Docs looks like on a home screen.
 *
 * Built from the brand registry rather than written out, so the installed icon is the same
 * approved app icon the tab shows and the splash colour is the same product colour the theme
 * paints. A hand-written manifest is where the corporate icon quietly outlives a product's
 * rebrand, because nothing renders it in review.
 */
export default function manifest(): MetadataRoute.Manifest {
  return brandManifest('docs', en.app.description) as MetadataRoute.Manifest;
}
