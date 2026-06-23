import type { ExtensionAPI } from "@gsd/pi-coding-agent";
import { registerExportTool, registerExportCommand } from "./tools/planf3_gsd_export.js";
import { registerBuildCommand } from "./commands/build-register.js";
import { registerStatusTool, registerStatusCommand } from "./tools/planf3_gsd_status.js";

export default function planf3Gsd(pi: ExtensionAPI): void {
  registerExportTool(pi);
  registerExportCommand(pi);
  registerBuildCommand(pi);
  registerStatusTool(pi);
  registerStatusCommand(pi);
}
