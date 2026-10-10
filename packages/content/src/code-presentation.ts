import { decodeString } from "micromark-util-decode-string";
import type { TreeNode } from "./model.js";
import type { ValidationIssue } from "./registry.js";
import { CONTENT_LIMITS, ContentLimitError } from "./limits.js";
import { codeTemplateProblem } from "./node-validation.js";

/** Bounds are independent of ordinary, unpresented code admission. */
export const CODE_PRESENTATION_LIMITS = Object.freeze({
  metadataLength: 16_384,
  selectionIntervals: 1_024,
  rows: 20_000,
  decorativeOutput: 8_000_000,
});

export type CodeLineRange = [number, number];
export type CodeLineSelection = CodeLineRange[];

/** Only explicitly authored keys are stored. Selections are closed, merged intervals. */
export interface CodePresentationOptions {
  filename?: string;
  title?: string;
  lineNumbers?: boolean;
  startLine?: number;
  highlight?: CodeLineSelection;
  focus?: CodeLineSelection;
  collapseAfter?: number;
  wrap?: boolean;
  added?: CodeLineSelection;
  removed?: CodeLineSelection;
}

export interface CodePresentationEffectiveOptions extends CodePresentationOptions {
  lineNumbers: boolean;
  startLine: number;
  wrap: boolean;
}

/** Fixed source order is part of the canonical writer policy. */
export const CODE_PRESENTATION_OPTION_KEYS = [
  "filename",
  "title",
  "lineNumbers",
  "startLine",
  "highlight",
  "focus",
  "collapseAfter",
  "wrap",
  "added",
  "removed",
] as const;

const selectionKeys = new Set(["highlight", "focus", "added", "removed"]);
const unsafeKeys = new Set(["__proto__", "constructor", "prototype"]);
const authoredKeys = new Map<string, keyof CodePresentationOptions>([
  ["filename", "filename"],
  ["title", "title"],
  ["lines", "lineNumbers"],
  ["startLine", "startLine"],
  ["highlight", "highlight"],
  ["focus", "focus"],
  ["collapseAfter", "collapseAfter"],
  ["wrap", "wrap"],
  ["added", "added"],
  ["removed", "removed"],
]);

export class CodePresentationError extends Error {
  readonly option?: string;

  constructor(
    readonly id: string,
    message: string,
    option?: string,
  ) {
    super(message);
    this.name = "CodePresentationError";
    if ((CODE_PRESENTATION_OPTION_KEYS as readonly string[]).includes(option ?? ""))
      this.option = option;
  }
}

function fail(id: string, message: string, option?: string): never {
  throw new CodePresentationError(`topik-code-presentation-${id}`, message, option);
}

function withOption<T>(option: string, action: () => T): T {
  try {
    return action();
  } catch (error) {
    if (error instanceof CodePresentationError)
      throw new CodePresentationError(error.id, error.message, option);
    throw error;
  }
}

function ownRecord(value: unknown): Record<string, PropertyDescriptor> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    fail("metadata", "Code presentation options require a plain object");
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null)
    fail("metadata", "Code presentation options require a plain object");
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const key of Reflect.ownKeys(descriptors)) {
    const descriptor = descriptors[key as string];
    if (
      typeof key !== "string" ||
      unsafeKeys.has(key) ||
      !descriptor.enumerable ||
      !("value" in descriptor)
    )
      fail("metadata", "Code presentation requires enumerable own data properties");
  }
  return descriptors;
}

function ownArray(value: unknown, message: string): unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype)
    fail("lines", message);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  if (
    keys.length !== value.length + 1 ||
    keys.some((key) => {
      if (key === "length") return false;
      const descriptor = descriptors[key as string];
      return (
        typeof key !== "string" ||
        !/^(0|[1-9][0-9]*)$/.test(key) ||
        Number(key) >= value.length ||
        !descriptor.enumerable ||
        !("value" in descriptor)
      );
    })
  )
    fail("lines", message);
  return value;
}

