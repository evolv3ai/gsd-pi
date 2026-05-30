import { describe, test, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  setFetchAllowedUrls,
  getFetchAllowedUrls,
  isBlockedUrl,
  normalizeQuery,
  toDedupeKey,
  extractDomain,
  detectFreshness,
  detectDomainHints,
} from "../url-utils.ts";

describe("search-the-web url-utils", () => {
  afterEach(() => {
    setFetchAllowedUrls([]);
  });

  test("blocks localhost and private networks", () => {
    assert.equal(isBlockedUrl("http://localhost/path"), true);
    assert.equal(isBlockedUrl("http://127.0.0.1/path"), true);
    assert.equal(isBlockedUrl("http://192.168.1.1/path"), true);
    assert.equal(isBlockedUrl("http://10.0.0.5/path"), true);
  });

  test("allows public https URLs", () => {
    assert.equal(isBlockedUrl("https://example.com/docs"), false);
  });

  test("honors fetch allowlist hostnames", () => {
    setFetchAllowedUrls(["localhost"]);
    assert.deepEqual(getFetchAllowedUrls(), ["localhost"]);
    assert.equal(isBlockedUrl("http://localhost:8080/path"), false);
  });

  test("normalizeQuery trims, lowercases, and collapses whitespace", () => {
    assert.equal(normalizeQuery("  Hello   World  "), "hello world");
  });

  test("toDedupeKey strips tracking params and normalizes hostname", () => {
    const key = toDedupeKey("https://Example.com/page?utm_source=x&b=2&a=1#frag");
    assert.ok(key);
    assert.match(key!, /example\.com/);
    assert.doesNotMatch(key!, /utm_source/);
  });

  test("extractDomain removes www prefix", () => {
    assert.equal(extractDomain("https://www.python.org/doc"), "python.org");
  });

  test("detectFreshness finds recency keywords", () => {
    assert.equal(detectFreshness("latest release notes"), "pm");
    assert.equal(detectFreshness("timeless architecture"), null);
  });

  test("detectDomainHints parses site: operator", () => {
    assert.deepEqual(detectDomainHints("site:docs.example.com widgets"), ["docs.example.com"]);
  });
});
