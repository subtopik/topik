import { describe, expect, test } from "vite-plus/test";
import { isInlineMediaCompatible, isTopikActiveMediaType, sniffPortableMediaType } from "./media";

const text = (value: string) => new TextEncoder().encode(value);

function concat(...parts: (Uint8Array | readonly number[])[]): Uint8Array {
  return Uint8Array.from(parts.flatMap((part) => [...part]));
}

/** An MPEG-1 Layer III, 128 kbit/s, 44.1 kHz frame: 417 bytes including its header. */
function mp3Frame(): Uint8Array {
  const frame = new Uint8Array(417);
  frame.set([0xff, 0xfb, 0x90, 0x00]);
  return frame;
}

function utf16le(value: string): Uint8Array {
  const bytes = new Uint8Array(value.length * 2);
  for (let index = 0; index < value.length; index++) {
    bytes[index * 2] = value.charCodeAt(index) & 0xff;
    bytes[index * 2 + 1] = value.charCodeAt(index) >> 8;
  }
  return bytes;
}

function bmp(): Uint8Array {
  const bytes = new Uint8Array(58);
  const view = new DataView(bytes.buffer);
  bytes.set(text("BM"));
  view.setUint32(2, bytes.byteLength, true);
  view.setUint32(10, 54, true);
  view.setUint32(14, 40, true);
  view.setInt32(18, 1, true);
  view.setInt32(22, 1, true);
  return bytes;
}

function ftyp(major: string, compatible: readonly string[] = [], trailing = 8): Uint8Array {
  const boxSize = 16 + compatible.length * 4;
  const bytes = new Uint8Array(boxSize + trailing);
  new DataView(bytes.buffer).setUint32(0, boxSize);
  bytes.set(text(`ftyp${major}\0\0\0\0${compatible.join("")}`), 4);
  return bytes;
}

describe("MPEG audio signatures", () => {
  test("accepts an ID3v2 tag and a validated frame sequence", () => {
    expect(sniffPortableMediaType(concat(text("ID3"), [4, 0, 0, 0, 0, 0, 10]))).toBe("audio/mpeg");
    expect(sniffPortableMediaType(concat(mp3Frame(), mp3Frame()))).toBe("audio/mpeg");
    expect(sniffPortableMediaType(mp3Frame())).toBe("audio/mpeg");
  });

  test.each([
    [
      "UTF-16LE text with a byte order mark",
      concat([0xff, 0xfe], utf16le("Hello, world. ".repeat(40))),
    ],
    ["a short UTF-16LE file", concat([0xff, 0xfe], utf16le("Hi"))],
    // FF FE 20 00 is a valid MPEG-1 Layer I header whose frame is exactly 68 bytes long.
    [
      "UTF-16LE text exactly one Layer I frame long",
      concat([0xff, 0xfe], utf16le(" <script>alert(1)</script>".padEnd(33, " "))),
    ],
    ["sync bits without a following frame", concat(mp3Frame(), text("not another frame"))],
    ["a reserved MPEG version", concat([0xff, 0xeb, 0x90, 0x00], new Uint8Array(500))],
    ["a reserved layer", concat([0xff, 0xf9, 0x90, 0x00], new Uint8Array(500))],
    ["an invalid bitrate", concat([0xff, 0xfb, 0xf0, 0x00], new Uint8Array(500))],
    ["a reserved sample rate", concat([0xff, 0xfb, 0x9c, 0x00], new Uint8Array(500))],
    ["prose that starts with ID3", text("ID3 tags store artist metadata.\n")],
  ])("keeps %s opaque", (_name, bytes) => {
    expect(sniffPortableMediaType(bytes)).toBe("application/octet-stream");
  });
});

describe("BMP signatures", () => {
  test("accepts a bitmap with plausible header fields", () => {
    expect(sniffPortableMediaType(bmp())).toBe("image/bmp");
  });

  test.each([
    ["text starting with BM", text("BMW service notes: replace the oil every year.\n")],
    ["a truncated header", text("BM")],
  ])("keeps %s opaque", (_name, bytes) => {
    expect(sniffPortableMediaType(bytes)).toBe("application/octet-stream");
  });

  test("rejects an unknown DIB header size", () => {
    const bytes = bmp();
    new DataView(bytes.buffer).setUint32(14, 41, true);
    expect(sniffPortableMediaType(bytes)).toBe("application/octet-stream");
  });
});

