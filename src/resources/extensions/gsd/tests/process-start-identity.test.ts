import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import { processStartIdentity } from "../process-start-identity.ts";

const children = new Set<ReturnType<typeof spawn>>();

afterEach(() => {
  for (const child of children) child.kill("SIGKILL");
  children.clear();
});

test("current process identity is stable", () => {
  const first = processStartIdentity(process.pid);
  assert.ok(first);
  assert.equal(processStartIdentity(process.pid), first);
});

test("Linux process identity parses a comm with spaces and parens from /proc stat", {
  skip: process.platform !== "linux",
}, async () => {
  const directory = mkdtempSync(join(tmpdir(), "gsd-proc-identity-"));
  try {
    // The kernel records comm from the exec'd file name (truncated to 15
    // bytes), so a hostile symlink name exercises the parser where a naive
    // whitespace or first-paren split would read the wrong starttime field.
    // Target /bin/sleep, not the Node binary: Node renames its main thread
    // ("MainThread") during startup, which races the stat read below and
    // makes the comm assertion flaky; sleep never touches its own comm.
    const linkPath = join(directory, "gsd test) (proc");
    symlinkSync("/bin/sleep", linkPath);
    const child = spawn(linkPath, ["30"]);
    children.add(child);
    await new Promise<void>((resolve) => child.once("spawn", resolve));
    const identity = processStartIdentity(child.pid!);
    assert.ok(identity);

    const stat = readFileSync(`/proc/${child.pid}/stat`, "utf8");
    const close = stat.lastIndexOf(")");
    assert.equal(stat.slice(stat.indexOf("(") + 1, close), "gsd test) (proc");
    const fields = stat.slice(close + 2).trim().split(/\s+/);
    const bootId = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
    const expected = `sha256:${createHash("sha256").update(`linux:${bootId}:${fields[19]}`).digest("hex")}`;
    assert.equal(identity, expected);
    assert.notEqual(identity, processStartIdentity(process.pid));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Windows process identities distinguish two live processes", {
  skip: process.platform !== "win32",
}, async () => {
  const first = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"]);
  const second = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"]);
  children.add(first);
  children.add(second);
  await Promise.all([
    new Promise<void>((resolve) => first.once("spawn", resolve)),
    new Promise<void>((resolve) => second.once("spawn", resolve)),
  ]);
  const firstIdentity = processStartIdentity(first.pid!);
  const secondIdentity = processStartIdentity(second.pid!);
  assert.ok(firstIdentity);
  assert.ok(secondIdentity);
  assert.equal(processStartIdentity(first.pid!), firstIdentity);
  assert.notEqual(firstIdentity, secondIdentity);
});

test("Darwin process identities distinguish launches within one second", {
  skip: process.platform !== "darwin",
}, async (t) => {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const first = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"]);
    const second = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"]);
    children.add(first);
    children.add(second);
    await Promise.all([
      new Promise<void>((resolve) => first.once("spawn", resolve)),
      new Promise<void>((resolve) => second.once("spawn", resolve)),
    ]);
    const starts = execFileSync("/bin/ps", [
      "-o", "lstart=", "-p", String(first.pid), "-p", String(second.pid),
    ], { encoding: "utf8", env: { ...process.env, LC_ALL: "C", TZ: "UTC" } })
      .trim().split("\n").map((value) => value.trim());
    if (starts.length === 2 && starts[0] === starts[1]) {
      const firstIdentity = processStartIdentity(first.pid!);
      const secondIdentity = processStartIdentity(second.pid!);
      assert.ok(firstIdentity);
      assert.ok(secondIdentity);
      assert.notEqual(firstIdentity, secondIdentity);
      return;
    }
    first.kill("SIGKILL");
    second.kill("SIGKILL");
    children.delete(first);
    children.delete(second);
  }
  t.skip("could not start two processes inside one wall-clock second on this host");
});
