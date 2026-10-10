import { parseDocument, isMap, isSeq, isScalar, isNode, type Node, type YAMLMap } from "yaml";
import { parseSafeConfigurationYaml } from "../compile/config";
import { parseStrictTopikJson } from "../assets/json";
import { createHash } from "node:crypto";

export interface SourceByteRange {
  start: number;
  end: number;
}
export interface SourceFieldEvidence {
  selector: string;
  value?: SourceByteRange;
  entry?: SourceByteRange;
  insertion: number;
}
export interface SourceByteEdit extends SourceByteRange {
  selector: string;
  oldSha256: string;
  replacement: Uint8Array;
}
export const sourceHash = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");
export const encodeSource = (text: string): Uint8Array => new TextEncoder().encode(text);
export const decodeSource = (bytes: Uint8Array): string =>
  // Keep the BOM so syntax ranges and replay refer to the exact original bytes.
  new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);

/** All offsets exposed outside the parser are UTF-8 byte offsets in the immutable base. */
export function inspectSourceSyntax(raw: string, json = false) {
  // Configuration loading accepts a leading BOM; JSON validation excludes only
  // that marker while the YAML syntax parser retains original source positions.
  if (json) parseStrictTopikJson(raw.replace(/^\uFEFF/u, ""), 32);
  else parseSafeConfigurationYaml(raw);
  const document = parseDocument(raw, { schema: "core", strict: true, uniqueKeys: true });
  if (document.errors.length || document.warnings.length || !isMap(document.contents))
    throw new TypeError("Expected a safe mapping");
  const root = document.contents;
  const byte = (offset: number) => encodeSource(raw.slice(0, offset)).length;
  const range = (start: number, end: number): SourceByteRange => ({
    start: byte(start),
    end: byte(end),
  });
  const fields = new Map<string, SourceFieldEvidence>();
  const values = new Map<string, unknown>();
  const maps = new Map<string, YAMLMap>();
  const sequences = new Map<string, import("yaml").YAMLSeq>();

  const inspectMap = (map: YAMLMap, prefix = "") => {
    if (!map.range) throw new TypeError("Missing syntax ranges");
    const insertionChar = map.flow ? map.range[1] - 1 : map.range[1];
    maps.set(prefix, map);
    fields.set(`${prefix}+`, { selector: `${prefix}+`, insertion: byte(insertionChar) });
    for (let index = 0; index < map.items.length; index++) {
      const pair = map.items[index];
      if (
        !isScalar(pair.key) ||
        typeof pair.key.value !== "string" ||
        !pair.key.range ||
        !isNode(pair.value) ||
        !pair.value.range
      )
        throw new TypeError("Ambiguous mapping entry");
      const selector = `${prefix}${encodeURIComponent(pair.key.value)}`;
      const value = pair.value as Node;
      const valueRange = value.range!;
      let entryStart = pair.key.range[0];
      let entryEnd = valueRange[2];
      values.set(selector, value.toJSON());
      if (map.flow) {
        entryEnd = valueRange[1];
        const next = map.items[index + 1]?.key;
        if (next && isScalar(next) && next.range) {
          const comma = raw.indexOf(",", entryEnd);
          if (comma < 0 || comma >= next.range[0]) throw new TypeError("Missing separator");
          entryEnd = comma + 1;
        }
        if (index > 0) {
          const previous = map.items[index - 1].value as Node;
          if (!previous.range) throw new TypeError("Missing syntax ranges");
          const comma = raw.indexOf(",", previous.range[1]);
          if (comma < 0 || comma >= entryStart) throw new TypeError("Missing separator");
          entryStart = comma;
        }
      } else {
        const lineStart = raw.lastIndexOf("\n", entryStart - 1) + 1;
        if (/^[ \t]*$/.test(raw.slice(lineStart, entryStart))) entryStart = lineStart;
      }
      fields.set(selector, {
        selector,
        value: range(valueRange[0], valueRange[1]),
        entry: range(entryStart, entryEnd),
        insertion: byte(insertionChar),
      });
      if (isMap(value)) inspectMap(value, `${selector}/`);
      if (isSeq(value)) inspectSequence(value, selector);
    }
  };
  const inspectSequence = (sequence: import("yaml").YAMLSeq, selector: string) => {
    sequences.set(selector, sequence);
    fields.set(`${selector}/+`, {
      selector: `${selector}/+`,
      insertion: byte(sequence.flow ? sequence.range![1] - 1 : sequence.range![1]),
    });
    for (const [index, child] of sequence.items.entries()) {
      if (!isNode(child) || !child.range) throw new TypeError("Missing sequence ranges");
      let identity = String(index);
      if (
        (selector === "persons" || selector === "sources" || selector === "modules") &&
        isMap(child)
      ) {
        const key =
          selector !== "sources"
            ? child.get("id")
            : `${String(child.get("kind"))}/${String(child.get("config"))}`;
        if (typeof key !== "string") continue;
        identity = encodeURIComponent(key);
      }
      if (
        /^modules\/[^/]+\/pages$/.test(selector) &&
        isScalar(child) &&
        typeof child.value === "string"
      )
        identity = encodeURIComponent(child.value);
      const itemSelector = `${selector}/${identity}`;
      let start = child.range[0];
      let end = child.range[2];
      if (sequence.flow) {
        end = child.range[1];
        if (index + 1 < sequence.items.length) end = raw.indexOf(",", end) + 1;
        if (index > 0) start = raw.indexOf(",", (sequence.items[index - 1] as Node).range![1]);
      } else {
        const lineStart = raw.lastIndexOf("\n", start - 1) + 1;
        if (/^[ \t]*-\s*$/.test(raw.slice(lineStart, start))) start = lineStart;
      }
      fields.set(itemSelector, {
        selector: itemSelector,
        value: range(child.range[0], child.range[1]),
        entry: range(start, end),
        insertion: byte(sequence.range![1]),
      });
      values.set(itemSelector, child.toJSON());
      if (isMap(child)) inspectMap(child, `${itemSelector}/`);
      if (isSeq(child)) inspectSequence(child, itemSelector);
    }
  };
  inspectMap(root);
  const insertionChar = root.flow ? root.range![1] - 1 : root.range![1];
  return {
    document,
    root,
    fields,
    values,
    maps,
    sequences,
    insertion: byte(insertionChar),
    value: document.toJS({ maxAliasCount: 0 }) as Record<string, unknown>,
  };
}

