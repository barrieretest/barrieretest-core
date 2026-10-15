/**
 * Minimal JPEG header reader, the twin of `readPngSize`.
 *
 * Rendering-condition captures are JPEG, the baseline screenshot is PNG, and
 * both place rects, so the size of either has to come from the image itself.
 * Only the frame header is read, so no image dependency is needed.
 */

import { type PngSize, readPngSize } from "./png.js";

/** Start of image: FF D8. */
const SOI = [0xff, 0xd8];

/**
 * Markers that carry no payload, so no segment length follows them: the
 * reserved `FF 01`, the restart markers `FF D0`-`FF D7`, and the start and
 * end of image themselves.
 */
function isStandalone(marker: number): boolean {
  return (
    marker === 0x01 || marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)
  );
}

/**
 * Start-of-frame markers: C0-CF except C4 (define Huffman tables), C8 (JPEG
 * extensions) and CC (define arithmetic coding conditioning). Every SOF
 * segment starts with precision, height and width in the same layout, so
 * baseline (C0), extended (C1) and progressive (C2) are read identically.
 */
function isStartOfFrame(marker: number): boolean {
  return marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
}

/**
 * Width and height from a JPEG's start-of-frame segment, or `null` when the
 * bytes are not a JPEG whose size can be read: no SOI, a segment whose
 * declared length reaches past the data, no SOF before the compressed scan,
 * or a frame declaring a zero dimension.
 */
export function readJpegSize(bytes: Uint8Array): PngSize | null {
  if (bytes.length < 4 || bytes[0] !== SOI[0] || bytes[1] !== SOI[1]) {
    return null;
  }

  let offset = 2;

  while (offset + 1 < bytes.length) {
    // Segments are separated by one or more fill bytes before the marker.
    if (bytes[offset] !== 0xff) {
      return null;
    }
    while (offset + 1 < bytes.length && bytes[offset + 1] === 0xff) {
      offset += 1;
    }

    const marker = bytes[offset + 1];
    offset += 2;

    if (isStandalone(marker)) {
      continue;
    }

    // Start of scan: the compressed data follows, so no frame header is left.
    if (marker === 0xda) {
      return null;
    }

    if (offset + 1 >= bytes.length) {
      return null;
    }

    const length = (bytes[offset] << 8) | bytes[offset + 1];
    if (length < 2 || offset + length > bytes.length) {
      return null;
    }

    if (isStartOfFrame(marker)) {
      // length (2) + precision (1) + height (2) + width (2)
      if (length < 7) {
        return null;
      }
      const height = (bytes[offset + 3] << 8) | bytes[offset + 4];
      const width = (bytes[offset + 5] << 8) | bytes[offset + 6];
      if (width <= 0 || height <= 0) {
        return null;
      }
      return { width, height };
    }

    offset += length;
  }

  return null;
}

/**
 * Size of a PNG or JPEG capture, whichever the bytes are. `null` when
 * neither reader recognises them.
 */
export function readImageSize(bytes: Uint8Array): PngSize | null {
  return readPngSize(bytes) ?? readJpegSize(bytes);
}
