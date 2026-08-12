const MARKUP_INSPECTION_LIMIT = 64 * 1024;
export const TOPIK_UNRESOLVED_ACTIVE_CONTENT_TYPE = "application/x-topik-active-content" as const;

/** Sniff exact bytes conservatively. Unknown safe bytes remain opaque downloads. */
export function sniffPortableMediaType(bytes: Uint8Array): string {
  const has = (...values: number[]) => values.every((value, index) => bytes[index] === value);
  if (has(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "image/png";
  if (has(0xff, 0xd8, 0xff)) return "image/jpeg";
  if (ascii(bytes, 0, 6) === "GIF87a" || ascii(bytes, 0, 6) === "GIF89a") return "image/gif";
  if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP") return "image/webp";
  if (ascii(bytes, 4, 8).includes("ftypavif")) return "image/avif";
  if (ascii(bytes, 0, 2) === "BM") return "image/bmp";
  if (has(0x00, 0x00, 0x01, 0x00)) return "image/x-icon";
  if (ascii(bytes, 0, 5) === "%PDF-") return "application/pdf";
  if (has(0x50, 0x4b, 0x03, 0x04) || has(0x50, 0x4b, 0x05, 0x06)) return "application/zip";
  if (has(0x1f, 0x8b)) return "application/gzip";
  if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WAVE") return "audio/wav";
  if (ascii(bytes, 0, 4) === "OggS") return "audio/ogg";
  if (ascii(bytes, 0, 4) === "fLaC") return "audio/flac";
  if (ascii(bytes, 0, 3) === "ID3" || (bytes[0] === 0xff && ((bytes[1] ?? 0) & 0xe0) === 0xe0)) {
    return "audio/mpeg";
  }
  if (ascii(bytes, 4, 4) === "ftyp") return "video/mp4";
  if (
    has(0x7f, 0x45, 0x4c, 0x46) ||
    has(0x4d, 0x5a) ||
    has(0xfe, 0xed, 0xfa, 0xce) ||
    has(0xce, 0xfa, 0xed, 0xfe) ||
    has(0xfe, 0xed, 0xfa, 0xcf) ||
    has(0xcf, 0xfa, 0xed, 0xfe) ||
    has(0xca, 0xfe, 0xba, 0xbe) ||
    has(0x23, 0x21)
  ) {
    return "application/x-executable";
  }
  if (has(0x00, 0x61, 0x73, 0x6d)) return "application/wasm";
  return sniffPortableMarkupType(bytes) ?? "application/octet-stream";
}

export function isTopikActiveMediaType(mediaType: string): boolean {
  return [
    "text/html",
    "image/svg+xml",
    "application/javascript",
    "text/javascript",
    "application/x-executable",
    "application/wasm",
    TOPIK_UNRESOLVED_ACTIVE_CONTENT_TYPE,
  ].includes(mediaType);
}

export function isInlineMediaCompatible(mediaType: string, role: string): boolean {
  return role.startsWith("image")
    ? mediaType.startsWith("image/")
    : /^(?:image|audio|video)\//u.test(mediaType);
}

function sniffPortableMarkupType(bytes: Uint8Array): string | undefined {
  const boundary = Math.min(bytes.byteLength, MARKUP_INSPECTION_LIMIT);
  const completionBytes = trailingUtf8Completion(bytes.slice(0, boundary));
  if (completionBytes > bytes.byteLength - boundary) {
    return TOPIK_UNRESOLVED_ACTIVE_CONTENT_TYPE;
  }
  const inspectedEnd = boundary + completionBytes;

  if (completionBytes > 0) {
    const sequenceStart = trailingUtf8SequenceStart(bytes.slice(0, boundary));
    try {
      new TextDecoder("utf-8", { fatal: true }).decode(bytes.slice(sequenceStart, inspectedEnd));
    } catch {
      return TOPIK_UNRESOLVED_ACTIVE_CONTENT_TYPE;
    }
  }

  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true })
      .decode(bytes.slice(0, inspectedEnd))
      .toLowerCase();
  } catch {
    return undefined;
  }

  let cursor = skipMarkupWhitespace(text, 0);
  let consumedPreamble = false;
  while (cursor < text.length) {
    if (text.startsWith("<!--", cursor)) {
      const end = text.indexOf("-->", cursor + 4);
      if (end === -1) return "text/html";
      consumedPreamble = true;
      cursor = skipMarkupWhitespace(text, end + 3);
      continue;
    }
    if (text.startsWith("<?xml", cursor)) {
      const end = text.indexOf("?>", cursor + 5);
      if (end === -1) return TOPIK_UNRESOLVED_ACTIVE_CONTENT_TYPE;
      consumedPreamble = true;
      cursor = skipMarkupWhitespace(text, end + 2);
      continue;
    }
    break;
  }

  if (cursor === text.length) {
    return bytes.byteLength > inspectedEnd && (cursor > 0 || consumedPreamble)
      ? TOPIK_UNRESOLVED_ACTIVE_CONTENT_TYPE
      : undefined;
  }

  const markup = text.slice(cursor);
  if (/<!doctype\s+svg\b/u.test(markup) || /<svg\b/u.test(markup)) return "image/svg+xml";
  if (
    /(?:<!doctype\s+html\b|<[a-z][a-z0-9:-]*(?:\s|>|\/))/u.test(markup) ||
    /<[^>]+\bon[a-z][a-z0-9_-]*\s*=/u.test(markup) ||
    /<[^>]+(?:href|src)\s*=\s*["']?\s*javascript:/u.test(markup) ||
    /<script\b/u.test(markup)
  ) {
    return "text/html";
  }
  if (markup.startsWith("<") && (consumedPreamble || bytes.byteLength > inspectedEnd)) {
    return TOPIK_UNRESOLVED_ACTIVE_CONTENT_TYPE;
  }
  return undefined;
}

function trailingUtf8Completion(bytes: Uint8Array): number {
  if (bytes.byteLength === 0) return 0;
  const start = trailingUtf8SequenceStart(bytes);
  const lead = bytes[start];
  const width =
    lead >= 0xc2 && lead <= 0xdf
      ? 2
      : lead >= 0xe0 && lead <= 0xef
        ? 3
        : lead >= 0xf0 && lead <= 0xf4
          ? 4
          : 1;
  const present = bytes.byteLength - start;
  return width > present ? width - present : 0;
}

function trailingUtf8SequenceStart(bytes: Uint8Array): number {
  let start = bytes.byteLength - 1;
  while (start > 0 && bytes[start] >= 0x80 && bytes[start] <= 0xbf) start--;
  return start;
}

function skipMarkupWhitespace(value: string, start: number): number {
  let cursor = start;
  while (/\s/u.test(value[cursor] ?? "")) cursor++;
  return cursor;
}

function ascii(bytes: Uint8Array, start: number, length: number): string {
  return String.fromCharCode(...bytes.slice(start, start + length));
}
