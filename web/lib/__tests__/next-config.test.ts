import assert from "node:assert/strict";
import test from "node:test";

import nextConfig from "../../next.config.mjs";

type ExternalCallback = (error?: Error | null, result?: string) => void;
type ExternalResolver = (
  context: { request?: string },
  callback: ExternalCallback,
) => void;

test("server webpack externalizes native packages and subpaths", async () => {
  const webpackConfig = nextConfig.webpack?.(
    { resolve: {}, externals: [] },
    { isServer: true } as Parameters<NonNullable<typeof nextConfig.webpack>>[1],
  ) as { externals: unknown[] };
  const resolver = webpackConfig.externals.at(-1) as ExternalResolver;

  for (const request of [
    "@gsd/native/directory-sync",
    "@gsd/native/file-identity",
    "koffi",
    "koffi/build/koffi/darwin_arm64/koffi.node",
  ]) {
    const result = await new Promise<string | undefined>((resolve, reject) => {
      resolver({ request }, (error, external) => {
        if (error) reject(error);
        else resolve(external);
      });
    });

    assert.equal(result, `commonjs ${request}`);
  }
});