function positive(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function containsControls(value: string, allowTab = false): boolean {
  for (let index = 0; index < value.length; index++) {
    const unit = value.charCodeAt(index);
    if ((unit < 32 && !(allowTab && unit === 9)) || unit === 127) return true;
  }
  return false;
}

function mergeIntervals(intervals: CodeLineSelection): CodeLineSelection {
  intervals.sort((left, right) => left[0] - right[0] || left[1] - right[1]);
  const result: CodeLineSelection = [];
  for (const [start, end] of intervals) {
    const previous = result.at(-1);
    if (previous && start <= previous[1] + 1) previous[1] = Math.max(previous[1], end);
    else result.push([start, end]);
  }
  return result;
}

/** Parse ranges without expanding endpoints into individual row allocations. */
export function parseCodeLineSelection(value: string, rowCount: number): CodeLineSelection {
  if (value.length > CODE_PRESENTATION_LIMITS.metadataLength)
    throw new ContentLimitError("Code selection exceeds the metadata length limit");
  if (!value || !/^[1-9][0-9]*(?:-[1-9][0-9]*)?(?:,[1-9][0-9]*(?:-[1-9][0-9]*)?)*$/.test(value))
    fail("lines", "Line selections require positive numbers or closed ranges separated by commas");
  let count = 1;
  for (const character of value) if (character === ",") count++;
  if (count > CODE_PRESENTATION_LIMITS.selectionIntervals)
    throw new ContentLimitError("Code selections exceed the 1024 interval limit");
  const intervals: CodeLineSelection = [];
  for (const range of value.split(",")) {
    const [first, last] = range.split("-");
    const start = Number(first);
    const end = last === undefined ? start : Number(last);
    if (!positive(start) || !positive(end) || start > end || end > rowCount)
      fail("line-bounds", "Line selections must remain within the physical code rows");
    intervals.push([start, end]);
  }
  return mergeIntervals(intervals);
}

function normalizeSelection(value: unknown, rowCount: number): CodeLineSelection {
  const array = ownArray(value, "Normalized line selections require interval arrays");
  if (!array.length) fail("lines", "Line selections must not be empty");
  if (array.length > CODE_PRESENTATION_LIMITS.selectionIntervals)
    throw new ContentLimitError("Code selections exceed the 1024 interval limit");
  const seen = new Set<object>([array]);
  const intervals: CodeLineSelection = [];
  for (const item of array) {
    const interval = ownArray(item, "Line selections require pairs of positive integers");
    if (seen.has(interval)) fail("metadata", "Code presentation data must not be shared");
    seen.add(interval);
    if (interval.length !== 2) fail("lines", "Line selections require pairs of positive integers");
    const [start, end] = interval;
    if (!positive(start) || !positive(end) || start > end || end > rowCount)
      fail("line-bounds", "Line selections must remain within the physical code rows");
    intervals.push([start, end]);
  }
  return mergeIntervals(intervals);
}

function overlap(left: CodeLineSelection, right: CodeLineSelection): boolean {
  let first = 0;
  let second = 0;
  while (first < left.length && second < right.length) {
    if (left[first][1] < right[second][0]) first++;
    else if (right[second][1] < left[first][0]) second++;
    else return true;
  }
  return false;
}

export function normalizeCodePresentationOptions(
  value: unknown,
  rowCount: number,
): CodePresentationOptions {
  if (!positive(rowCount) || rowCount > CODE_PRESENTATION_LIMITS.rows)
    throw new ContentLimitError("Presented code exceeds the 20000 physical row limit");
  const descriptors = ownRecord(value);
  const result: CodePresentationOptions = {};
  const claimed = new Set<object>();
  for (const key of Object.keys(descriptors)) {
    if (!(CODE_PRESENTATION_OPTION_KEYS as readonly string[]).includes(key))
      fail("option", "Code presentation contains an unsupported option");
    const input = descriptors[key].value;
    if (key === "filename" || key === "title") {
      if (
        typeof input !== "string" ||
        !input.trim() ||
        input.length > 256 ||
        containsControls(input)
      )
        fail(
          "option",
          `${key} must be a nonblank single-line string of at most 256 UTF-16 units`,
          key,
        );
      result[key] = input;
    } else if (key === "lineNumbers" || key === "wrap") {
      if (typeof input !== "boolean") fail("option", `${key} must be a boolean`, key);
      result[key] = input;
    } else if (key === "startLine") {
      if (!positive(input) || input > 1_000_000_000 || !Number.isSafeInteger(input + rowCount - 1))
        fail(
          "option",
          "startLine must be an integer from 1 to 1000000000 with safe final labels",
          key,
        );
      result.startLine = input;
    } else if (key === "collapseAfter") {
      if (!positive(input) || input >= rowCount)
        fail(
          "option",
          "collapseAfter must leave at least one physical row available to expand",
          key,
        );
      result.collapseAfter = input;
    } else if (selectionKeys.has(key)) {
      result[key as "highlight" | "focus" | "added" | "removed"] = withOption(key, () => {
        if (input && typeof input === "object") {
          if (claimed.has(input)) fail("metadata", "Code presentation data must not be shared");
          claimed.add(input);
          for (const item of ownArray(
            input,
            "Normalized line selections require interval arrays",
          )) {
            if (item && typeof item === "object") {
              if (claimed.has(item)) fail("metadata", "Code presentation data must not be shared");
              claimed.add(item);
            }
          }
        }
        return normalizeSelection(input, rowCount);
      });
    }
  }
  if (result.added && result.removed && overlap(result.added, result.removed))
    fail("diff-conflict", "added and removed line selections must be disjoint", "added");
  return result;
}

/** The parser reads this raw source spelling before CommonMark unescaping. */
export function parseCodePresentationMetadata(
  rawMeta: string,
  rowCount: number,
): { options: CodePresentationOptions; opaqueMetaSuffix: string } | undefined {
  if (rawMeta.length > CONTENT_LIMITS.sourceLength)
    throw new ContentLimitError("Code presentation metadata exceeds the source length limit");
  let cursor = 0;
  while (horizontal(rawMeta[cursor])) cursor++;
  const start = cursor;
  const values: Record<string, unknown> = {};
  let suffixStart = cursor;
  const bounded = () => {
    if (cursor - start > CODE_PRESENTATION_LIMITS.metadataLength)
      throw new ContentLimitError(
        "Code presentation attributes exceed the 16384 UTF-16 unit limit",
      );
  };
  while (cursor < rawMeta.length) {
    const nameStart = cursor;
    while (nameCharacter(rawMeta[cursor])) cursor++;
    const name = rawMeta.slice(nameStart, cursor);
    const key = authoredKeys.get(name);
    if (
      !key ||
      (cursor < rawMeta.length && !horizontal(rawMeta[cursor]) && rawMeta[cursor] !== "=")
    )
      break;
    if (Object.hasOwn(values, key))
      fail("metadata", "Code presentation contains a duplicate attribute", key);
    bounded();
    const afterName = cursor;
    while (horizontal(rawMeta[cursor])) cursor++;
    let input: unknown;
    if (rawMeta[cursor] !== "=") {
      if (key !== "lineNumbers" && key !== "wrap")
        fail("option", `${name} requires an assigned value`, key);
      cursor = afterName;
      if (cursor < rawMeta.length && !horizontal(rawMeta[cursor]))
        fail("metadata", "Code presentation attributes require whitespace separators", key);
      input = true;
    } else {
      cursor++;
      while (horizontal(rawMeta[cursor])) cursor++;
      bounded();
      const quote =
        rawMeta[cursor] === '"' || rawMeta[cursor] === "'" ? rawMeta[cursor++] : undefined;
      const valueStart = cursor;
      if (quote) {
        let closed = false;
        while (cursor < rawMeta.length) {
          const character = rawMeta[cursor++];
          bounded();
          if (character === "\\") {
            if (cursor < rawMeta.length) cursor++;
            bounded();
          } else if (character === quote) {
            closed = true;
            break;
          }
        }
        if (!closed) fail("metadata", "Close the quoted code presentation attribute value", key);
      } else {
        while (cursor < rawMeta.length && !horizontal(rawMeta[cursor])) {
          cursor++;
          bounded();
        }
      }
      const valueEnd = quote ? cursor - 1 : cursor;
      if (valueEnd === valueStart && !quote)
        fail("option", `${name} requires an assigned value`, key);
      if (cursor < rawMeta.length && !horizontal(rawMeta[cursor]))
        fail("metadata", "Code presentation attributes require whitespace separators", key);
      const value = decodeString(rawMeta.slice(valueStart, valueEnd));
      if (key === "lineNumbers" || key === "wrap") {
        if (value !== "true" && value !== "false")
          fail("option", `${name} must be true or false`, key);
        input = value === "true";
      } else if (key === "startLine" || key === "collapseAfter") {
        if (!/^[1-9][0-9]*$/.test(value))
          fail("option", `${name} requires a positive decimal integer`, key);
        input = Number(value);
      } else if (selectionKeys.has(key)) {
        input = withOption(key, () => parseCodeLineSelection(value, rowCount));
      } else input = value;
    }
    values[key] = input;
    bounded();
    suffixStart = cursor;
    while (horizontal(rawMeta[cursor])) cursor++;
  }
  if (!Object.keys(values).length) return undefined;
  const opaqueMetaSuffix = decodeString(rawMeta.slice(suffixStart));
  assertCodePresentationSuffix(opaqueMetaSuffix);
  const options = normalizeCodePresentationOptions(values, rowCount);
  assertCanonicalAttributeLimit(options);
  return { options, opaqueMetaSuffix };
}

function horizontal(value: string | undefined): boolean {
  return value === " " || value === "\t";
}

function nameCharacter(value: string | undefined): boolean {
  return value !== undefined && /[A-Za-z0-9_-]/.test(value);
}

export function assertCodePresentationSuffix(value: unknown): asserts value is string {
  if (
    typeof value !== "string" ||
    (value.length > 0 && value[0] !== " " && value[0] !== "\t") ||
    containsControls(value, true)
  )
    fail("metadata", "Opaque metadata suffix must be single-line and retain separating whitespace");
}

/** Quote raw fence attributes before exactly one CommonMark decoding pass. */
function quoteAttribute(value: string): string {
  let result = '"';
  for (let index = 0; index < value.length; index++) {
    const character = value[index];
    if (character === '"') result += '\\"';
    else if (character === "\\") result += "&#92;";
    else if (character === "&" && entityAt(value, index)) result += "&#38;";
    else if (character === "`") result += "&#96;";
    else result += character;
  }
  return result + '"';
}

function entityAt(value: string, index: number): boolean {
  return /^&(?:#[0-9]+|#[xX][0-9A-Fa-f]+|[A-Za-z][A-Za-z0-9]*);/.test(value.slice(index));
}

/** A decoded opaque suffix may start with a word that otherwise becomes an option. */
function suffixProtectedIndex(suffix: string): number | undefined {
  let cursor = 0;
  while (horizontal(suffix[cursor])) cursor++;
  const start = cursor;
  while (nameCharacter(suffix[cursor])) cursor++;
  return authoredKeys.has(suffix.slice(start, cursor)) &&
    (cursor === suffix.length || horizontal(suffix[cursor]) || suffix[cursor] === "=")
    ? start
    : undefined;
}

/** Single-pass CommonMark encoding also preserves entity-looking decoded text. */
export function encodeCodePresentationSuffix(suffix: string): string {
  assertCodePresentationSuffix(suffix);
  if (encodedSuffixLength(suffix) > CONTENT_LIMITS.sourceLength)
    throw new ContentLimitError("Code presentation suffix exceeds the source length limit");
  const protectedIndex = suffixProtectedIndex(suffix);
  let result = "";
  for (let index = 0; index < suffix.length; index++) {
    const character = suffix[index];
    if (index === protectedIndex) result += `&#${character.charCodeAt(0)};`;
    else if (character === "&") result += "&#38;";
    else if (character === "\\") result += "&#92;";
    else if (character === "`") result += "&#96;";
    else result += character;
  }
  return result;
}

function encodedSuffixLength(suffix: string): number {
  let length = suffix.length;
  for (let index = 0; index < suffix.length; index++)
    if (suffix[index] === "&" || suffix[index] === "\\" || suffix[index] === "`") length += 4;
  const protectedIndex = suffixProtectedIndex(suffix);
  if (protectedIndex !== undefined) length += String(suffix.charCodeAt(protectedIndex)).length + 2;
  return length;
}

function selectionSource(value: CodeLineSelection): string {
  return value.map(([start, end]) => (start === end ? String(start) : `${start}-${end}`)).join(",");
}

/** Measure quoted attribute output without allocating its escaped spelling. */
function quotedAttributeLength(value: string): number {
  let length = 2;
  for (let index = 0; index < value.length; index++) {
    const unit = value.charCodeAt(index);
    if (unit === 34) length += 2;
    else if (unit === 92 || unit === 96 || (unit === 38 && entityAt(value, index))) length += 5;
    else length++;
  }
  return length;
}

function canonicalAttributeLength(options: CodePresentationOptions): number {
  let length = 0;
  let members = 0;
  for (const key of CODE_PRESENTATION_OPTION_KEYS) {
    if (!Object.hasOwn(options, key)) continue;
    if (members++) length++;
    const name = key === "lineNumbers" ? "lines" : key;
    length += name.length;
    const value = options[key];
    if (typeof value === "boolean" && value) continue;
    length++;
    if (Array.isArray(value)) {
      length += 2;
      for (let index = 0; index < value.length; index++) {
        if (index > 0) length++;
        const [start, end] = value[index];
        length += String(start).length;
        if (start !== end) length += 1 + String(end).length;
      }
    } else
      length += typeof value === "string" ? quotedAttributeLength(value) : String(value).length;
  }
  return length;
}

function assertCanonicalAttributeLimit(options: CodePresentationOptions): number {
  const length = canonicalAttributeLength(options);
  if (!length) fail("metadata", "Code presentation requires at least one authored option");
  if (length > CODE_PRESENTATION_LIMITS.metadataLength)
    throw new ContentLimitError("Code presentation attributes exceed the 16384 UTF-16 unit limit");
  return length;
}

/** Source writers can reserve escaped header growth before any string emission. */
export function codePresentationMetadataLength(
  options: CodePresentationOptions,
  opaqueMetaSuffix: string,
): number {
  const normalized = normalizeCodePresentationOptions(options, CODE_PRESENTATION_LIMITS.rows);
  assertCodePresentationSuffix(opaqueMetaSuffix);
  return assertCanonicalAttributeLimit(normalized) + encodedSuffixLength(opaqueMetaSuffix);
}

/** Returns a raw fence header. Do not pass it through Markdown unescaping or safe(). */
export function serializeCodePresentationMetadata(
  options: CodePresentationOptions,
  opaqueMetaSuffix: string,
): string {
  const normalized = normalizeCodePresentationOptions(options, CODE_PRESENTATION_LIMITS.rows);
  const attributeLength = assertCanonicalAttributeLimit(normalized);
  assertCodePresentationSuffix(opaqueMetaSuffix);
  if (attributeLength + encodedSuffixLength(opaqueMetaSuffix) > CONTENT_LIMITS.sourceLength)
    throw new ContentLimitError("Code presentation metadata exceeds the source length limit");
  const members: string[] = [];
  for (const key of CODE_PRESENTATION_OPTION_KEYS) {
    if (!Object.hasOwn(normalized, key)) continue;
    const value = normalized[key];
    const name = key === "lineNumbers" ? "lines" : key;
    if (typeof value === "boolean" && value) {
      members.push(name);
      continue;
    }
    const encoded = Array.isArray(value)
      ? quoteAttribute(selectionSource(value))
      : typeof value === "string"
        ? quoteAttribute(value)
        : String(value);
    members.push(`${name}=${encoded}`);
  }
  return members.join(" ") + encodeCodePresentationSuffix(opaqueMetaSuffix);
}

export function effectiveCodePresentationOptions(
  options: CodePresentationOptions,
): CodePresentationEffectiveOptions {
  return {
    ...options,
    lineNumbers: options.lineNumbers ?? false,
    startLine: options.startLine ?? 1,
    wrap: options.wrap ?? false,
  };
}

export function codePresentationRows(payload: string): number {
  let count = 1;
  for (let index = 0; index < payload.length; index++) if (payload[index] === "\n") count++;
  return count;
}

/** Template substitutions are scalar single-line text, so literals define physical rows. */
export function codePresentationChildRows(child: TreeNode): number {
  if (child.type === "code")
    return codePresentationRows(typeof child.value === "string" ? child.value : "");
  let count = 1;
  const segments = child.template?.segments;
  if (!Array.isArray(segments)) return count;
  for (const segment of segments)
    if (segment?.type === "literal" && typeof segment.value === "string")
      count += codePresentationRows(segment.value) - 1;
  return count;
}

/** Run after the document's descriptor/plain-data admission and before callbacks. */
export function codePresentationProblem(
  node: TreeNode,
  seen = new Set<object>(),
): ValidationIssue | undefined {
  try {
    if (
      Object.keys(node).some(
        (key) =>
          !["type", "children", "options", "opaqueMetaSuffix", "position", "data"].includes(key),
      ) ||
      !Array.isArray(node.children) ||
      node.children.length !== 1 ||
      !["code", "topikCodeTemplate"].includes(node.children[0]?.type)
    )
      fail("scope", "A code presentation must own exactly one code or code-template child");
    const child = node.children[0];
    if (child.meta != null)
      fail(
        "metadata",
        "Presentation options and opaque suffix are authoritative; child metadata must be absent",
      );
    if (
      child.lang != null &&
      (typeof child.lang !== "string" ||
        !child.lang ||
        containsControls(child.lang) ||
        child.lang.includes(" "))
    )
      fail("language", "Presented code language must fit one literal fence header word");
    if (child.lang === "mermaid") fail("language", "Presented code requires a text code renderer");
    if (child.type === "topikCodeTemplate") {
      const problem = codeTemplateProblem(child);
      if (problem) return problem;
    }
    const normalized = normalizeCodePresentationOptions(
      node.options,
      codePresentationChildRows(child),
    );
    assertCanonicalAttributeLimit(normalized);
    const claim = (value: object) => {
      if (seen.has(value))
        fail("metadata", "Code presentation data must not be shared between authoring positions");
      seen.add(value);
    };
    claim(node.options!);
    for (const value of Object.values(node.options!))
      if (Array.isArray(value)) {
        claim(value);
        for (const interval of value) claim(interval);
      }
    assertCodePresentationSuffix(node.opaqueMetaSuffix);
  } catch (error) {
    if (error instanceof CodePresentationError || error instanceof ContentLimitError)
      return {
        id: error.id,
        message: error.message,
        ...(error instanceof CodePresentationError && error.option !== undefined
          ? { option: error.option }
          : {}),
      };
    throw error;
  }
}
