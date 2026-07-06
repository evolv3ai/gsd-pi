import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { chmodSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const {
  resolveBundledGsdBrowserCliPath,
  resolveGsdBrowserDaemonStartInvocation,
  resolveGsdBrowserDaemonStopInvocation,
  resolveGsdBrowserMcpLaunchConfig,
} = await import("../../shared/gsd-browser-cli.ts");

describe("resolveGsdBrowserMcpLaunchConfig identity flags", () => {
  it("emits a non-empty --identity-key alongside --identity-scope", () => {
    // Regression: gsd-browser exits immediately ("Connection closed") when
    // --identity-scope is supplied without --identity-key.
    const { args } = resolveGsdBrowserMcpLaunchConfig("/tmp/example-project", {});

    const scopeIndex = args.indexOf("--identity-scope");
    const keyIndex = args.indexOf("--identity-key");

    assert.ok(scopeIndex >= 0, "expected --identity-scope in args");
    assert.ok(keyIndex >= 0, "expected --identity-key in args");
    assert.equal(args[keyIndex + 1] && args[keyIndex + 1].length > 0, true, "identity-key must be non-empty");
  });

  it("keeps the identity-key stable across sessions for the same project", () => {
    const a = resolveGsdBrowserMcpLaunchConfig("/tmp/example-project", {}, { sessionSuffix: "pi-aaa" });
    const b = resolveGsdBrowserMcpLaunchConfig("/tmp/example-project", {}, { sessionSuffix: "pi-bbb" });

    const keyOf = (cfg) => cfg.args[cfg.args.indexOf("--identity-key") + 1];
    // Session names differ per pi process, but the persistent browser identity
    // must not, so cookies/profile survive across sessions.
    assert.notEqual(a.sessionName, b.sessionName);
    assert.equal(keyOf(a), keyOf(b));
  });

  it("honors GSD_BROWSER_IDENTITY_KEY override", () => {
    const { args } = resolveGsdBrowserMcpLaunchConfig("/tmp/example-project", {
      GSD_BROWSER_IDENTITY_KEY: "custom-key",
    });
    assert.equal(args[args.indexOf("--identity-key") + 1], "custom-key");
  });

  it("splits GSD_BROWSER_MCP_COMMAND command lines before spawning", () => {
    const commandLine = '"C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\Test User\\AppData\\Roaming\\npm\\node_modules\\@opengsd\\gsd-browser\\bin\\gsd-browser"';
    const { command, args } = resolveGsdBrowserMcpLaunchConfig("C:\\Users\\Test User\\project", {
      GSD_BROWSER_MCP_COMMAND: commandLine,
    });

    assert.equal(command, "C:\\Program Files\\nodejs\\node.exe");
    assert.equal(args[0], "C:\\Users\\Test User\\AppData\\Roaming\\npm\\node_modules\\@opengsd\\gsd-browser\\bin\\gsd-browser");
    assert.equal(args[1], "mcp");
  });

  it("appends GSD_BROWSER_MCP_EXTRA_ARGS after the identity flags (string form)", () => {
    const { args } = resolveGsdBrowserMcpLaunchConfig("/tmp/example-project", {
      GSD_BROWSER_MCP_EXTRA_ARGS: "--stealth --browser-path /usr/bin/chromium",
    });

    // Managed flags stay intact and the extra flags trail them.
    assert.ok(args.indexOf("--identity-project") >= 0);
    assert.deepEqual(args.slice(-3), ["--stealth", "--browser-path", "/usr/bin/chromium"]);
    assert.ok(args.indexOf("--stealth") > args.indexOf("--identity-project"));
  });

  it("accepts GSD_BROWSER_MCP_EXTRA_ARGS as a JSON array", () => {
    const { args } = resolveGsdBrowserMcpLaunchConfig("/tmp/example-project", {
      GSD_BROWSER_MCP_EXTRA_ARGS: '["--stealth"]',
    });
    assert.equal(args[args.length - 1], "--stealth");
  });

  it("forwards GSD_BROWSER_MCP_EXTRA_ARGS to the daemon-start invocation", () => {
    const env = { GSD_BROWSER_MCP_EXTRA_ARGS: "--stealth" };
    const daemon = resolveGsdBrowserDaemonStartInvocation("/tmp/example-project", env);
    assert.equal(daemon.args[daemon.args.length - 1], "--stealth");
    assert.ok(daemon.args.indexOf("daemon") >= 0 && daemon.args.indexOf("start") >= 0);
  });

  it("uses a path-safe identity-project identifier", () => {
    const { args } = resolveGsdBrowserMcpLaunchConfig("/tmp/example/project", {});
    const projectId = args[args.indexOf("--identity-project") + 1];
    assert.equal(typeof projectId, "string");
    assert.doesNotMatch(projectId, /[\\/]/);
  });
});

describe("bundled launcher without native binary", () => {
  it("treats npm launcher-only explicit CLI paths as unavailable", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "gsd-browser-launcher-only-"));
    const binDir = join(tempRoot, "bin");
    mkdirSync(binDir, { recursive: true });
    const launcherPath = join(binDir, "gsd-browser");
    writeFileSync(
      launcherPath,
      [
        "#!/usr/bin/env node",
        '"use strict";',
        "process.exit(1);",
        "",
      ].join("\n"),
    );
    chmodSync(launcherPath, 0o755);

    const env = {
      ...process.env,
      GSD_BROWSER_CLI_PATH: launcherPath,
    };

    assert.equal(resolveBundledGsdBrowserCliPath(env), null);
  });

  it("prefers PATH launch when bundled npm launcher lacks native binary", (t) => {
    const requireFromHere = createRequire(import.meta.url);
    let bundledLauncher;
    try {
      const packageJsonPath = requireFromHere.resolve("@opengsd/gsd-browser/package.json");
      bundledLauncher = join(dirname(packageJsonPath), "bin", "gsd-browser");
    } catch {
      return t.skip("bundled @opengsd/gsd-browser is not installed");
    }

    const nativePath = join(dirname(bundledLauncher), "gsd-browser-bin");
    if (!existsSync(bundledLauncher) || existsSync(nativePath)) {
      return t.skip("bundled launcher-only layout not present in this install");
    }

    const launch = resolveGsdBrowserMcpLaunchConfig("/tmp/example-project", process.env, { sessionSuffix: "pi-test" });
    assert.equal(launch.command, "gsd-browser");
    assert.equal(launch.args[0], "mcp");
  });

  it("accepts bundled launchers when the native binary is present", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "gsd-browser-runnable-"));
    const binDir = join(tempRoot, "bin");
    mkdirSync(binDir, { recursive: true });
    const launcherPath = join(binDir, "gsd-browser");
    const nativePath = join(binDir, "gsd-browser-bin");
    writeFileSync(
      launcherPath,
      [
        "#!/usr/bin/env node",
        '"use strict";',
        "process.exit(0);",
        "",
      ].join("\n"),
    );
    writeFileSync(nativePath, "native");
    chmodSync(launcherPath, 0o755);
    chmodSync(nativePath, 0o755);

    const env = {
      ...process.env,
      GSD_BROWSER_CLI_PATH: launcherPath,
      GSD_BROWSER_PATH_VERSION: "0.1.0",
    };

    assert.equal(resolveBundledGsdBrowserCliPath(env), launcherPath);
  });
});

