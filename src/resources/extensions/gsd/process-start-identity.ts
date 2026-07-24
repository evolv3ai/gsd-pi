// Project/App: gsd-pi
// File Purpose: Cross-platform process-instance identity for crash ownership.
//
// PLATFORM COVERAGE: Linux (/proc stat + boot_id), macOS (proc_pidinfo), and
// Windows (GetProcessTimes) return a real identity. FreeBSD returns null
// unconditionally — see the freebsd branch below for the exact blast radius:
// every consumer treats null as fail-closed, so database maintenance, live
// restore, and every projection write that requires a maintenance identity
// permanently fail on FreeBSD until a kinfo_proc (KERN_PROC_PID, ki_start)
// binding is implemented here.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

interface DarwinProcessInfo {
  pbi_pid: number;
  pbi_start_tvsec: bigint | number;
  pbi_start_tvusec: bigint | number;
}

let darwinProcessInfo: ((pid: number) => DarwinProcessInfo | null) | undefined;
let windowsProcessStartTime: ((pid: number) => bigint | null) | undefined;

function loadDarwinProcessInfo(): (pid: number) => DarwinProcessInfo | null {
  if (darwinProcessInfo) return darwinProcessInfo;
  // Anchor module resolution to this file, never to process.cwd(): callers
  // (tests, MCP servers) may chdir into project directories where koffi is
  // not resolvable, and identity must not silently degrade to null there.
  const require = createRequire(import.meta.url);
  const koffi = require("koffi") as typeof import("koffi");
  const info = koffi.struct({
    pbi_flags: "uint32",
    pbi_status: "uint32",
    pbi_xstatus: "uint32",
    pbi_pid: "uint32",
    pbi_ppid: "uint32",
    pbi_uid: "uint32",
    pbi_gid: "uint32",
    pbi_ruid: "uint32",
    pbi_rgid: "uint32",
    pbi_svuid: "uint32",
    pbi_svgid: "uint32",
    pbi_rfu_1: "uint32",
    pbi_comm: koffi.array("char", 16),
    pbi_name: koffi.array("char", 32),
    pbi_nfiles: "uint32",
    pbi_pgid: "uint32",
    pbi_pjobc: "uint32",
    e_tdev: "uint32",
    e_tpgid: "uint32",
    pbi_nice: "int32",
    pbi_start_tvsec: "uint64",
    pbi_start_tvusec: "uint64",
  });
  const library = koffi.load("/usr/lib/libproc.dylib");
  const read = library.func("proc_pidinfo", "int", [
    "int",
    "int",
    "uint64",
    koffi.out(koffi.pointer(info)),
    "int",
  ]) as (
    pid: number,
    flavor: number,
    arg: number,
    output: DarwinProcessInfo,
    size: number,
  ) => number;
  const size = koffi.sizeof(info);
  darwinProcessInfo = (pid) => {
    const output = {} as DarwinProcessInfo;
    return read(pid, 3, 0, output, size) === size && output.pbi_pid === pid ? output : null;
  };
  return darwinProcessInfo;
}

function loadWindowsProcessStartTime(): (pid: number) => bigint | null {
  if (windowsProcessStartTime) return windowsProcessStartTime;
  const require = createRequire(import.meta.url);
  const koffi = require("koffi") as typeof import("koffi");
  const kernel32 = koffi.load("kernel32.dll");
  const openProcess = kernel32.func(
    "void* __stdcall OpenProcess(uint32 desired_access, bool inherit_handle, uint32 process_id)",
  );
  const getProcessTimes = kernel32.func(
    "bool __stdcall GetProcessTimes(void* process, _Out_ uint64* creation, _Out_ uint64* exit, _Out_ uint64* kernel, _Out_ uint64* user)",
  );
  const closeHandle = kernel32.func("bool __stdcall CloseHandle(void* handle)");
  windowsProcessStartTime = (pid) => {
    const handle = openProcess(0x1000, false, pid);
    if (!handle) return null;
    try {
      const creation = new BigUint64Array(1);
      const unused = new BigUint64Array(1);
      return getProcessTimes(handle, creation, unused, unused, unused) ? creation[0]! : null;
    } finally {
      closeHandle(handle);
    }
  };
  return windowsProcessStartTime;
}

export function processStartIdentity(pid: number): string | null {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  try {
    let raw: string;
    if (process.platform === "linux") {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const fields = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/);
      const bootId = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
      raw = bootId.length > 0 && fields[19] ? `${bootId}:${fields[19]}` : "";
    } else if (process.platform === "darwin") {
      const info = loadDarwinProcessInfo()(pid);
      raw = info ? `${info.pbi_start_tvsec}:${info.pbi_start_tvusec}` : "";
    } else if (process.platform === "freebsd") {
      // KNOWN LIMITATION, fail-closed by design: no FreeBSD identity source
      // is wired up (a kinfo_proc/KERN_PROC_PID ki_start binding is the
      // correct source; PID alone or /proc mtime would not survive PID reuse
      // and would be a false identity — worse than none). Returning null here
      // makes requireSelfProcessStartIdentity() in db/engine.ts throw
      // GSD_STALE_STATE, so every projection write, database maintenance
      // claim, and live restore that requires a process identity fails
      // permanently on FreeBSD rather than risking an ownership misjudgment.
      // A graceful degradation that weakens the identity proof is NOT
      // acceptable: stale-owner detection must never guess.
      return null;
    } else if (process.platform === "win32") {
      const startTime = loadWindowsProcessStartTime()(pid);
      raw = startTime === null ? "" : String(startTime);
    } else {
      return null;
    }
    if (raw.length === 0) return null;
    return `sha256:${createHash("sha256").update(`${process.platform}:${raw}`).digest("hex")}`;
  } catch {
    return null;
  }
}
