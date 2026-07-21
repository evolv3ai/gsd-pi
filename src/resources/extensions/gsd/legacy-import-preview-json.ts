// Project/App: gsd-pi
// File Purpose: Exact byte-token lookup for retained UTF-8 JSON.

import { deepFreeze } from "./legacy-import-utils.js";

import { isUtf8 } from "node:buffer";

import type { LegacyImportValue } from "./legacy-import-contract.js";

export type LegacyImportJsonErrorCode =
  | "LEGACY_IMPORT_JSON_INVALID_UTF8"
  | "LEGACY_IMPORT_JSON_MALFORMED"
  | "LEGACY_IMPORT_JSON_DUPLICATE_KEY"
  | "LEGACY_IMPORT_JSON_POINTER_INVALID"
  | "LEGACY_IMPORT_JSON_POINTER_MISSING";

export class LegacyImportJsonError extends Error {
  readonly code: LegacyImportJsonErrorCode;
  readonly byteOffset?: number;

  constructor(code: LegacyImportJsonErrorCode, message: string, byteOffset?: number) {
    super(message);
    this.name = "LegacyImportJsonError";
    this.code = code;
    this.byteOffset = byteOffset;
  }
}

export interface LegacyImportJsonToken {
  readonly json_pointer: string;
  readonly start_byte: number;
  readonly end_byte: number;
  readonly value: LegacyImportValue;
}

export interface LegacyImportJsonDocument {
  readonly value: LegacyImportValue;
  locate(jsonPointer: string): LegacyImportJsonToken;
}

const MAX_DEPTH = 512;

function malformed(message: string, byteOffset: number): LegacyImportJsonError {
  return new LegacyImportJsonError("LEGACY_IMPORT_JSON_MALFORMED", message, byteOffset);
}

