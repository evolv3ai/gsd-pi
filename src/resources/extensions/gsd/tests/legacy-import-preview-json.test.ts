// Project/App: gsd-pi
// File Purpose: Exact behavioral tests for retained JSON byte-token lookup.

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  LegacyImportJsonError,
  parseLegacyImportJson,
} from "../legacy-import-preview-json.ts";

describe("legacy import JSON byte tokens", () => {
  test("locates values across whitespace, key order, escapes, and multibyte text", () => {
    const bytes = Buffer.from(`{
  "other": true,
  "assessments": [
    {"scope": "run-uat", "status" : "p\\u0061ss", "note": "café"}
  ],
  "a/b~c": null
}`);
    const document = parseLegacyImportJson(bytes);

    const status = document.locate("/assessments/0/status");
    assert.deepEqual(status, {
      json_pointer: "/assessments/0/status",
      start_byte: bytes.indexOf(Buffer.from('"p\\u0061ss"')),
      end_byte: bytes.indexOf(Buffer.from('"p\\u0061ss"')) + Buffer.byteLength('"p\\u0061ss"'),
      value: "pass",
    });
    assert.equal(bytes.subarray(status.start_byte, status.end_byte).toString("utf8"), '"p\\u0061ss"');
    assert.equal(document.locate("/assessments/0/note").value, "café");
    assert.deepEqual(document.locate("/a~1b~0c"), {
      json_pointer: "/a~1b~0c",
      start_byte: bytes.indexOf(Buffer.from("null")),
      end_byte: bytes.indexOf(Buffer.from("null")) + 4,
      value: null,
    });
    assert.deepEqual(document.locate("").value, document.value);
  });

  test("locates container, number, boolean, and null tokens", () => {
    const bytes = Buffer.from('{"array":[-12.5e+2,false,null,{"x":1}]}');
    const document = parseLegacyImportJson(bytes);
    assert.equal(document.locate("/array").value instanceof Array, true);
    assert.equal(document.locate("/array/0").value, -1250);
    assert.equal(document.locate("/array/1").value, false);
    assert.equal(document.locate("/array/2").value, null);
    assert.deepEqual(document.locate("/array/3").value, { x: 1 });
    assert.equal(bytes.subarray(
      document.locate("/array").start_byte,
      document.locate("/array").end_byte,
    ).toString("utf8"), '[-12.5e+2,false,null,{"x":1}]');
    assert.equal(Object.isFrozen(document), true);
    assert.equal(Object.isFrozen(document.value), true);
    assert.equal(Object.isFrozen(document.locate("/array")), true);
    assert.equal(Object.isFrozen(document.locate("/array").value), true);
  });

  test("keeps special object keys as inert own data", () => {
    const document = parseLegacyImportJson(Buffer.from(
      '{"__proto__":{"polluted":true},"constructor":"data"}',
    ));
    assert.equal(Object.getPrototypeOf(document.value), Object.prototype);
    assert.equal(Object.hasOwn(document.value as object, "__proto__"), true);
    assert.deepEqual(document.locate("/__proto__").value, { polluted: true });
    assert.equal(document.locate("/constructor").value, "data");
    assert.equal((Object.prototype as { polluted?: boolean }).polluted, undefined);
  });

  test("rejects duplicate decoded keys, malformed JSON, invalid UTF-8, and bad pointers", () => {
    assert.throws(
      () => parseLegacyImportJson(Buffer.from('{"a":1,"\\u0061":2}')),
      (error) => error instanceof LegacyImportJsonError && error.code === "LEGACY_IMPORT_JSON_DUPLICATE_KEY",
    );
    assert.throws(
      () => parseLegacyImportJson(Buffer.from('{"a":[1,]}')),
      (error) => error instanceof LegacyImportJsonError && error.code === "LEGACY_IMPORT_JSON_MALFORMED",
    );
    assert.throws(
      () => parseLegacyImportJson(Buffer.from([0x22, 0xc3, 0x28, 0x22])),
      (error) => error instanceof LegacyImportJsonError && error.code === "LEGACY_IMPORT_JSON_INVALID_UTF8",
    );
    const document = parseLegacyImportJson(Buffer.from('{"a":1}'));
    assert.throws(
      () => document.locate("a"),
      (error) => error instanceof LegacyImportJsonError && error.code === "LEGACY_IMPORT_JSON_POINTER_INVALID",
    );
    assert.throws(
      () => document.locate("/missing"),
      (error) => error instanceof LegacyImportJsonError && error.code === "LEGACY_IMPORT_JSON_POINTER_MISSING",
    );
    assert.throws(
      () => document.locate("/a~2"),
      (error) => error instanceof LegacyImportJsonError && error.code === "LEGACY_IMPORT_JSON_POINTER_INVALID",
    );
    assert.throws(
      () => parseLegacyImportJson(Buffer.from(`${"[".repeat(514)}0${"]".repeat(514)}`)),
      (error) => error instanceof LegacyImportJsonError && error.code === "LEGACY_IMPORT_JSON_MALFORMED",
    );
  });
});
