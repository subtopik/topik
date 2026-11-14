import { describe, expect, test } from "vite-plus/test";
import { isTopikActiveMediaType, sniffPortableMediaType } from "./media";

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