function pointerSegment(value: string): string {
  return value.replace(/~/gu, "~0").replace(/\//gu, "~1");
}

function canonicalPointer(pointer: string): string {
  if (pointer === "") return pointer;
  if (!pointer.startsWith("/")) {
    throw new LegacyImportJsonError(
      "LEGACY_IMPORT_JSON_POINTER_INVALID",
      "JSON pointer must be empty or begin with a slash",
    );
  }
  const decoded = pointer.slice(1).split("/").map((segment) => {
    if (/~(?![01])/u.test(segment)) {
      throw new LegacyImportJsonError(
        "LEGACY_IMPORT_JSON_POINTER_INVALID",
        "JSON pointer contains an invalid escape",
      );
    }
    return segment.replace(/~1/gu, "/").replace(/~0/gu, "~");
  });
  return `/${decoded.map(pointerSegment).join("/")}`;
}

class JsonByteParser {
  private readonly bytes: Buffer;
  private offset = 0;
  private readonly tokens = new Map<string, LegacyImportJsonToken>();

  constructor(bytes: Buffer) {
    this.bytes = bytes;
  }

  parse(): LegacyImportJsonDocument {
    this.skipWhitespace();
    const value = this.parseValue("", 0);
    this.skipWhitespace();
    if (this.offset !== this.bytes.length) {
      throw malformed("JSON contains trailing content", this.offset);
    }
    deepFreeze(value);
    for (const token of this.tokens.values()) Object.freeze(token);
    const locate = (jsonPointer: string): LegacyImportJsonToken => {
      const normalized = canonicalPointer(jsonPointer);
      const token = this.tokens.get(normalized);
      if (token === undefined) {
        throw new LegacyImportJsonError(
          "LEGACY_IMPORT_JSON_POINTER_MISSING",
          `JSON pointer does not exist: ${jsonPointer}`,
        );
      }
      return token;
    };
    return Object.freeze({ value, locate });
  }

  private parseValue(pointer: string, depth: number): LegacyImportValue {
    if (depth > MAX_DEPTH) throw malformed("JSON nesting is too deep", this.offset);
    this.skipWhitespace();
    const start = this.offset;
    const byte = this.bytes[this.offset];
    let value: LegacyImportValue;
    if (byte === 34) value = this.parseString();
    else if (byte === 123) value = this.parseObject(pointer, depth);
    else if (byte === 91) value = this.parseArray(pointer, depth);
    else if (byte === 116) value = this.parseLiteral("true", true);
    else if (byte === 102) value = this.parseLiteral("false", false);
    else if (byte === 110) value = this.parseLiteral("null", null);
    else if (byte === 45 || (byte !== undefined && byte >= 48 && byte <= 57)) value = this.parseNumber();
    else throw malformed("JSON value is malformed", this.offset);
    this.tokens.set(pointer, {
      json_pointer: pointer,
      start_byte: start,
      end_byte: this.offset,
      value,
    });
    return value;
  }

  private parseObject(pointer: string, depth: number): LegacyImportValue {
    const value: Record<string, LegacyImportValue> = {};
    const keys = new Set<string>();
    this.offset += 1;
    this.skipWhitespace();
    if (this.bytes[this.offset] === 125) {
      this.offset += 1;
      return value;
    }
    while (this.offset < this.bytes.length) {
      this.skipWhitespace();
      const keyStart = this.offset;
      if (this.bytes[this.offset] !== 34) throw malformed("JSON object key must be a string", this.offset);
      const key = this.parseString();
      if (keys.has(key)) {
        throw new LegacyImportJsonError(
          "LEGACY_IMPORT_JSON_DUPLICATE_KEY",
          `JSON object contains a duplicate key: ${key}`,
          keyStart,
        );
      }
      keys.add(key);
      this.skipWhitespace();
      if (this.bytes[this.offset] !== 58) throw malformed("JSON object key lacks a colon", this.offset);
      this.offset += 1;
      const childPointer = `${pointer}/${pointerSegment(key)}`;
      const child = this.parseValue(childPointer, depth + 1);
      Object.defineProperty(value, key, {
        value: child,
        enumerable: true,
      });
      this.skipWhitespace();
      if (this.bytes[this.offset] === 125) {
        this.offset += 1;
        return value;
      }
      if (this.bytes[this.offset] !== 44) throw malformed("JSON object entries must be comma-separated", this.offset);
      this.offset += 1;
    }
    throw malformed("JSON object is unterminated", this.offset);
  }

  private parseArray(pointer: string, depth: number): LegacyImportValue {
    const value: LegacyImportValue[] = [];
    this.offset += 1;
    this.skipWhitespace();
    if (this.bytes[this.offset] === 93) {
      this.offset += 1;
      return value;
    }
    while (this.offset < this.bytes.length) {
      value.push(this.parseValue(`${pointer}/${value.length}`, depth + 1));
      this.skipWhitespace();
      if (this.bytes[this.offset] === 93) {
        this.offset += 1;
        return value;
      }
      if (this.bytes[this.offset] !== 44) throw malformed("JSON array entries must be comma-separated", this.offset);
      this.offset += 1;
    }
    throw malformed("JSON array is unterminated", this.offset);
  }

  private parseString(): string {
    const start = this.offset;
    this.offset += 1;
    while (this.offset < this.bytes.length) {
      const byte = this.bytes[this.offset];
      if (byte === 34) {
        this.offset += 1;
        try {
          return JSON.parse(this.bytes.subarray(start, this.offset).toString("utf8")) as string;
        } catch {
          throw malformed("JSON string is malformed", start);
        }
      }
      if (byte === undefined || byte < 32) throw malformed("JSON string contains a control byte", this.offset);
      if (byte !== 92) {
        this.offset += 1;
        continue;
      }
      this.offset += 1;
      const escape = this.bytes[this.offset];
      if (escape === 117) {
        for (let index = 1; index <= 4; index += 1) {
          const hex = this.bytes[this.offset + index];
          if (hex === undefined || !(
            (hex >= 48 && hex <= 57)
            || (hex >= 65 && hex <= 70)
            || (hex >= 97 && hex <= 102)
          )) {
            throw malformed("JSON string contains an invalid Unicode escape", this.offset);
          }
        }
        this.offset += 5;
      } else if (
        escape === 34
        || escape === 47
        || escape === 92
        || escape === 98
        || escape === 102
        || escape === 110
        || escape === 114
        || escape === 116
      ) {
        this.offset += 1;
      } else {
        throw malformed("JSON string contains an invalid escape", this.offset);
      }
    }
    throw malformed("JSON string is unterminated", start);
  }

  private parseNumber(): number {
    const start = this.offset;
    if (this.bytes[this.offset] === 45) this.offset += 1;
    if (this.bytes[this.offset] === 48) {
      this.offset += 1;
    } else {
      const first = this.bytes[this.offset];
      if (first === undefined || first < 49 || first > 57) throw malformed("JSON number is malformed", this.offset);
      while (this.isDigit(this.bytes[this.offset])) this.offset += 1;
    }
    if (this.bytes[this.offset] === 46) {
      this.offset += 1;
      if (!this.isDigit(this.bytes[this.offset])) throw malformed("JSON fraction is malformed", this.offset);
      while (this.isDigit(this.bytes[this.offset])) this.offset += 1;
    }
    if (this.bytes[this.offset] === 69 || this.bytes[this.offset] === 101) {
      this.offset += 1;
      if (this.bytes[this.offset] === 43 || this.bytes[this.offset] === 45) this.offset += 1;
      if (!this.isDigit(this.bytes[this.offset])) throw malformed("JSON exponent is malformed", this.offset);
      while (this.isDigit(this.bytes[this.offset])) this.offset += 1;
    }
    const value = Number(this.bytes.subarray(start, this.offset).toString("ascii"));
    if (!Number.isFinite(value)) throw malformed("JSON number is outside the supported range", start);
    return value;
  }

  private parseLiteral<T extends boolean | null>(text: string, value: T): T {
    const end = this.offset + text.length;
    if (this.bytes.subarray(this.offset, end).toString("ascii") !== text) {
      throw malformed("JSON literal is malformed", this.offset);
    }
    this.offset = end;
    return value;
  }

  private isDigit(byte: number | undefined): boolean {
    return byte !== undefined && byte >= 48 && byte <= 57;
  }

  private skipWhitespace(): void {
    while (
      this.bytes[this.offset] === 32
      || this.bytes[this.offset] === 9
      || this.bytes[this.offset] === 10
      || this.bytes[this.offset] === 13
    ) {
      this.offset += 1;
    }
  }
}

export function parseLegacyImportJson(bytes: Buffer): LegacyImportJsonDocument {
  if (!isUtf8(bytes)) {
    throw new LegacyImportJsonError(
      "LEGACY_IMPORT_JSON_INVALID_UTF8",
      "Retained JSON bytes are not valid UTF-8",
    );
  }
  return new JsonByteParser(Buffer.from(bytes)).parse();
}
