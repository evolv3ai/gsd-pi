import assert from "node:assert/strict"
import { createRequire, syncBuiltinESMExports } from "node:module"
import { join } from "node:path"
import { tmpdir } from "node:os"
import test from "node:test"

import type { SerializedVisualizerData } from "../web/visualizer-service.ts"

const require = createRequire(import.meta.url)
const childProcess = require("node:child_process") as typeof import("node:child_process")
const fs = require("node:fs") as typeof import("node:fs")

function createVisualizerPayload(phase: string): SerializedVisualizerData {
  return {
    milestones: [],
    phase,
    totals: null,
    byPhase: [],
    bySlice: [],
    byModel: [],
    byTier: [],
    tierSavingsLine: "",
    units: [],
    criticalPath: {
      milestonePath: [],
      slicePath: [],
      milestoneSlack: {},
      sliceSlack: {},
    },
    remainingSliceCount: 0,
    agentActivity: null,
    changelog: null,
    sliceVerifications: [],
    knowledge: null,
    memories: null,
    captures: null,
    health: null,
    discussion: [],
    stats: null,
  }
}

test("collectVisualizerData clears the cache entry when the subprocess errors, allowing retries", async (t) => {
  const mutableChildProcess = childProcess as typeof childProcess & {
    execFile: typeof childProcess.execFile
  }
  const mutableFs = fs as typeof fs & {
    existsSync: typeof fs.existsSync
  }
  const originalExecFile = mutableChildProcess.execFile
  const originalExistsSync = mutableFs.existsSync
  const originalPackageRoot = process.env.GSD_WEB_PACKAGE_ROOT

  type ExecCallback = (error: Error | null, stdout: string, stderr: string) => void
  const pendingExecs: ExecCallback[] = []
  let execCount = 0

  mutableChildProcess.execFile = ((...args: unknown[]) => {
    execCount += 1
    pendingExecs.push(args[3] as ExecCallback)
    return {} as ReturnType<typeof childProcess.execFile>
  }) as typeof childProcess.execFile
  mutableFs.existsSync = (() => true) as typeof fs.existsSync
  process.env.GSD_WEB_PACKAGE_ROOT = join(tmpdir(), "gsd-pi-visualizer-cache-test-error")
  syncBuiltinESMExports()

  t.after(() => {
    mutableChildProcess.execFile = originalExecFile
    mutableFs.existsSync = originalExistsSync
    if (originalPackageRoot === undefined) {
      delete process.env.GSD_WEB_PACKAGE_ROOT
    } else {
      process.env.GSD_WEB_PACKAGE_ROOT = originalPackageRoot
    }
    syncBuiltinESMExports()
  })

  const visualizerService = await import("../web/visualizer-service.ts")
  visualizerService.resetVisualizerDataCacheForTests()

  // Start two concurrent requests — they share the same in-flight promise.
  const first = visualizerService.collectVisualizerData("/project-err")
  const second = visualizerService.collectVisualizerData("/project-err")
  assert.equal(execCount, 1, "concurrent requests share one subprocess")

  // Simulate a subprocess timeout / error (what execFile calls back with when its
  // `timeout` option fires and the child is killed).
  const timedOutError = Object.assign(new Error("spawnSync node ETIMEDOUT"), { killed: true, signal: "SIGTERM" })
  pendingExecs.shift()?.(timedOutError, "", "")

  // Both callers should receive a rejection.
  await assert.rejects(first, /subprocess failed/)
  // `second` holds the same promise reference, also rejected.
  await assert.rejects(second, /subprocess failed/)

  // After the error the cache entry must be cleared so a retry spawns a fresh subprocess.
  const retry = visualizerService.collectVisualizerData("/project-err")
  assert.equal(execCount, 2, "retry after timeout spawns a new subprocess")
  pendingExecs.shift()?.(null, JSON.stringify(createVisualizerPayload("retry")), "")
  assert.deepEqual(await retry, createVisualizerPayload("retry"))
})