/** Edits are applied to one base, never to shifting intermediate offsets. */
export function replaySourceByteEdits(
  base: Uint8Array,
  edits: readonly SourceByteEdit[],
): Uint8Array {
  let offset = 0;
  const chunks: Uint8Array[] = [];
  for (const edit of [...edits].sort((a, b) => a.start - b.start || a.end - b.end)) {
    if (
      !Number.isSafeInteger(edit.start) ||
      !Number.isSafeInteger(edit.end) ||
      edit.start < offset ||
      edit.end < edit.start ||
      edit.end > base.length ||
      sourceHash(base.slice(edit.start, edit.end)) !== edit.oldSha256
    )
      throw new TypeError("Invalid, overlapping or stale byte edits");
    chunks.push(base.slice(offset, edit.start), edit.replacement);
    offset = edit.end;
  }
  chunks.push(base.slice(offset));
  return new Uint8Array(Buffer.concat(chunks));
}

/** Stable record edits keep every unselected sequence item and surrounding syntax. */
export function patchSourceSequence(
  raw: string,
  selector: string,
  additions: readonly unknown[],
  removeSelectors: readonly string[],
  json = false,
): SourceByteEdit[] {
  const syntax = inspectSourceSyntax(raw, json);
  const sequence = syntax.sequences.get(selector);
  if (!sequence?.range) throw new TypeError("Expected an inspected sequence");
  const base = encodeSource(raw);
  const eol = raw.includes("\r\n") ? "\r\n" : "\n";
  const selected = new Set(removeSelectors);
  const entries = [...syntax.fields.values()].filter(
    (field) =>
      field.selector.startsWith(`${selector}/`) &&
      !field.selector.slice(selector.length + 1).includes("/") &&
      field.value,
  );
  const edits: SourceByteEdit[] = [];
  if ([...selected].some((selector) => !entries.some((entry) => entry.selector === selector)))
    throw new TypeError("Unknown sequence record");
  for (let index = 0; index < entries.length; index++) {
    if (!selected.has(entries[index].selector)) continue;
    const first = index;
    const selectors = [entries[index].selector];
    while (index + 1 < entries.length && selected.has(entries[index + 1].selector))
      selectors.push(entries[++index].selector);
    let start = entries[first].entry!.start;
    let end = entries[index].entry!.end;
    if (sequence.flow) {
      start = entries[first].value!.start;
      end = entries[index].value!.end;
      if (index + 1 < entries.length) end = entries[index].entry!.end;
      else if (first > 0) start = entries[first].entry!.start;
    }
    edits.push({
      start,
      end,
      selector: selectors.join(","),
      oldSha256: sourceHash(base.slice(start, end)),
      replacement:
        !sequence.flow && first === 0 && index === entries.length - 1 && !additions.length
          ? encodeSource(`${decodeSource(base.slice(start)).match(/^ */)![0]}[]${eol}`)
          : new Uint8Array(),
    });
  }
  if (additions.length) {
    const insertion = syntax.fields.get(`${selector}/+`)!.insertion;
    const retained = entries.length - selected.size;
    let text: string;
    if (sequence.flow)
      text = `${retained > 0 ? "," : ""}${additions.map((value) => JSON.stringify(value)).join(",")}`;
    else {
      const firstStart = entries[0]?.entry?.start;
      if (firstStart === undefined)
        throw new TypeError("Empty block sequence has no insertion anchor");
      const characterStart = decodeSource(base.slice(0, firstStart)).length;
      const line = raw.slice(characterStart).split(/\r?\n/, 1)[0];
      const indent = line.match(/^ */)![0];
      text = `${base[insertion - 1] === 10 ? "" : eol}${additions.map((value) => `${indent}- ${JSON.stringify(value)}${eol}`).join("")}`;
    }
    edits.push({
      start: insertion,
      end: insertion,
      selector: `${selector}/+`,
      oldSha256: sourceHash(new Uint8Array()),
      replacement: encodeSource(text),
    });
  }
  return edits;
}

