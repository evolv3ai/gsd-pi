// Project/App: gsd-pi
// File Purpose: Regression tests for sharp module-shape normalization in screenshot-constraints.
// Copyright (c) 2026 Jeremy McSpadden <jeremy@fluxlabs.net>

import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { inspect } from "node:util";

const { resolveSharpFactory, getScreenshotBufferDimensions, __setSharpForTesting } = await import(
  "../screenshot-constraints.ts"
);

// sharp has two type/runtime surfaces (see the header comment in
// screenshot-constraints.ts): an ESM namespace whose `default` is the callable
// factory, and a CJS `export = sharp` interop result that *is* the factory.
// getSharp() used to read `.default` unconditionally, which cached `undefined`
// for the second shape — defeating the `_sharp !== undefined` cache check.
describe("resolveSharpFactory", () => {
  it("unwraps the ESM namespace shape (factory on .default)", () => {
    const factory = () => {};
    assert.strictEqual(resolveSharpFactory({ default: factory }), factory);
  });

  it("returns the module itself when it is the callable factory (export = sharp)", () => {
    const factory = () => {};
    assert.strictEqual(resolveSharpFactory(factory), factory);
  });

  it("prefers the callable module over any non-callable .default", () => {
    const factory = () => {};
    factory.default = { notCallable: true };
    assert.strictEqual(resolveSharpFactory(factory), factory);
  });

  it("returns null — never undefined — when no factory is present", () => {
    for (const mod of [{}, { default: undefined }, { default: {} }, null, undefined, 42]) {
      assert.strictEqual(
        resolveSharpFactory(mod),
        null,
        `expected null for ${inspect(mod)}`,
      );
    }
  });
});

// Runtime guard that the cached sharp value is consumed as a callable factory
// on the metadata path. Injects a plain function via __setSharpForTesting so no
// native sharp binary is needed. Lives here (a *.test.mjs picked up by CI's
// test:integration glob) rather than in capture-sharp-optional.test.cjs, which
// no test runner includes.
describe("getScreenshotBufferDimensions — injected sharp factory", () => {
  afterEach(() => {
    __setSharpForTesting(undefined);
  });

  it("invokes the injected sharp factory as a function on the metadata path", async () => {
    const calls = [];
    const sharpFactory = (buffer) => {
      calls.push(buffer);
      return {
        metadata: async () => ({ width: 1024, height: 768 }),
      };
    };
    __setSharpForTesting(sharpFactory);

    const raw = Buffer.from([0x89, 0x50, 0x4e, 0x47]); // PNG magic bytes
    const dims = await getScreenshotBufferDimensions(raw);

    assert.equal(calls.length, 1, "the cached sharp value must be called as a factory");
    assert.strictEqual(calls[0], raw, "the raw buffer must be handed to the factory");
    assert.deepEqual(
      dims,
      { width: 1024, height: 768 },
      "getScreenshotBufferDimensions must read width/height from sharp().metadata()",
    );
  });
});
