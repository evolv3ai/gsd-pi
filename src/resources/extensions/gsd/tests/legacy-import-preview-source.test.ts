// Project/App: gsd-pi
// File Purpose: Exhaustive no-follow source capture and revalidation tests for legacy import Preview.

import assert from "node:assert/strict";
import {
  chmodSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";

import {
  LegacyImportSourceError,
  _captureLegacyImportSourceSetForTest,
  captureLegacyImportSourceSet,
  revalidateLegacyImportSourceSet,
  type LegacyImportSourceCapture,
  type LegacyImportSourceRoot,
  type LegacyImportSourceTestHooks,
} from "../legacy-import-preview-source.ts";
import { hashLegacyImportBytes } from "../legacy-import-preview.ts";

function temporaryDirectory(): string {
  return mkdtempSync(join(tmpdir(), "gsd-legacy-source-"));
}

function withTemporaryDirectory(t: { after(fn: () => void): void }): string {
  const path = temporaryDirectory();
  t.after(() => rmSync(path, { recursive: true, force: true }));
  return path;
}

function directory(path: string): void {
  mkdirSync(path, { recursive: true });
}

function root(
  id: string,
  physicalPath: string,
  logicalPath = ".gsd",
  overrides: Partial<LegacyImportSourceRoot> = {},
): LegacyImportSourceRoot {
  return {
    id,
    kind: "project",
    physical_path: physicalPath,
    logical_path: logicalPath,
    presence: "required",
    ...overrides,
  };
}

function entry(capture: LegacyImportSourceCapture, logicalPath: string) {
  const value = capture.entries.find((candidate) => candidate.logical_path === logicalPath);
  assert.ok(value, `missing source entry ${logicalPath}`);
  return value;
}

function payloadBytes(capture: LegacyImportSourceCapture, logicalPath: string): Buffer {
  const source = entry(capture, logicalPath);
  assert.ok(source.payload_id, `${logicalPath} has no payload`);
  const payload = capture.payloads.find((candidate) => candidate.payload_id === source.payload_id);
  assert.ok(payload, `missing payload for ${logicalPath}`);
  return Buffer.from(payload.bytes_base64, "base64");
}

function expectSourceError(
  fn: () => unknown,
  code: string,
  context: Partial<Record<"root_id" | "logical_path" | "operation", string>> = {},
  stage: "capture" | "revalidate" = code === "LEGACY_IMPORT_SOURCE_CHANGED" ? "revalidate" : "capture",
): LegacyImportSourceError {
  let observed: unknown;
  try {
    fn();
  } catch (error) {
    observed = error;
  }
  assert.ok(observed instanceof LegacyImportSourceError, `expected ${code}, received ${String(observed)}`);
  assert.equal(observed.code, code);
  assert.equal(observed.stage, stage);
  for (const [key, value] of Object.entries(context)) assert.equal(observed.context[key], value, key);
  return observed;
}

describe("legacy preview discovery", () => {
  test("legacy preview discovery captures explicit roots, exact bytes, and lexical topology", (t) => {
    const base = withTemporaryDirectory(t);
    const gsd = join(base, ".gsd");
    const planning = join(base, ".planning");
    directory(join(gsd, "nested"));
    directory(join(planning, "phase"));
    writeFileSync(join(gsd, "z.md"), "z\n");
    writeFileSync(join(gsd, ".hidden"), "hidden");
    writeFileSync(join(gsd, "empty"), Buffer.alloc(0));
    writeFileSync(join(gsd, "nested", "binary.bin"), Buffer.from([0xff, 0x00, 0x61]));
    writeFileSync(join(planning, "phase", "PLAN.md"), "plan");

    const roots = [
      root("planning", planning, ".planning"),
      root("project", gsd),
    ];
    const reversed = captureLegacyImportSourceSet({ roots });
    const canonical = captureLegacyImportSourceSet({ roots: [...roots].reverse() });

    assert.deepEqual(reversed, canonical);
    assert.deepEqual(canonical.roots.map((candidate) => candidate.id), ["planning", "project"]);
    assert.deepEqual(canonical.entries.map((candidate) => candidate.logical_path), [
      ".gsd",
      ".gsd/.hidden",
      ".gsd/empty",
      ".gsd/nested",
      ".gsd/nested/binary.bin",
      ".gsd/z.md",
      ".planning",
      ".planning/phase",
      ".planning/phase/PLAN.md",
    ]);
    assert.deepEqual(payloadBytes(canonical, ".gsd/nested/binary.bin"), Buffer.from([0xff, 0x00, 0x61]));
    assert.equal(entry(canonical, ".gsd/empty").byte_size, 0);
    assert.equal(entry(canonical, ".gsd/z.md").sha256, hashLegacyImportBytes("z\n"));
    assert.match(canonical.capture_hash, /^sha256:[0-9a-f]{64}$/);
    assert.equal(Object.isFrozen(canonical), true);
    assert.equal(Object.isFrozen(canonical.entries), true);
    assert.equal(Object.isFrozen(canonical.payloads[0]), true);
    assert.doesNotThrow(() => revalidateLegacyImportSourceSet(canonical));
  });

  test("legacy preview discovery never searches outside declared roots", (t) => {
    const base = withTemporaryDirectory(t);
    const gsd = join(base, ".gsd");
    directory(gsd);
    directory(join(base, ".planning"));
    writeFileSync(join(gsd, "STATE.md"), "state");
    writeFileSync(join(base, ".planning", "SECRET.md"), "not declared");
    writeFileSync(join(base, "authority.db"), "not authority");

    const capture = captureLegacyImportSourceSet({ roots: [root("project", gsd)] });
    assert.deepEqual(capture.entries.map((candidate) => candidate.logical_path), [".gsd", ".gsd/STATE.md"]);
  });

  test("legacy preview discovery records symlink text without traversing the link", (t) => {
    const base = withTemporaryDirectory(t);
    const gsd = join(base, "project", ".gsd");
    const external = join(base, "state");
    directory(gsd);
    directory(external);
    writeFileSync(join(external, "target.txt"), "target-one");
    writeFileSync(join(external, "target-two.txt"), "target-two");
    symlinkSync("../../state/target.txt", join(gsd, "linked.txt"));
    const roots = [
      root("project", gsd),
      root("external", external, "$GSD_STATE_DIR/projects/project-1", { kind: "external" }),
    ];

    const first = captureLegacyImportSourceSet({ roots });
    const linked = entry(first, ".gsd/linked.txt");
    assert.equal(linked.kind, "symlink");
    assert.equal(payloadBytes(first, ".gsd/linked.txt").toString("utf8"), "../../state/target.txt");
    assert.equal(linked.symlink_target_identity, entry(first, "$GSD_STATE_DIR/projects/project-1/target.txt").physical_identity);

    writeFileSync(join(external, "target.txt"), "changed-target-content");
    const contentChanged = captureLegacyImportSourceSet({ roots });
    assert.equal(entry(contentChanged, ".gsd/linked.txt").sha256, linked.sha256);
    assert.notEqual(
      entry(contentChanged, "$GSD_STATE_DIR/projects/project-1/target.txt").sha256,
      entry(first, "$GSD_STATE_DIR/projects/project-1/target.txt").sha256,
    );
    expectSourceError(() => revalidateLegacyImportSourceSet(first), "LEGACY_IMPORT_SOURCE_CHANGED");

    unlinkSync(join(gsd, "linked.txt"));
    symlinkSync("../../state/target-two.txt", join(gsd, "linked.txt"));
    expectSourceError(() => revalidateLegacyImportSourceSet(contentChanged), "LEGACY_IMPORT_SOURCE_CHANGED");
  });

  test("legacy preview discovery rejects dangling and undeclared escaping symlinks", (t) => {
    const base = withTemporaryDirectory(t);
    const gsd = join(base, ".gsd");
    directory(gsd);
    symlinkSync("../missing", join(gsd, "dangling"));
    expectSourceError(
      () => captureLegacyImportSourceSet({ roots: [root("project", gsd)] }),
      "LEGACY_IMPORT_SOURCE_UNAVAILABLE",
      { root_id: "project", logical_path: ".gsd/dangling" },
    );

    unlinkSync(join(gsd, "dangling"));
    const outside = join(base, "outside.txt");
    writeFileSync(outside, "outside");
    symlinkSync("../outside.txt", join(gsd, "escaping"));
    const escape = expectSourceError(
      () => captureLegacyImportSourceSet({ roots: [root("project", gsd)] }),
      "LEGACY_IMPORT_SOURCE_ESCAPE",
      { logical_path: ".gsd/escaping" },
    );
    assert.equal(escape.retryable, false);
  });

  test("legacy preview discovery preserves hardlink aliases while reading one physical payload", (t) => {
    const base = withTemporaryDirectory(t);
    const gsd = join(base, ".gsd");
    directory(gsd);
    writeFileSync(join(gsd, "a.md"), "same");
    linkSync(join(gsd, "a.md"), join(gsd, "b.md"));
    writeFileSync(join(gsd, "c.md"), "same");

    const capture = captureLegacyImportSourceSet({ roots: [root("project", gsd)] });
    const a = entry(capture, ".gsd/a.md");
    const b = entry(capture, ".gsd/b.md");
    const c = entry(capture, ".gsd/c.md");
    assert.equal(a.payload_id, b.payload_id);
    assert.equal(a.physical_identity, b.physical_identity);
    assert.notEqual(a.payload_id, c.payload_id);
    assert.notEqual(a.source_id, b.source_id);
    assert.equal(capture.payloads.filter((payload) => payload.kind === "file").length, 2);
  });

  test("legacy preview discovery captures a declared symlink root without traversing its alias", (t) => {
    const base = withTemporaryDirectory(t);
    const project = join(base, "project");
    const external = join(base, "state");
    directory(project);
    directory(external);
    writeFileSync(join(external, "STATE.md"), "state");
    symlinkSync("../state", join(project, ".gsd"));

    const capture = captureLegacyImportSourceSet({
      roots: [
        root("project", join(project, ".gsd")),
        root("external", external, "$GSD_STATE_DIR/projects/project-1", { kind: "external" }),
      ],
    });

    assert.deepEqual(capture.entries.map((candidate) => candidate.logical_path), [
      "$GSD_STATE_DIR/projects/project-1",
      "$GSD_STATE_DIR/projects/project-1/STATE.md",
      ".gsd",
    ]);
    assert.equal(entry(capture, ".gsd").kind, "symlink");
    assert.equal(payloadBytes(capture, ".gsd").toString("utf8"), "../state");
    assert.equal(
      entry(capture, ".gsd").symlink_target_identity,
      entry(capture, "$GSD_STATE_DIR/projects/project-1").physical_identity,
    );
  });
});

describe("legacy preview source fingerprint", () => {
  test("legacy preview source fingerprint rejects invalid roots and supports explicit optional absence", (t) => {
    const base = withTemporaryDirectory(t);
    const gsd = join(base, ".gsd");
    directory(gsd);

    assert.equal(
      expectSourceError(
        () => captureLegacyImportSourceSet({ roots: [] }),
        "LEGACY_IMPORT_SOURCE_ROOT_INVALID",
      ).retryable,
      false,
    );
    expectSourceError(
      () => captureLegacyImportSourceSet({ roots: [root("same", gsd), root("same", gsd, ".planning")] }),
      "LEGACY_IMPORT_SOURCE_ROOT_INVALID",
    );
    expectSourceError(
      () => captureLegacyImportSourceSet({ roots: [root("one", gsd), root("two", gsd, ".gsd")] }),
      "LEGACY_IMPORT_SOURCE_ROOT_INVALID",
    );
    expectSourceError(
      () => captureLegacyImportSourceSet({ roots: [root("one", gsd), root("two", gsd, ".gsd/nested")] }),
      "LEGACY_IMPORT_SOURCE_ROOT_INVALID",
    );
    expectSourceError(
      () => captureLegacyImportSourceSet({ roots: [root("relative", ".gsd")] }),
      "LEGACY_IMPORT_SOURCE_ROOT_INVALID",
    );
    expectSourceError(
      () => captureLegacyImportSourceSet({ roots: [root("escape", gsd, "../.gsd")] }),
      "LEGACY_IMPORT_SOURCE_ROOT_INVALID",
    );
    expectSourceError(
      () => captureLegacyImportSourceSet({ roots: [root("missing", join(base, "missing"))] }),
      "LEGACY_IMPORT_SOURCE_UNAVAILABLE",
    );

    const optional = captureLegacyImportSourceSet({
      roots: [root("optional", join(base, "missing"), ".planning", { presence: "optional" })],
    });
    assert.equal(optional.roots[0].observed, "absent");
    assert.deepEqual(optional.entries, []);
    assert.doesNotThrow(() => revalidateLegacyImportSourceSet(optional));
    directory(join(base, "missing"));
    expectSourceError(() => revalidateLegacyImportSourceSet(optional), "LEGACY_IMPORT_SOURCE_CHANGED");
  });

  test("legacy preview source fingerprint rejects unreadable files without partial success", {
    skip: process.platform === "win32" || process.getuid?.() === 0,
  }, (t) => {
    const base = withTemporaryDirectory(t);
    const gsd = join(base, ".gsd");
    directory(gsd);
    const denied = join(gsd, "denied.md");
    writeFileSync(denied, "denied");
    chmodSync(denied, 0o000);
    try {
      const error = expectSourceError(
        () => captureLegacyImportSourceSet({ roots: [root("project", gsd)] }),
        "LEGACY_IMPORT_SOURCE_UNREADABLE",
        { logical_path: ".gsd/denied.md", operation: "open" },
      );
      assert.equal(error.retryable, false);
    } finally {
      chmodSync(denied, 0o600);
    }
  });

  test("legacy preview source fingerprint rejects special filesystem entries", {
    skip: process.platform === "win32",
  }, async (t) => {
    const base = withTemporaryDirectory(t);
    const gsd = join(base, ".gsd");
    directory(gsd);
    const socketPath = join(gsd, "agent.sock");
    const server = createServer();
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, resolve);
    });
    try {
      const error = expectSourceError(
        () => captureLegacyImportSourceSet({ roots: [root("project", gsd)] }),
        "LEGACY_IMPORT_SOURCE_UNSUPPORTED",
        { logical_path: ".gsd/agent.sock" },
      );
      assert.equal(error.retryable, false);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  test("legacy preview source fingerprint aborts deterministic capture-time races", (t) => {
    let inspectedEscapedAncestor = false;
    const cases: Array<{
      name: string;
      prepare(path: string): void;
      hooks(path: string): LegacyImportSourceTestHooks;
    }> = [
      {
        name: "add-after-directory-read",
        prepare: () => undefined,
        hooks: (path) => ({
          after_directory_read(event) {
            if (event.logical_path === ".gsd") writeFileSync(join(path, "added.md"), "added");
          },
        }),
      },
      {
        name: "disappear-after-file-inspect",
        prepare: (path) => writeFileSync(join(path, "file.md"), "file"),
        hooks: (path) => ({
          after_file_inspect(event) {
            if (event.logical_path === ".gsd/file.md") unlinkSync(join(path, "file.md"));
          },
        }),
      },
      {
        name: "mutate-during-file-read",
        prepare: (path) => writeFileSync(join(path, "file.md"), "before"),
        hooks: (path) => ({
          after_file_read(event) {
            if (event.logical_path === ".gsd/file.md") writeFileSync(join(path, "file.md"), "after!");
          },
        }),
      },
      {
        name: "retarget-during-readlink",
        prepare(path) {
          writeFileSync(join(path, "one"), "one");
          writeFileSync(join(path, "two"), "two");
          symlinkSync("one", join(path, "link"));
        },
        hooks: (path) => ({
          after_symlink_read(event) {
            if (event.logical_path !== ".gsd/link") return;
            unlinkSync(join(path, "link"));
            symlinkSync("two", join(path, "link"));
          },
        }),
      },
      {
        name: "mutate-between-hardlink-aliases",
        prepare(path) {
          writeFileSync(join(path, "a"), "same");
          writeFileSync(join(path, "middle"), "middle");
          linkSync(join(path, "a"), join(path, "z"));
        },
        hooks: (path) => ({
          after_file_inspect(event) {
            if (event.logical_path === ".gsd/middle") writeFileSync(join(path, "a"), "new!");
          },
        }),
      },
      {
        name: "replace-ancestor-with-outside-symlink",
        prepare(path) {
          writeFileSync(join(path, "secret"), "inside");
          directory(join(path, "..", "outside"));
          writeFileSync(join(path, "..", "outside", "secret"), "outside");
        },
        hooks: (path) => ({
          after_directory_read(event) {
            if (event.logical_path !== ".gsd") return;
            renameSync(path, join(path, "..", "saved-root"));
            symlinkSync("outside", path);
          },
          after_file_inspect(event) {
            if (event.logical_path === ".gsd/secret") inspectedEscapedAncestor = true;
          },
        }),
      },
      {
        name: "replace-file-with-outside-symlink",
        prepare(path) {
          writeFileSync(join(path, "file.md"), "inside");
          writeFileSync(join(path, "..", "outside-file"), "outside");
        },
        hooks: (path) => ({
          after_file_inspect(event) {
            if (event.logical_path !== ".gsd/file.md") return;
            unlinkSync(join(path, "file.md"));
            symlinkSync(join(path, "..", "outside-file"), join(path, "file.md"));
          },
        }),
      },
      {
        name: "change-between-stability-passes",
        prepare: (path) => writeFileSync(join(path, "file.md"), "first"),
        hooks: (path) => ({
          after_initial_capture() {
            writeFileSync(join(path, "file.md"), "other");
          },
        }),
      },
    ];

    for (const race of cases) {
      const caseRoot = join(withTemporaryDirectory(t), race.name, ".gsd");
      directory(caseRoot);
      race.prepare(caseRoot);
      const error = expectSourceError(
        () => _captureLegacyImportSourceSetForTest(
          { roots: [root("project", caseRoot)] },
          race.hooks(caseRoot),
        ),
        "LEGACY_IMPORT_SOURCE_CAPTURE_CHANGED",
      );
      assert.equal(error.retryable, true, race.name);
      if (race.name === "replace-ancestor-with-outside-symlink") {
        assert.equal(inspectedEscapedAncestor, false);
      }
    }
  });
});

describe("legacy preview source revalidation", () => {
  test("legacy preview source revalidation detects every relevant drift class", (t) => {
    const mutations: Array<[string, (path: string) => void, (path: string) => void]> = [
      ["add", () => undefined, (path) => writeFileSync(join(path, "added.md"), "added")],
      ["remove", (path) => writeFileSync(join(path, "file.md"), "file"), (path) => unlinkSync(join(path, "file.md"))],
      ["rename", (path) => writeFileSync(join(path, "file.md"), "file"), (path) => renameSync(join(path, "file.md"), join(path, "renamed.md"))],
      ["same-length-byte", (path) => writeFileSync(join(path, "file.md"), "one"), (path) => writeFileSync(join(path, "file.md"), "two")],
      ["kind", (path) => writeFileSync(join(path, "entry"), "file"), (path) => { unlinkSync(join(path, "entry")); directory(join(path, "entry")); }],
      ["identical-byte-replacement", (path) => { writeFileSync(join(path, "file.md"), "same"); writeFileSync(join(path, "..", "replacement"), "same"); }, (path) => renameSync(join(path, "..", "replacement"), join(path, "file.md"))],
      ["hardlink-split", (path) => { writeFileSync(join(path, "a"), "same"); linkSync(join(path, "a"), join(path, "b")); }, (path) => { unlinkSync(join(path, "b")); writeFileSync(join(path, "b"), "same"); }],
      ["symlink-retarget", (path) => { writeFileSync(join(path, "one"), "1"); writeFileSync(join(path, "two"), "2"); symlinkSync("one", join(path, "link")); }, (path) => { unlinkSync(join(path, "link")); symlinkSync("two", join(path, "link")); }],
    ];

    for (const [name, prepare, mutate] of mutations) {
      const caseBase = withTemporaryDirectory(t);
      const gsd = join(caseBase, name, ".gsd");
      directory(gsd);
      prepare(gsd);
      const capture = captureLegacyImportSourceSet({ roots: [root("project", gsd)] });
      mutate(gsd);
      const error = expectSourceError(
        () => revalidateLegacyImportSourceSet(capture),
        "LEGACY_IMPORT_SOURCE_CHANGED",
      );
      assert.equal(error.retryable, true, name);
      assert.equal(error.context.expected_capture_hash, capture.capture_hash, name);
    }
  });

  test("legacy preview source revalidation ignores timestamps but not bytes", (t) => {
    const base = withTemporaryDirectory(t);
    const gsd = join(base, ".gsd");
    directory(gsd);
    const file = join(gsd, "STATE.md");
    writeFileSync(file, "state");
    const capture = captureLegacyImportSourceSet({ roots: [root("project", gsd)] });
    const stableSourceId = entry(capture, ".gsd/STATE.md").source_id;
    utimesSync(file, new Date(1_000), new Date(2_000));
    assert.deepEqual(revalidateLegacyImportSourceSet(capture), capture);
    writeFileSync(file, "STATE");
    assert.equal(
      entry(captureLegacyImportSourceSet({ roots: [root("project", gsd)] }), ".gsd/STATE.md").source_id,
      stableSourceId,
    );
    expectSourceError(() => revalidateLegacyImportSourceSet(capture), "LEGACY_IMPORT_SOURCE_CHANGED");
  });

  test("legacy preview source revalidation treats database and WAL names as opaque bytes", (t) => {
    const base = withTemporaryDirectory(t);
    const gsd = join(base, ".gsd");
    directory(gsd);
    const sentinels = new Map([
      ["gsd.db", Buffer.from("not sqlite\0database")],
      ["gsd.db-wal", Buffer.from([0x37, 0x7f, 0x06, 0x82, 0xff])],
      ["gsd.db-shm", Buffer.from("invalid shm")],
    ]);
    for (const [name, bytes] of sentinels) writeFileSync(join(gsd, name), bytes);
    const beforeNames = readdirSync(gsd).sort();

    const capture = captureLegacyImportSourceSet({ roots: [root("project", gsd)] });
    assert.doesNotThrow(() => revalidateLegacyImportSourceSet(capture));

    assert.deepEqual(readdirSync(gsd).sort(), beforeNames);
    for (const [name, bytes] of sentinels) {
      assert.deepEqual(payloadBytes(capture, `.gsd/${name}`), bytes);
      assert.deepEqual(readFileSync(join(gsd, name)), bytes);
    }
  });
});
