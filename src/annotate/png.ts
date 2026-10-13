/**
 * Minimal PNG header reader.
 *
 * The size of the capture has to come from the image itself: a full-page
 * screenshot can be clipped by the browser's maximum capture height, so the
 * document size is not a reliable stand-in. Only the IHDR chunk is read, so
 * no image dependency is needed.
 */

/** PNG signature: \x89 P N G \r \n \x1a \n. */
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
/** "IHDR", which a PNG must carry as its first chunk type. */
const IHDR_TYPE = [0x49, 0x48, 0x44, 0x52];
/** Data length an IHDR chunk always declares: 4 + 4 + 1 + 1 + 1 + 1 + 1. */
const IHDR_DATA_LENGTH = 13;
/** Signature (8) + chunk length (4) + chunk type (4) + the 13 data bytes. */
const IHDR_END = 8 + 4 + 4 + IHDR_DATA_LENGTH;

export interface PngSize {
  /** Width in image pixels (not CSS pixels). */
  width: number;
  /** Height in image pixels (not CSS pixels). */
  height: number;
}

/**
 * Width and height from a PNG's IHDR chunk, or `null` when the bytes are not
 * a PNG whose size can be read: the signature, a first chunk declaring the
 * 13 IHDR data bytes, the chunk type, and enough bytes to hold that data.
 * The chunk CRC is not verified — a size read from a truncated or corrupt
 * image would place rects wrongly, but a bad CRC on a complete header would
 * not, and Puppeteer hands us the bytes directly.
 */
export function readPngSize(bytes: Uint8Array): PngSize | null {
  if (bytes.length < IHDR_END) {
    return null;
  }

  for (let index = 0; index < PNG_SIGNATURE.length; index++) {
    if (bytes[index] !== PNG_SIGNATURE[index]) {
      return null;
    }
  }

  for (let index = 0; index < IHDR_TYPE.length; index++) {
    if (bytes[12 + index] !== IHDR_TYPE[index]) {
      return null;
    }
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  if (view.getUint32(8) !== IHDR_DATA_LENGTH) {
    return null;
  }

  const width = view.getUint32(16);
  const height = view.getUint32(20);

  if (width <= 0 || height <= 0) {
    return null;
  }

  return { width, height };
}