/** A classic TIFF with one IFD of `entries` SHORT fields directly after the header. */
function tiff(order: "II" | "MM", entries = 1): Uint8Array {
  const little = order === "II";
  const bytes = new Uint8Array(8 + 2 + entries * 12 + 4);
  const view = new DataView(bytes.buffer);
  bytes.set(text(order));
  view.setUint16(2, 42, little);
  view.setUint32(4, 8, little);
  view.setUint16(8, entries, little);
  for (let index = 0; index < entries; index++) {
    view.setUint16(10 + index * 12, 256 + index, little);
    view.setUint16(12 + index * 12, 3, little);
    view.setUint32(14 + index * 12, 1, little);
  }
  return bytes;
}

describe("TIFF signatures", () => {
  test.each(["II", "MM"] as const)("accepts %s byte order with a plausible first IFD", (order) => {
    expect(sniffPortableMediaType(tiff(order))).toBe("image/tiff");
    expect(sniffPortableMediaType(tiff(order, 12))).toBe("image/tiff");
  });

  function withUint32(bytes: Uint8Array, offset: number, value: number, little: boolean) {
    new DataView(bytes.buffer).setUint32(offset, value, little);
    return bytes;
  }

  test.each([
    ["text starting with II", text("II* notes: the second item.\n")],
    ["text starting with MM", text("MM-DD dates are ambiguous.\n")],
    ["a truncated header", text("II*\0")],
    ["an IFD offset inside the header", withUint32(tiff("II"), 4, 4, true)],
    ["an odd IFD offset", withUint32(tiff("MM"), 4, 9, false)],
    ["an IFD offset past the end", withUint32(tiff("II"), 4, 0x1000, true)],
    ["an IFD with no entries", tiff("II", 0)],
    ["IFD entries that run past the end", tiff("MM", 2).slice(0, 30)],
    ["an unknown field type", withUint32(tiff("II"), 10, 0x00ff_0100, true)],
    ["mixed byte order markers", concat(text("IM"), tiff("II").slice(2))],
  ])("keeps %s opaque", (_name, bytes) => {
    expect(sniffPortableMediaType(bytes)).toBe("application/octet-stream");
  });
});

/** An ADTS frame (AAC LC, 44.1 kHz, stereo, no CRC) of `length` bytes including its header. */
function adtsFrame(length = 32, samplingIndex = 4): Uint8Array {
  const frame = new Uint8Array(length);
  frame.set([
    0xff,
    0xf1,
    0x40 | (samplingIndex << 2),
    0x80 | (length >> 11),
    (length >> 3) & 0xff,
    ((length & 0x07) << 5) | 0x1f,
    0xfc,
  ]);
  return frame;
}

describe("AAC (ADTS) signatures", () => {
  test("accepts a validated frame sequence and a single complete frame", () => {
    expect(sniffPortableMediaType(concat(adtsFrame(), adtsFrame(), adtsFrame()))).toBe("audio/aac");
    expect(sniffPortableMediaType(adtsFrame(400))).toBe("audio/aac");
  });

  test.each([
    [
      "UTF-16LE text with a byte order mark",
      concat([0xff, 0xfe], utf16le("Hello, world. ".repeat(40))),
    ],
    ["sync bits without a following frame", concat(adtsFrame(), text("not another frame"))],
    ["a following frame with another sampling rate", concat(adtsFrame(), adtsFrame(32, 3))],
    ["a frame longer than the file", adtsFrame(64).slice(0, 40)],
    ["a frame no longer than its header", concat(adtsFrame(7), adtsFrame(7))],
    ["a reserved sampling frequency", concat(adtsFrame(32, 13), adtsFrame(32, 13))],
    ["a truncated header", adtsFrame().slice(0, 5)],
  ])("keeps %s opaque", (_name, bytes) => {
    expect(sniffPortableMediaType(bytes)).toBe("application/octet-stream");
  });
});

/** An EBML element with a one-byte size. */
function ebmlElement(id: readonly number[], data: Uint8Array | readonly number[]): Uint8Array {
  return concat(id, [0x80 | data.length], data);
}

function ebmlHeader(...children: Uint8Array[]): Uint8Array {
  return concat(
    ebmlElement([0x1a, 0x45, 0xdf, 0xa3], concat(...children)),
    // A Segment element with unknown size follows the header in a real file.
    [0x18, 0x53, 0x80, 0x67, 0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff],
  );
}

const ebmlVersion = ebmlElement([0x42, 0x86], [1]);
const docType = (value: string) => ebmlElement([0x42, 0x82], text(value));

