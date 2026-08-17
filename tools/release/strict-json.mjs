export function parseStrictJson(source, label = "JSON") {
  if (typeof source !== "string") throw new TypeError(`${label} must be text`);
  const parser = new StrictJsonParser(source, label);
  const value = parser.parseValue();
  parser.skipWhitespace();
  if (!parser.atEnd()) parser.fail("has trailing data");
  return value;
}

class StrictJsonParser {
  constructor(source, label) {
    this.source = source;
    this.label = label;
    this.offset = 0;
  }

  parseValue() {
    this.skipWhitespace();
    const token = this.source[this.offset];
    if (token === "{") return this.parseObject();
    if (token === "[") return this.parseArray();
    if (token === '"') return this.parseString();
    if (token === "t") return this.parseKeyword("true", true);
    if (token === "f") return this.parseKeyword("false", false);
    if (token === "n") return this.parseKeyword("null", null);
    if (token === "-" || (token >= "0" && token <= "9")) return this.parseNumber();
    this.fail("contains an invalid value");
  }

  parseObject() {
    this.offset++;
    const value = Object.create(null);
    const keys = new Set();
    this.skipWhitespace();
    if (this.source[this.offset] === "}") {
      this.offset++;
      return value;
    }

    while (true) {
      this.skipWhitespace();
      if (this.source[this.offset] !== '"') this.fail("contains an invalid object key");
      const key = this.parseString();
      if (keys.has(key)) this.fail("contains a duplicate object key");
      keys.add(key);
      this.skipWhitespace();
      if (this.source[this.offset] !== ":") this.fail("contains an invalid object entry");
      this.offset++;
      value[key] = this.parseValue();
      this.skipWhitespace();
      const token = this.source[this.offset++];
      if (token === "}") return value;
      if (token !== ",") this.fail("contains an unterminated object");
    }
  }

  parseArray() {
    this.offset++;
    const value = [];
    this.skipWhitespace();
    if (this.source[this.offset] === "]") {
      this.offset++;
      return value;
    }

    while (true) {
      value.push(this.parseValue());
      this.skipWhitespace();
      const token = this.source[this.offset++];
      if (token === "]") return value;
      if (token !== ",") this.fail("contains an unterminated array");
    }
  }

  parseString() {
    const start = this.offset++;
    while (!this.atEnd()) {
      const token = this.source[this.offset++];
      if (token === '"') {
        try {
          return JSON.parse(this.source.slice(start, this.offset));
        } catch {
          this.fail("contains an invalid string");
        }
      }
      if (token === "\\") {
        this.offset++;
        continue;
      }
      if (token.charCodeAt(0) < 0x20) this.fail("contains an invalid string");
    }
    this.fail("contains an unterminated string");
  }

  parseNumber() {
    const match = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/u.exec(
      this.source.slice(this.offset),
    );
    if (match === null) this.fail("contains an invalid number");
    this.offset += match[0].length;
    const value = Number(match[0]);
    if (!Number.isFinite(value)) this.fail("contains a non-finite number");
    return value;
  }

  parseKeyword(keyword, value) {
    if (!this.source.startsWith(keyword, this.offset)) this.fail("contains an invalid value");
    this.offset += keyword.length;
    return value;
  }

  skipWhitespace() {
    while (/\s/u.test(this.source[this.offset] ?? "") && this.source[this.offset] !== "\u00a0") {
      const token = this.source[this.offset];
      if (token !== " " && token !== "\n" && token !== "\r" && token !== "\t") break;
      this.offset++;
    }
  }

  atEnd() {
    return this.offset >= this.source.length;
  }

  fail(message) {
    throw new Error(`${this.label} ${message}`);
  }
}
