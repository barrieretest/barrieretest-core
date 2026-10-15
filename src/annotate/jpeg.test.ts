import { describe, expect, it } from "bun:test";
import { readImageSize, readJpegSize } from "./jpeg.js";

/**
 * A JPEG with one start-of-frame segment, optionally preceded by other
 * segments, which is all the reader looks at.
 */
function jpeg(
  width: number,
  height: number,
  options: { marker?: number; before?: number[]; truncate?: number } = {}
): Uint8Array {
  const marker = options.marker ?? 0xc0;
  const bytes = [
    0xff,
    0xd8,
    ...(options.before ?? []),
    0xff,
    marker,
    0x00,
    0x11,
    0x08,
    (height >> 8) & 0xff,
    height & 0xff,
    (width >> 8) & 0xff,
    width & 0xff,
    0x03,
    0x01,
    0x22,
    0x00,
    0x02,
    0x11,
    0x01,
    0x03,
    0x11,
    0x01,
  ];
  const all = new Uint8Array(bytes);
  return options.truncate === undefined ? all : all.slice(0, options.truncate);
}

/** An APP0 (JFIF) segment, which must be skipped by its declared length. */
const APP0 = [0xff, 0xe0, 0x00, 0x04, 0x00, 0x00];

describe("readJpegSize", () => {
  it("reads a baseline frame", () => {
    expect(readJpegSize(jpeg(320, 1480))).toEqual({ width: 320, height: 1480 });
  });

  it("reads a progressive frame", () => {
    expect(readJpegSize(jpeg(768, 1024, { marker: 0xc2 }))).toEqual({ width: 768, height: 1024 });
  });

  it("skips segments before the frame, including fill bytes", () => {
    expect(readJpegSize(jpeg(360, 800, { before: [...APP0, 0xff] }))).toEqual({
      width: 360,
      height: 800,
    });
  });

  it("returns null without a start of image", () => {
    expect(readJpegSize(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toBeNull();
  });

  it("returns null when the frame is cut off", () => {
    expect(readJpegSize(jpeg(320, 720, { truncate: 8 }))).toBeNull();
  });

  it("returns null when a frame declares a zero dimension", () => {
    expect(readJpegSize(jpeg(0, 720))).toBeNull();
  });

  it("returns null when the scan starts before any frame", () => {
    expect(readJpegSize(new Uint8Array([0xff, 0xd8, 0xff, 0xda, 0x00, 0x02]))).toBeNull();
  });

  it("returns null for a Huffman-table marker, which is not a frame", () => {
    expect(readJpegSize(jpeg(320, 720, { marker: 0xc4 }))).toBeNull();
  });
});

describe("readImageSize", () => {
  it("reads a JPEG", () => {
    expect(readImageSize(jpeg(320, 720))).toEqual({ width: 320, height: 720 });
  });

  it("reads a PNG", () => {
    const png = new Uint8Array(29);
    png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
    const view = new DataView(png.buffer);
    view.setUint32(8, 13);
    png.set([0x49, 0x48, 0x44, 0x52], 12);
    view.setUint32(16, 1280);
    view.setUint32(20, 960);
    expect(readImageSize(png)).toEqual({ width: 1280, height: 960 });
  });

  it("returns null for anything else", () => {
    expect(readImageSize(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]))).toBeNull();
  });
});