describe("WebM signatures", () => {
  test("accepts an EBML header with the webm DocType", () => {
    expect(sniffPortableMediaType(ebmlHeader(ebmlVersion, docType("webm")))).toBe("video/webm");
    expect(sniffPortableMediaType(ebmlHeader(docType("webm\0\0")))).toBe("video/webm");
    // An eight-byte size field is valid EBML.
    const wide = concat(
      [0x1a, 0x45, 0xdf, 0xa3, 0x01, 0, 0, 0, 0, 0, 0, 7],
      docType("webm"),
      new Uint8Array(4),
    );
    expect(sniffPortableMediaType(wide)).toBe("video/webm");
  });

  test.each([
    ["a Matroska DocType", ebmlHeader(ebmlVersion, docType("matroska"))],
    ["a header without a DocType", ebmlHeader(ebmlVersion)],
    ["a duplicate DocType", ebmlHeader(docType("webm"), docType("matroska"))],
    ["an empty DocType", ebmlHeader(docType(""))],
    ["a non-ASCII DocType", ebmlHeader(docType("webé"))],
    ["a header longer than the file", ebmlHeader(docType("webm")).slice(0, 8)],
    [
      "a child element running past the header",
      concat([0x1a, 0x45, 0xdf, 0xa3, 0x83], docType("webm")),
    ],
    ["an unknown header size", concat([0x1a, 0x45, 0xdf, 0xa3, 0xff], docType("webm"))],
    ["an invalid size marker", concat([0x1a, 0x45, 0xdf, 0xa3, 0x00], docType("webm"))],
    ["a magic number alone", Uint8Array.from([0x1a, 0x45, 0xdf, 0xa3])],
    ["text that mentions webm", text("webm files are not sniffed from text.\n")],
  ])("keeps %s opaque", (_name, bytes) => {
    expect(sniffPortableMediaType(bytes)).toBe("application/octet-stream");
  });

  test("scans a large header in linear time", () => {
    // 200,000 empty Void elements (`EC 80`) inside one 400,000-byte header.
    const header = new Uint8Array(9 + 400_000);
    header.set([0x1a, 0x45, 0xdf, 0xa3, 0x08, 0, 0x06, 0x1a, 0x80]);
    for (let offset = 9; offset < header.byteLength; offset += 2) header.set([0xec, 0x80], offset);
    const started = performance.now();
    sniffPortableMediaType(header);
    expect(performance.now() - started).toBeLessThan(750);
  });
});

describe("reference roles for the TIFF, AAC and WebM types", () => {
  test.each([
    ["image/tiff", true, true],
    ["audio/aac", false, true],
    ["video/webm", false, true],
  ] as const)("treats %s as passive media", (mediaType, image, media) => {
    expect(isTopikActiveMediaType(mediaType)).toBe(false);
    expect(isInlineMediaCompatible(mediaType, "image")).toBe(image);
    expect(isInlineMediaCompatible(mediaType, "image-dark")).toBe(image);
    expect(isInlineMediaCompatible(mediaType, "media")).toBe(media);
  });
});

describe("the video reference role", () => {
  test.each([
    ["video/mp4", true],
    ["video/webm", true],
    ["video/quicktime", false],
    ["video/3gpp", false],
    ["audio/mp4", false],
    ["audio/mpeg", false],
    ["image/png", false],
    ["application/octet-stream", false],
  ] as const)("admits %s: %s", (mediaType, admitted) => {
    expect(isInlineMediaCompatible(mediaType, "video")).toBe(admitted);
  });

  test("leaves the generic media role unchanged", () => {
    expect(isInlineMediaCompatible("video/quicktime", "media")).toBe(true);
    expect(isInlineMediaCompatible("audio/mp4", "media")).toBe(true);
  });
});

