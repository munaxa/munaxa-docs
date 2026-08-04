/**
 * Drawing a thumbnail, in the one format Phase 3 can draw one for.
 *
 * The scope is deliberately small and worth stating plainly: **raster images only, and by
 * downscaling rather than decoding.** A PDF's first page, an Office document's cover and a DWG's
 * viewport all need a renderer — a PDF engine, a headless office suite, a CAD library — and every
 * one of those is a sandboxed subprocess with CPU, memory and time caps, a plugin registry, and a
 * failure story. That is Phase 7, it is a phase's worth of work, and building a fraction of it here
 * would mean building the fraction that has no sandbox.
 *
 * So Phase 3 produces a thumbnail for the formats where "thumbnail" is a size change, and produces
 * nothing for the rest. A document with no thumbnail renders its format's icon, which is what the
 * library shows for a Word document either way.
 *
 * ### Why the encoder is written out
 *
 * `sharp` is the obvious answer and is deliberately not used. It is a native binding: a
 * platform-specific binary that has to build or download per architecture, which turns a `pnpm
 * install` on a machine without a prebuilt into a compile, and which is exactly the kind of
 * dependency an on-premise customer's air-gapped installer meets badly. What is needed here is one
 * operation on one format family, and a box-filter downscale to a PNG is a hundred lines of
 * arithmetic with no dependency at all.
 *
 * The trade is real and it is recorded rather than hidden: this decodes PNG only, and every other
 * raster format falls through to no thumbnail until Phase 7 brings a renderer that handles them
 * properly. A JPEG decoder written by hand would be the wrong trade in the other direction.
 */

/** The longest edge of a generated thumbnail. Bigger than a grid cell, smaller than a preview. */
export const THUMBNAIL_MAX_EDGE = 320;

/**
 * A decoded image: straight RGBA, one byte per channel, row-major.
 *
 * Deliberately the simplest possible representation. Everything below operates on it, so a decoder
 * for another format added later has one thing to produce.
 */
export interface RasterImage {
  readonly width: number;
  readonly height: number;
  /** `width * height * 4` bytes, RGBA. */
  readonly pixels: Uint8Array;
}

/**
 * The size a thumbnail should be, preserving the aspect ratio.
 *
 * Never upscales. A 64-pixel icon blown up to 320 is a blurry 64-pixel icon that also costs
 * twenty-five times the storage, and the grid renders it at its natural size either way.
 */
export function thumbnailSizeFor(
  width: number,
  height: number,
  maxEdge = THUMBNAIL_MAX_EDGE,
): { readonly width: number; readonly height: number } {
  if (width <= 0 || height <= 0) {
    throw new Error('An image has a positive width and height.');
  }
  const longest = Math.max(width, height);
  if (longest <= maxEdge) {
    return { width, height };
  }
  const scale = maxEdge / longest;
  // At least one pixel on each edge: a 4000×3 panorama scaled by 0.08 would otherwise round its
  // height to zero and produce an image with no rows.
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

/**
 * Downscales by averaging the source pixels each destination pixel covers.
 *
 * A box filter rather than nearest-neighbour sampling, and the difference is visible rather than
 * academic: a scanned page reduced by picking every eighth pixel turns its text into aliased noise,
 * while averaging turns it into grey — which is what a thumbnail of a page should look like.
 *
 * Alpha is averaged with the colour channels rather than premultiplied. For the images this
 * actually meets — scans, photographs, screenshots, logos — the difference appears only on edges of
 * transparency, and premultiplying correctly would mean carrying a colour space through the whole
 * function for a case a document library barely has.
 */
export function downscale(
  image: RasterImage,
  target: { readonly width: number; readonly height: number },
): RasterImage {
  const pixels = new Uint8Array(target.width * target.height * 4);
  const xRatio = image.width / target.width;
  const yRatio = image.height / target.height;

  for (let y = 0; y < target.height; y += 1) {
    const fromY = Math.floor(y * yRatio);
    const toY = Math.max(fromY + 1, Math.floor((y + 1) * yRatio));
    for (let x = 0; x < target.width; x += 1) {
      const fromX = Math.floor(x * xRatio);
      const toX = Math.max(fromX + 1, Math.floor((x + 1) * xRatio));

      let red = 0;
      let green = 0;
      let blue = 0;
      let alpha = 0;
      let counted = 0;
      for (let sourceY = fromY; sourceY < toY && sourceY < image.height; sourceY += 1) {
        for (let sourceX = fromX; sourceX < toX && sourceX < image.width; sourceX += 1) {
          const offset = (sourceY * image.width + sourceX) * 4;
          red += image.pixels[offset] ?? 0;
          green += image.pixels[offset + 1] ?? 0;
          blue += image.pixels[offset + 2] ?? 0;
          alpha += image.pixels[offset + 3] ?? 0;
          counted += 1;
        }
      }

      const offset = (y * target.width + x) * 4;
      const divisor = counted === 0 ? 1 : counted;
      pixels[offset] = Math.round(red / divisor);
      pixels[offset + 1] = Math.round(green / divisor);
      pixels[offset + 2] = Math.round(blue / divisor);
      pixels[offset + 3] = counted === 0 ? 255 : Math.round(alpha / divisor);
    }
  }

  return { width: target.width, height: target.height, pixels };
}