describe("resolveGsdBrowserDaemonStartInvocation", () => {
  it("mirrors MCP session and identity flags with daemon start", () => {
    const launch = resolveGsdBrowserMcpLaunchConfig("/tmp/example-project", {});
    const daemon = resolveGsdBrowserDaemonStartInvocation("/tmp/example-project", {});

    assert.equal(daemon.command, launch.command);
    assert.equal(daemon.cwd, launch.cwd);
    assert.deepEqual(
      daemon.args.slice(daemon.args.indexOf("--session")),
      launch.args.slice(launch.args.indexOf("--session")),
    );
    assert.deepEqual(
      daemon.args.slice(0, daemon.args.indexOf("--session")),
      [...launch.args.slice(0, launch.args.indexOf("mcp")), "daemon", "start"],
    );
  });
});

describe("resolveGsdBrowserDaemonStopInvocation", () => {
  it("mirrors MCP session and identity flags with daemon stop", () => {
    const launch = resolveGsdBrowserMcpLaunchConfig("/tmp/example-project", {});
    const daemon = resolveGsdBrowserDaemonStopInvocation("/tmp/example-project", {});

    assert.equal(daemon.command, launch.command);
    assert.equal(daemon.cwd, launch.cwd);
    assert.deepEqual(
      daemon.args.slice(daemon.args.indexOf("--session")),
      launch.args.slice(launch.args.indexOf("--session")),
    );
    assert.deepEqual(
      daemon.args.slice(0, daemon.args.indexOf("--session")),
      [...launch.args.slice(0, launch.args.indexOf("mcp")), "daemon", "stop"],
    );
  });
});
