import { deflateSync, inflateSync } from 'node:zlib';

import type { RasterImage } from './thumbnail';

/**
 * PNG, decoded and encoded — enough of it, and no more.
 *
 * The format is a sequence of length-prefixed chunks around a zlib stream of filtered scanlines,
 * and that is genuinely all a thumbnail needs. What is deliberately *not* implemented is
 * interlacing, 16-bit channels, palettes with transparency, gamma correction and colour profiles:
 * each of those is a real part of the specification, none of them is needed to shrink a picture,
 * and a decoder that quietly got one wrong would produce a thumbnail that misrepresents a document.
 * So they are refused rather than approximated — `decodePng` returns null, and the document simply
 * has no thumbnail.
 *
 * The size ceiling below is the one security-relevant thing here. A PNG header is twenty-five bytes
 * and can honestly declare a 60,000 × 60,000 image, which is fourteen gigabytes of decoded pixels —
 * the decompression bomb every image pipeline has to refuse before it allocates. It is checked
 * against the *declared* dimensions, before anything is allocated, which is the only point at which
 * refusing is free.
 */

/** Above this many pixels, an image is not something this product will decode. */
export const MAX_DECODED_PIXELS = 40_000_000;

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * Decodes a PNG to RGBA, or answers null.
 *
 * Null for anything unsupported, malformed or oversized. Never a throw and never a partial image:
 * the caller's only sensible response to any of them is "no thumbnail", and distinguishing them
 * would be distinguishing between outcomes that are the same.
 */
export function decodePng(bytes: Buffer): RasterImage | null {
  if (bytes.length < 8 || !bytes.subarray(0, 8).equals(SIGNATURE)) {
    return null;
  }

  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  const data: Buffer[] = [];

  let offset = 8;
  while (offset + 8 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString('ascii', offset + 4, offset + 8);
    const from = offset + 8;
    const to = from + length;
    if (to + 4 > bytes.length) {
      return null;
    }

    if (type === 'IHDR') {
      if (length !== 13) {
        return null;
      }
      width = bytes.readUInt32BE(from);
      height = bytes.readUInt32BE(from + 4);
      bitDepth = bytes[from + 8] ?? 0;
      colorType = bytes[from + 9] ?? 0;
      const interlace = bytes[from + 12] ?? 0;
      // Eight bits per channel, truecolour with or without alpha, not interlaced. Everything else
      // is a legitimate PNG this decoder declines to guess at.
      if (bitDepth !== 8 || (colorType !== 2 && colorType !== 6) || interlace !== 0) {
        return null;
      }
      if (width <= 0 || height <= 0 || width * height > MAX_DECODED_PIXELS) {
        // Checked against the header, before a byte is allocated. This is the decompression bomb,
        // and the only free moment to refuse it.
        return null;
      }
    } else if (type === 'IDAT') {
      data.push(bytes.subarray(from, to));
    } else if (type === 'IEND') {
      break;
    }

    offset = to + 4;
  }

  if (width === 0 || height === 0 || data.length === 0) {
    return null;
  }

  const channels = colorType === 6 ? 4 : 3;
  let raw: Buffer;
  try {
    raw = inflateSync(Buffer.concat(data));
  } catch {
    return null;
  }

  const stride = width * channels;
  if (raw.length < (stride + 1) * height) {
    return null;
  }
  return { width, height, pixels: unfilter(raw, width, height, channels) };
}

/**
 * Reverses PNG's per-scanline filters.
 *
 * Each row is prefixed with a filter byte naming how it was encoded relative to the pixel to its
 * left, the row above, or both. It is the one genuinely fiddly part of the format, and it is
 * exactly the specification's own pseudocode — the alternative to writing it out is not writing it
 * out, and there is no shorter correct version.
 */
function unfilter(raw: Buffer, width: number, height: number, channels: number): Uint8Array {
  const stride = width * channels;
  const pixels = new Uint8Array(width * height * 4);
  const previous = new Uint8Array(stride);
  const current = new Uint8Array(stride);

  let offset = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = raw[offset] ?? 0;
    offset += 1;
    for (let x = 0; x < stride; x += 1) {
      const value = raw[offset + x] ?? 0;
      const left = x >= channels ? (current[x - channels] ?? 0) : 0;
      const up = previous[x] ?? 0;
      const upLeft = x >= channels ? (previous[x - channels] ?? 0) : 0;
      current[x] = (value + predictor(filter, left, up, upLeft)) & 0xff;
    }
    offset += stride;

    for (let x = 0; x < width; x += 1) {
      const source = x * channels;
      const target = (y * width + x) * 4;
      pixels[target] = current[source] ?? 0;
      pixels[target + 1] = current[source + 1] ?? 0;
      pixels[target + 2] = current[source + 2] ?? 0;
      pixels[target + 3] = channels === 4 ? (current[source + 3] ?? 255) : 255;
    }
    previous.set(current);
  }
  return pixels;
}

function predictor(filter: number, left: number, up: number, upLeft: number): number {
  switch (filter) {
    case 0:
      return 0;
    case 1:
      return left;
    case 2:
      return up;
    case 3:
      return Math.floor((left + up) / 2);
    case 4:
      return paeth(left, up, upLeft);
    default:
      return 0;
  }
}

/** The Paeth predictor, verbatim from the specification. */
function paeth(left: number, up: number, upLeft: number): number {
  const estimate = left + up - upLeft;
  const distanceLeft = Math.abs(estimate - left);
  const distanceUp = Math.abs(estimate - up);
  const distanceUpLeft = Math.abs(estimate - upLeft);
  if (distanceLeft <= distanceUp && distanceLeft <= distanceUpLeft) {
    return left;
  }
  return distanceUp <= distanceUpLeft ? up : upLeft;
}

/**
 * Encodes RGBA as a PNG.
 *
 * Filter type zero on every row — no filtering. A thumbnail is a few hundred pixels on its longest
 * edge, so the twenty per cent a good filter choice would save is a few kilobytes, and choosing
 * per row means implementing all five filters plus the heuristic that picks between them. Deflate
 * at its default level does the rest.
 */
export function encodePng(image: RasterImage): Buffer {
  const stride = image.width * 4;
  const raw = Buffer.allocUnsafe((stride + 1) * image.height);
  for (let y = 0; y < image.height; y += 1) {
    raw[y * (stride + 1)] = 0;
    Buffer.from(image.pixels.buffer, image.pixels.byteOffset + y * stride, stride).copy(
      raw,
      y * (stride + 1) + 1,
    );
  }

  const header = Buffer.allocUnsafe(13);
  header.writeUInt32BE(image.width, 0);
  header.writeUInt32BE(image.height, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // truecolour with alpha
  header[10] = 0; // deflate
  header[11] = 0; // adaptive filtering
  header[12] = 0; // no interlacing

  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.allocUnsafe(4);
  length.writeUInt32BE(data.length, 0);
  const typed = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const checksum = Buffer.allocUnsafe(4);
  checksum.writeUInt32BE(crc32(typed), 0);
  return Buffer.concat([length, typed, checksum]);
}

/** CRC-32, table-driven, over the chunk type and its data. What PNG's own appendix specifies. */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = (CRC_TABLE[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