/** Existing scalar/collection values change in place; untouched syntax stays exact. */
export function patchSourceFields(
  raw: string,
  updates: Readonly<Record<string, unknown>>,
  json = false,
): { bytes: Uint8Array; edits: SourceByteEdit[] } {
  const syntax = inspectSourceSyntax(raw, json);
  const base = encodeSource(raw);
  const edits: SourceByteEdit[] = [];
  const additions = new Map<string, Array<[string, unknown]>>();
  const removals = new Set<string>();
  const eol = raw.includes("\r\n") ? "\r\n" : "\n";
  for (const [selector, value] of Object.entries(updates)) {
    const field = syntax.fields.get(selector);
    if (field) {
      if (JSON.stringify(syntax.values.get(selector)) === JSON.stringify(value)) continue;
      const span = value === undefined ? field.entry : field.value;
      if (!span) throw new TypeError("Missing field range");
      const prefix = selector.slice(0, selector.lastIndexOf("/") + 1);
      if (value === undefined && syntax.maps.get(prefix)?.flow) {
        removals.add(selector);
        continue;
      }
      const trailingNewline = value !== undefined && base[span.end - 1] === 10 ? eol : "";
      edits.push({
        ...span,
        selector,
        oldSha256: sourceHash(base.slice(span.start, span.end)),
        replacement:
          value === undefined
            ? new Uint8Array()
            : encodeSource(JSON.stringify(value) + trailingNewline),
      });
    } else if (value !== undefined) {
      const prefix = selector.slice(0, selector.lastIndexOf("/") + 1);
      if (!syntax.maps.has(prefix)) throw new TypeError("Nested insertion needs an existing map");
      const entries = additions.get(prefix) ?? [];
      entries.push([selector, value]);
      additions.set(prefix, entries);
    }
  }
  for (const [prefix, map] of syntax.maps) {
    const pairs = map.items;
    if (!map.flow) {
      const selectors = pairs.map((pair) =>
        isScalar(pair.key) ? `${prefix}${encodeURIComponent(String(pair.key.value))}` : "",
      );
      if (
        selectors.length > 0 &&
        !additions.has(prefix) &&
        selectors.every(
          (selector) => Object.hasOwn(updates, selector) && updates[selector] === undefined,
        )
      ) {
        // Removing every entry must retain the map's empty value, not turn it into null.
        // Keep the replacement within the first admitted entry, including its indentation.
        const first = edits.find((edit) => edit.selector === selectors[0])!;
        const indent = decodeSource(base.slice(first.start, first.end)).match(/^[ \t]*/)![0];
        first.replacement = encodeSource(`${indent}{}${eol}`);
      }
      continue;
    }
    for (let index = 0; index < pairs.length; index++) {
      const key = pairs[index].key;
      if (
        !isScalar(key) ||
        typeof key.value !== "string" ||
        !removals.has(`${prefix}${encodeURIComponent(key.value)}`)
      )
        continue;
      const first = index;
      const selectors = [`${prefix}${encodeURIComponent(key.value)}`];
      while (index + 1 < pairs.length) {
        const nextKey = pairs[index + 1].key;
        if (
          !isScalar(nextKey) ||
          typeof nextKey.value !== "string" ||
          !removals.has(`${prefix}${encodeURIComponent(nextKey.value)}`)
        )
          break;
        selectors.push(`${prefix}${encodeURIComponent(nextKey.value)}`);
        index++;
      }
      const firstKey = pairs[first].key as Node;
      const lastValue = pairs[index].value as Node;
      let start = firstKey.range![0];
      let end = lastValue.range![1];
      if (index + 1 < pairs.length) end = raw.indexOf(",", end) + 1;
      else if (first > 0) start = raw.indexOf(",", (pairs[first - 1].value as Node).range![1]);
      const span = {
        start: encodeSource(raw.slice(0, start)).length,
        end: encodeSource(raw.slice(0, end)).length,
      };
      edits.push({
        ...span,
        selector: selectors.join(","),
        oldSha256: sourceHash(base.slice(span.start, span.end)),
        replacement: new Uint8Array(),
      });
    }
  }
  for (const [prefix, entries] of additions) {
    const map = syntax.maps.get(prefix)!;
    const insertionChar = map.flow ? map.range![1] - 1 : map.range![1];
    const offset = encodeSource(raw.slice(0, insertionChar)).length;
    let text: string;
    if (map.flow) {
      const retained = map.items.filter(
        (pair) =>
          isScalar(pair.key) &&
          !removals.has(`${prefix}${encodeURIComponent(String(pair.key.value))}`),
      );
      text = `${retained.length ? "," : ""}${entries.map(([selector, value]) => `${JSON.stringify(decodeURIComponent(selector.slice(prefix.length)))}:${JSON.stringify(value)}`).join(",")}`;
    } else {
      const firstKey = map.items[0]?.key as Node | undefined;
      const keyStart = firstKey?.range?.[0] ?? 0;
      const lineStart = raw.lastIndexOf("\n", keyStart - 1) + 1;
      const bomWidth = lineStart === 0 && raw.startsWith("\uFEFF") ? 1 : 0;
      const indent = " ".repeat(keyStart - lineStart - bomWidth);
      text = `${offset > 0 && base[offset - 1] !== 10 ? eol : ""}${entries
        .map(([selector, value]) => {
          const key = decodeURIComponent(selector.slice(prefix.length));
          const spelling =
            /^[a-zA-Z_][a-zA-Z0-9_-]*$/.test(key) && !/^(?:true|false|null)$/i.test(key)
              ? key
              : JSON.stringify(key);
          return `${indent}${spelling}: ${JSON.stringify(value)}${eol}`;
        })
        .join("")}`;
    }
    // One anchor edit carries all inserted keys; the caller must admit every selector.
    edits.push({
      start: offset,
      end: offset,
      selector: entries.map(([key]) => key).join(","),
      oldSha256: sourceHash(new Uint8Array()),
      replacement: encodeSource(text),
    });
  }
  const bytes = replaySourceByteEdits(base, edits);
  inspectSourceSyntax(decodeSource(bytes), json);
  return { bytes, edits };
}
