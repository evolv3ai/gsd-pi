import { describe, it } from "node:test";
import assert from "node:assert/strict";

// Validate that help-text.ts includes updated provider references
const { printHelp, printSubcommandHelp } = await import("../help-text.ts");
import { GSD_WEBSITE } from "../logo.ts";

function captureStdout(callback: () => void): string {
  const lines: string[] = [];
  const origWrite = process.stdout.write.bind(process.stdout);
  (process.stdout as any).write = (chunk: string) => { lines.push(chunk); return true; };
  try {
    callback();
  } finally {
    (process.stdout as any).write = origWrite;
  }
  return lines.join("");
}

describe("help-text branding", () => {
  it("main help uses Git Ship Done tagline and project website", () => {
    const text = captureStdout(() => printHelp("1.2.3"));
    assert.ok(text.includes("Git Ship Done"), "help should use Git Ship Done tagline");
    assert.ok(!text.includes("Get Shit Done"), "help should not use legacy tagline");
    assert.ok(text.includes(GSD_WEBSITE), "help should link to opengsd.net");
  });

  it("main help lists web launch flags", () => {
    const text = captureStdout(() => printHelp("1.2.3"));
    assert.ok(text.includes("--web [path]"), "help should list web mode");
    assert.ok(text.includes("--no-auth"), "help should list web no-auth mode");
    assert.ok(text.includes("external access control"), "help should warn about external access control");
  });
});

describe("help-text provider references", () => {
  it("config help mentions OpenRouter and Ollama", () => {
    const text = captureStdout(() => printSubcommandHelp("config", "0.0.0"));
    assert.ok(text.includes("OpenRouter"), "OpenRouter should be mentioned in config help");
    assert.ok(text.includes("Ollama"), "Ollama should be mentioned in config help");
    assert.ok(text.includes("docs/providers.md"), "providers.md reference should be in config help");
  });
});
