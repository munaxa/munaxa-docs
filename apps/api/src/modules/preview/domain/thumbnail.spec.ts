import { describe, expect, it } from 'vitest';

import { MAX_DECODED_PIXELS, decodePng, encodePng } from './png';
import { THUMBNAIL_MAX_EDGE, downscale, thumbnailSizeFor } from './thumbnail';

/** A solid rectangle, as RGBA. */
function solid(width: number, height: number, rgba: readonly number[]): Uint8Array {
  const pixels = new Uint8Array(width * height * 4);
  for (let index = 0; index < width * height; index += 1) {
    pixels.set(rgba, index * 4);
  }
  return pixels;
}

/** Left half one colour, right half another — so a downscale has something to average. */
function halves(width: number, height: number): Uint8Array {
  const pixels = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      pixels.set(x < width / 2 ? [0, 0, 0, 255] : [255, 255, 255, 255], (y * width + x) * 4);
    }
  }
  return pixels;
}

describe('thumbnailSizeFor', () => {
  it('fits the longest edge to the ceiling and keeps the ratio', () => {
    expect(thumbnailSizeFor(1600, 900)).toEqual({ width: 320, height: 180 });
    expect(thumbnailSizeFor(900, 1600)).toEqual({ width: 180, height: 320 });
  });

  it('never upscales — a small icon stays its own size', () => {
    // Blowing a 64-pixel icon up to 320 is a blurry 64-pixel icon that costs twenty-five times the
    // storage, and the grid renders it at its natural size either way.
    expect(thumbnailSizeFor(64, 64)).toEqual({ width: 64, height: 64 });
    expect(thumbnailSizeFor(THUMBNAIL_MAX_EDGE, 10)).toEqual({
      width: THUMBNAIL_MAX_EDGE,
      height: 10,
    });
  });

  it('keeps at least one pixel on each edge for an extreme aspect ratio', () => {
    // A 4000×3 panorama scaled by 0.08 rounds its height to zero, and an image with no rows is not
    // an image.
    expect(thumbnailSizeFor(4000, 3).height).toBe(1);
  });

  it('refuses an image with no area', () => {
    expect(() => thumbnailSizeFor(0, 100)).toThrow();
    expect(() => thumbnailSizeFor(100, -1)).toThrow();
  });
});

describe('downscale', () => {
  it('produces exactly the requested size', () => {
    const image = { width: 100, height: 50, pixels: solid(100, 50, [10, 20, 30, 255]) };
    const scaled = downscale(image, { width: 20, height: 10 });
    expect(scaled.width).toBe(20);
    expect(scaled.height).toBe(10);
    expect(scaled.pixels.length).toBe(20 * 10 * 4);
  });

  it('preserves a solid colour exactly', () => {
    const image = { width: 64, height: 64, pixels: solid(64, 64, [200, 100, 50, 255]) };
    const scaled = downscale(image, { width: 8, height: 8 });
    expect([...scaled.pixels.subarray(0, 4)]).toEqual([200, 100, 50, 255]);
  });

  it('averages rather than sampling, so text becomes grey instead of noise', () => {
    // A 2×1 downscale of a half-black half-white image samples to pure black and pure white under
    // nearest-neighbour, and to the same under a box filter. A 1×1 is what separates them: the
    // average is mid-grey, and a sample is whichever pixel happened to be picked.
    const image = { width: 64, height: 8, pixels: halves(64, 8) };
    const scaled = downscale(image, { width: 1, height: 1 });
    expect(scaled.pixels[0]).toBeGreaterThan(100);
    expect(scaled.pixels[0]).toBeLessThan(155);
  });

  it('leaves an image alone when the target is its own size', () => {
    const pixels = halves(8, 8);
    const scaled = downscale({ width: 8, height: 8, pixels }, { width: 8, height: 8 });
    expect([...scaled.pixels]).toEqual([...pixels]);
  });
});

describe('PNG', () => {
  it('round-trips an image through encode and decode', () => {
    const original = { width: 17, height: 9, pixels: halves(17, 9) };
    const decoded = decodePng(encodePng(original));
    expect(decoded?.width).toBe(17);
    expect(decoded?.height).toBe(9);
    expect([...(decoded?.pixels ?? [])]).toEqual([...original.pixels]);
  });

  it('round-trips a single pixel, which is the smallest legal image', () => {
    const decoded = decodePng(
      encodePng({ width: 1, height: 1, pixels: solid(1, 1, [1, 2, 3, 4]) }),
    );
    expect([...(decoded?.pixels ?? [])]).toEqual([1, 2, 3, 4]);
  });

  it('produces something that starts with the PNG signature', () => {
    const encoded = encodePng({ width: 4, height: 4, pixels: solid(4, 4, [0, 0, 0, 255]) });
    expect([...encoded.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  });

  it('declines anything that is not a PNG rather than throwing', () => {
    expect(decodePng(Buffer.from('%PDF-1.7'))).toBeNull();
    expect(decodePng(Buffer.alloc(0))).toBeNull();
    expect(decodePng(Buffer.from([0x89, 0x50, 0x4e, 0x47]))).toBeNull();
  });

  it('declines a truncated PNG rather than returning half an image', () => {
    const encoded = encodePng({ width: 32, height: 32, pixels: halves(32, 32) });
    expect(decodePng(encoded.subarray(0, encoded.length - 40))).toBeNull();
  });

  it('refuses a decompression bomb from its header, before allocating anything', () => {
    // Twenty-five bytes that honestly declare a 60,000 × 60,000 image — fourteen gigabytes decoded.
    // Refusing here is free; refusing after allocation is not refusing.
    const bomb = encodePng({ width: 1, height: 1, pixels: solid(1, 1, [0, 0, 0, 255]) });
    bomb.writeUInt32BE(60_000, 16);
    bomb.writeUInt32BE(60_000, 20);
    expect(60_000 * 60_000).toBeGreaterThan(MAX_DECODED_PIXELS);
    expect(decodePng(bomb)).toBeNull();
  });

  it('declines a palette or 16-bit PNG rather than guessing at it', () => {
    const encoded = encodePng({ width: 4, height: 4, pixels: solid(4, 4, [0, 0, 0, 255]) });
    // Colour type 3 is a palette; this decoder handles truecolour only, and says so by declining.
    encoded[8 + 8 + 9 + 4 + 4] = 3;
    expect(decodePng(encoded)).toBeNull();
  });
});

describe('the whole thumbnail path', () => {
  it('shrinks a large image to within the ceiling and re-encodes it smaller', () => {
    const original = { width: 1200, height: 800, pixels: halves(1200, 800) };
    const encoded = encodePng(original);
    const decoded = decodePng(encoded);
    expect(decoded).not.toBeNull();
    if (decoded === null) {
      return;
    }
    const thumbnail = encodePng(
      downscale(decoded, thumbnailSizeFor(decoded.width, decoded.height)),
    );
    const back = decodePng(thumbnail);
    expect(back?.width).toBe(320);
    expect(back?.height).toBe(213);
    expect(thumbnail.length).toBeLessThan(encoded.length);
  });
});