describe("ISO base media brands", () => {
  test.each([
    ["avif", [], "image/avif"],
    ["mif1", ["mif1", "avif"], "image/avif"],
    ["heic", ["mif1", "heic"], "image/heic"],
    ["mif1", ["mif1", "heic"], "image/heic"],
    ["mif1", ["mif1"], "image/heif"],
    ["M4A ", ["M4A ", "mp42", "isom"], "audio/mp4"],
    ["qt  ", ["qt  "], "video/quicktime"],
    ["3gp4", ["3gp4", "isom"], "video/3gpp"],
    ["isom", ["isom", "iso2", "mp41"], "video/mp4"],
    ["mp42", ["mp42", "isom"], "video/mp4"],
    ["zzzz", ["zzzz", "mp41"], "video/mp4"],
  ] as const)("classifies major brand %j with %j as %s", (major, compatible, expected) => {
    expect(sniffPortableMediaType(ftyp(major, compatible))).toBe(expected);
  });

  test("keeps unknown brands and malformed boxes opaque", () => {
    expect(sniffPortableMediaType(ftyp("zzzz", ["yyyy"]))).toBe("application/octet-stream");
    // A 256-byte box starts with the ICO signature 00 00 01 00.
    expect(sniffPortableMediaType(ftyp("zzzz", Array(60).fill("yyyy")))).toBe(
      "application/octet-stream",
    );
    const malformed = ftyp("isom", ["mp41"]);
    new DataView(malformed.buffer).setUint32(0, 0x1000);
    expect(sniffPortableMediaType(malformed)).toBe("application/octet-stream");
  });
});

describe("HTML active content", () => {
  test.each([
    ["a leading tag", "<div>x</div>"],
    ["a leading tag after whitespace", " \n\t<p>Hello</p>"],
    ["a leading tag after a byte order mark", "﻿<b>Hello</b>"],
    ["a leading tag after a comment", "<!-- generated -->\n<table></table>"],
    ["a self-closing leading tag", "<br/>text"],
    ["a later script", "Notes\n<script>alert(1)</script>"],
    ["a later iframe", "Notes\n<iframe src=https://example.com></iframe>"],
    ["a later document element", "Notes\n<html><body>x</body></html>"],
    ["a later doctype", "Notes\n<!DOCTYPE html>"],
    [
      "a later meta refresh",
      'Notes\n<meta http-equiv="refresh" content="0;url=https://example.com">',
    ],
    ["a later form", "Notes\n<form action=https://example.com>"],
    ["a later event handler", "Notes <img src=x onerror=alert(1)>"],
    ["a later javascript URL", "Notes <a href='javascript:alert(1)'>x</a>"],
  ])("treats %s as active", (_name, source) => {
    const mediaType = sniffPortableMediaType(text(source));
    expect(mediaType).toBe("text/html");
    expect(isTopikActiveMediaType(mediaType)).toBe(true);
  });

  test.each([
    ["TypeScript generics", "Use Array<string> or Map<string, number> for lists.\n"],
    ["a component name", "Wrap pages in <Layout> and navigation in <Link, Nav>.\n"],
    ["comparisons", "Check that a < b and b > c before continuing.\n"],
    ["an email placeholder", "Contact <maintainer@example.com> for access.\n"],
  ])("keeps prose with %s downloadable", (_name, source) => {
    expect(sniffPortableMediaType(text(source))).toBe("application/octet-stream");
  });

  test("still detects SVG anywhere in the inspected text", () => {
    expect(sniffPortableMediaType(text("Logo:\n<svg viewBox='0 0 1 1'></svg>"))).toBe(
      "image/svg+xml",
    );
    expect(sniffPortableMediaType(text("<svg xmlns='http://www.w3.org/2000/svg'/>"))).toBe(
      "image/svg+xml",
    );
  });

  test.each([
    ["a comparison followed by an assignment", "if x < y then online = true\n"],
    ["a loop that assigns a handler property", "for (i=0;i<n;i++){el.onclick=handler;}\n"],
    ["an unclosed tag-like span", "if x <y then online = true\n"],
    ["prose that names the SVG element", "Use the <svg> element to draw.\n"],
    [
      "an XML property list",
      '<?xml version="1.0" encoding="UTF-8"?>\n' +
        '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" ' +
        '"http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n' +
        '<plist version="1.0">\n<dict><key>Name</key><string>x</string></dict>\n</plist>\n',
    ],
    ["an XML document without a doctype", '<?xml version="1.0"?>\n<project><a/></project>\n'],
  ])("keeps %s downloadable", (_name, source) => {
    expect(sniffPortableMediaType(text(source))).toBe("application/octet-stream");
  });

  test.each([
    ["an event handler after a slash", "Notes <img/onerror=alert(1)>"],
    ["an event handler after a quoted value", 'Notes <a href="x"onclick="alert(1)">x</a>'],
    [
      "XHTML declared as XML",
      '<?xml version="1.0"?>\n<html xmlns="http://www.w3.org/1999/xhtml"/>',
    ],
    [
      "XML that names the XHTML namespace",
      '<?xml version="1.0"?>\n<x:a xmlns:x="http://www.w3.org/1999/xhtml"/>',
    ],
    [
      "XML whose namespace is spelled with a character reference",
      '<?xml version="1.0"?>\n<data><x:script xmlns:x="http://www.w3.org/1999/xhtm&#108;">x()</x:script></data>',
    ],
    [
      "XML whose SVG namespace is spelled with a character reference",
      "<?xml version=\"1.0\"?>\n<data><s:svg xmlns:s='http://www.w3.org/2000/sv&#x67;'/></data>",
    ],
    ["XML with a stylesheet instruction", '<?xml-stylesheet href="a.xsl"?>\n<data/>'],
    ["XML with an event handler", '<?xml version="1.0"?>\n<data><b onclick="x()"/></data>'],
  ])("treats %s as active", (_name, source) => {
    expect(sniffPortableMediaType(text(source))).toBe("text/html");
  });

  test("keeps an open tag in truncated text active", () => {
    const source = `Notes <img src=x onerror=alert(1) ${"a".repeat(70 * 1024)}>`;
    expect(sniffPortableMediaType(text(source))).toBe("text/html");
  });

  test.each([
    ["repeated angle brackets", "<".repeat(64 * 1024)],
    ["angle brackets separated by spaces", "< ".repeat(32 * 1024)],
    ["unclosed start tags", "<a ".repeat(21 * 1024)],
    ["unclosed handler-like spans", "<a o".repeat(16 * 1024)],
  ])("inspects %s in linear time", (_name, source) => {
    // The previous patterns backtracked quadratically and took seconds on these inputs; a linear
    // scan takes milliseconds, so the bound tolerates slow machines without hiding a regression.
    const started = performance.now();
    sniffPortableMediaType(text(source));
    expect(performance.now() - started).toBeLessThan(750);
  });
});

