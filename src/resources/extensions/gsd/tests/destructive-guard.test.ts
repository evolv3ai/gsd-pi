import test from "node:test";
import assert from "node:assert/strict";

import { classifyCommand } from "../safety/destructive-guard.ts";

test("destructive guard ignores rm -rf text inside quoted literals and comments", () => {
  const readOnlyCommands = [
    'grep -rn "rm -rf" .',
    'echo "rm -rf /tmp/x"',
    'git commit -m "remove stray rm -rf usage"',
    "cat notes.md  # remove stray rm -rf usage",
    'printf "rm -rf /tmp/x\\n"',
  ];

  for (const command of readOnlyCommands) {
    assert.deepEqual(classifyCommand(command), { destructive: false, labels: [] }, command);
  }
});

test("destructive guard still detects direct and wrapper-prefixed recursive deletes", () => {
  const destructiveCommands = [
    "rm -rf build",
    "rm build -rf",
    "sudo rm -rf /",
    "doas rm -rf /",
    "sudo -u bob rm -rf /x",
    "timeout 5 rm -rf /x",
    "time rm -rf build",
    "find . -exec rm -rf {} \\;",
    "cat doomed.txt | xargs rm -rf /tmp/x",
    'rm -rf "/tmp/my build"',
    "rm --recursive build",
  ];

  for (const command of destructiveCommands) {
    assert.deepEqual(classifyCommand(command), {
      destructive: true,
      labels: ["recursive delete"],
    }, command);
  }
});

test("destructive guard does not classify force-only rm as recursive delete", () => {
  const nonRecursiveCommands = [
    "rm -f single-file.md",
    "rm -fv single-file.md",
    "rm single-file.md -f",
    "rm --force single-file.md",
  ];

  for (const command of nonRecursiveCommands) {
    assert.deepEqual(classifyCommand(command), { destructive: false, labels: [] }, command);
  }
});

test("destructive guard treats quoted interpreter payloads as literals", () => {
  assert.deepEqual(classifyCommand('bash -c "rm -rf /"'), { destructive: false, labels: [] });
});
