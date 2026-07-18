// Project/App: gsd-pi
// File Purpose: Cross-platform process-instance identity for crash ownership.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const TIMEOUT_MS = 1_000;
const MAX_BUFFER = 4_096;

export function processStartIdentity(pid: number): string | null {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  try {
    let raw: string;
    if (process.platform === "linux") {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const fields = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/);
      const bootId = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
      raw = bootId.length > 0 && fields[19] ? `${bootId}:${fields[19]}` : "";
    } else if (process.platform === "darwin" || process.platform === "freebsd") {
      raw = execFileSync("/bin/ps", ["-o", "lstart=", "-p", String(pid)], {
        encoding: "utf8",
        env: { ...process.env, LC_ALL: "C", TZ: "UTC" },
        maxBuffer: MAX_BUFFER,
        timeout: TIMEOUT_MS,
      }).trim();
    } else if (process.platform === "win32") {
      raw = execFileSync("powershell.exe", [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().Ticks`,
      ], {
        encoding: "utf8",
        maxBuffer: MAX_BUFFER,
        timeout: TIMEOUT_MS,
        windowsHide: true,
      }).trim();
    } else {
      return null;
    }
    if (raw.length === 0) return null;
    return `sha256:${createHash("sha256").update(`${process.platform}:${raw}`).digest("hex")}`;
  } catch {
    return null;
  }
}