describe("executable signatures", () => {
  function portableExecutable(offset = 0x80): Uint8Array {
    const bytes = new Uint8Array(offset + 24);
    bytes.set(text("MZ"));
    new DataView(bytes.buffer).setUint32(0x3c, offset, true);
    bytes.set(text("PE\0\0"), offset);
    return bytes;
  }

  test("accepts a PE header and an interpreter line", () => {
    expect(sniffPortableMediaType(portableExecutable())).toBe("application/x-executable");
    expect(sniffPortableMediaType(text("#!/bin/sh\necho hi\n"))).toBe("application/x-executable");
    expect(sniffPortableMediaType(text("#! /usr/bin/env node\n"))).toBe("application/x-executable");
  });

  test.each([
    ["a CSV that starts with MZ", text("MZ,Mozambique\nZA,South Africa\n")],
    ["MZ bytes without a PE signature", portableExecutable().fill(0, 0x80)],
    ["MZ bytes with an out-of-range PE offset", portableExecutable().slice(0, 0x60)],
    ["a hash-bang heading typo", text("#! Heading typo\nBody\n")],
    ["a hash-bang without a path", text("#!python\n")],
  ])("keeps %s opaque", (_name, bytes) => {
    expect(sniffPortableMediaType(bytes)).toBe("application/octet-stream");
  });
});

describe("ICO signatures", () => {
  function ico(count: number, directoryBytes = count * 16): Uint8Array {
    return concat([0, 0, 1, 0, count & 0xff, count >> 8], new Uint8Array(directoryBytes));
  }

  test("accepts a header whose image directory fits in the file", () => {
    expect(sniffPortableMediaType(ico(1))).toBe("image/x-icon");
    expect(sniffPortableMediaType(ico(2))).toBe("image/x-icon");
  });

  test.each([
    ["no images", ico(0)],
    ["a directory longer than the file", ico(4, 16)],
  ])("keeps a header with %s opaque", (_name, bytes) => {
    expect(sniffPortableMediaType(bytes)).toBe("application/octet-stream");
  });
});

test("reads only the first compatible brands of a box that claims the whole file", () => {
  const bytes = ftyp("zzzz", [...Array(100).fill("yyyy"), "mp41"]);
  expect(sniffPortableMediaType(bytes)).toBe("application/octet-stream");
  const large = new Uint8Array(64 * 1024 * 1024);
  new DataView(large.buffer).setUint32(0, large.byteLength);
  large.set(text("ftypzzzz"), 4);
  const started = performance.now();
  expect(sniffPortableMediaType(large)).toBe("application/octet-stream");
  expect(performance.now() - started).toBeLessThan(1_000);
});