test("collectVisualizerData shares in-flight work and reuses a recent project result", async (t) => {
  const mutableChildProcess = childProcess as typeof childProcess & {
    execFile: typeof childProcess.execFile
  }
  const mutableFs = fs as typeof fs & {
    existsSync: typeof fs.existsSync
  }
  const originalExecFile = mutableChildProcess.execFile
  const originalExistsSync = mutableFs.existsSync
  const originalDateNow = Date.now
  const originalPackageRoot = process.env.GSD_WEB_PACKAGE_ROOT

  type ExecCallback = (error: Error | null, stdout: string, stderr: string) => void
  const pendingExecs: ExecCallback[] = []
  let execCount = 0
  let now = 1_000

  mutableChildProcess.execFile = ((...args: unknown[]) => {
    execCount += 1
    pendingExecs.push(args[3] as ExecCallback)
    return {} as ReturnType<typeof childProcess.execFile>
  }) as typeof childProcess.execFile
  mutableFs.existsSync = (() => true) as typeof fs.existsSync
  Date.now = () => now
  process.env.GSD_WEB_PACKAGE_ROOT = join(tmpdir(), "gsd-pi-visualizer-cache-test")
  syncBuiltinESMExports()

  t.after(() => {
    mutableChildProcess.execFile = originalExecFile
    mutableFs.existsSync = originalExistsSync
    Date.now = originalDateNow
    if (originalPackageRoot === undefined) {
      delete process.env.GSD_WEB_PACKAGE_ROOT
    } else {
      process.env.GSD_WEB_PACKAGE_ROOT = originalPackageRoot
    }
    syncBuiltinESMExports()
  })

  const visualizerService = await import("../web/visualizer-service.ts")
  visualizerService.resetVisualizerDataCacheForTests()

  const first = visualizerService.collectVisualizerData("/project-a")
  const second = visualizerService.collectVisualizerData("/project-a")

  assert.equal(execCount, 1, "concurrent requests for one project share the subprocess")
  pendingExecs.shift()?.(null, JSON.stringify(createVisualizerPayload("first")), "")

  assert.deepEqual(await Promise.all([first, second]), [
    createVisualizerPayload("first"),
    createVisualizerPayload("first"),
  ])

  now = 5_000
  assert.deepEqual(
    await visualizerService.collectVisualizerData("/project-a"),
    createVisualizerPayload("first"),
    "requests inside the TTL reuse the cached payload",
  )
  assert.equal(execCount, 1)

  const otherProject = visualizerService.collectVisualizerData("/project-b")
  assert.equal(execCount, 2, "cache entries are keyed by project cwd")
  pendingExecs.shift()?.(null, JSON.stringify(createVisualizerPayload("second")), "")
  assert.deepEqual(await otherProject, createVisualizerPayload("second"))

  now = 11_001
  const refreshed = visualizerService.collectVisualizerData("/project-a")
  assert.equal(execCount, 3, "expired cache entries refresh with a new subprocess")
  pendingExecs.shift()?.(null, JSON.stringify(createVisualizerPayload("refreshed")), "")
  assert.deepEqual(await refreshed, createVisualizerPayload("refreshed"))
})

test("collectVisualizerData expires a stuck in-flight subprocess and ignores its late result", async (t) => {
  const mutableChildProcess = childProcess as typeof childProcess & {
    execFile: typeof childProcess.execFile
  }
  const mutableFs = fs as typeof fs & {
    existsSync: typeof fs.existsSync
  }
  const originalExecFile = mutableChildProcess.execFile
  const originalExistsSync = mutableFs.existsSync
  const originalDateNow = Date.now
  const originalPackageRoot = process.env.GSD_WEB_PACKAGE_ROOT

  type ExecCallback = (error: Error | null, stdout: string, stderr: string) => void
  const pendingExecs: ExecCallback[] = []
  let execCount = 0
  let now = 1_000

  mutableChildProcess.execFile = ((...args: unknown[]) => {
    execCount += 1
    pendingExecs.push(args[3] as ExecCallback)
    return {} as ReturnType<typeof childProcess.execFile>
  }) as typeof childProcess.execFile
  mutableFs.existsSync = (() => true) as typeof fs.existsSync
  Date.now = () => now
  process.env.GSD_WEB_PACKAGE_ROOT = join(tmpdir(), "gsd-pi-visualizer-cache-test-stuck")
  syncBuiltinESMExports()

  t.after(() => {
    mutableChildProcess.execFile = originalExecFile
    mutableFs.existsSync = originalExistsSync
    Date.now = originalDateNow
    if (originalPackageRoot === undefined) {
      delete process.env.GSD_WEB_PACKAGE_ROOT
    } else {
      process.env.GSD_WEB_PACKAGE_ROOT = originalPackageRoot
    }
    syncBuiltinESMExports()
  })

  const visualizerService = await import("../web/visualizer-service.ts")
  visualizerService.resetVisualizerDataCacheForTests()

  const stuck = visualizerService.collectVisualizerData("/project-stuck")
  const shared = visualizerService.collectVisualizerData("/project-stuck")
  assert.equal(execCount, 1, "requests share the subprocess before the in-flight entry expires")

  now = 31_001
  const refreshed = visualizerService.collectVisualizerData("/project-stuck")
  assert.equal(execCount, 2, "stuck in-flight entries expire and spawn a fresh subprocess")

  pendingExecs[1]?.(null, JSON.stringify(createVisualizerPayload("fresh")), "")
  assert.deepEqual(await refreshed, createVisualizerPayload("fresh"))

  pendingExecs[0]?.(null, JSON.stringify(createVisualizerPayload("stale")), "")
  assert.deepEqual(await Promise.all([stuck, shared]), [
    createVisualizerPayload("stale"),
    createVisualizerPayload("stale"),
  ])

  assert.deepEqual(
    await visualizerService.collectVisualizerData("/project-stuck"),
    createVisualizerPayload("fresh"),
    "a late result from an expired in-flight subprocess must not replace the current cache entry",
  )
})
