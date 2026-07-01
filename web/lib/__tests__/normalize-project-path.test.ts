import { describe, test } from "node:test"
import assert from "node:assert/strict"

import { normalizeProjectPath } from "../normalize-project-path.ts"

describe("normalizeProjectPath", () => {
  test("strips trailing slashes", () => {
    assert.equal(normalizeProjectPath("/Users/proj/"), "/Users/proj")
    assert.equal(normalizeProjectPath("/"), "/")
  })

  test("normalizes backslashes and dot segments", () => {
    assert.equal(normalizeProjectPath("/Users/foo/./bar/../baz"), "/Users/foo/baz")
  })

  test("deduplicates path aliases for store keys", () => {
    assert.equal(
      normalizeProjectPath("/repo/gsd-pi"),
      normalizeProjectPath("/repo/gsd-pi/"),
    )
  })
})
