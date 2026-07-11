import type { ExtensionAPI } from "@gsd/pi-coding-agent";
import { registerExportTool, registerExportCommand } from "./tools/planf3_gsd_export.js";
import { registerBuildCommand } from "./commands/build-register.js";
import { registerBuildTool } from "./tools/planf3_gsd_build.js";
import { registerPlanCommand, registerRunCommand } from "./commands/plan-register.js";
import { registerStatusTool, registerStatusCommand } from "./tools/planf3_gsd_status.js";
import { registerPreflightCommand } from "./commands/preflight-register.js";
import { registerPreflightTool } from "./tools/planf3_gsd_preflight.js";

export default function planf3Gsd(pi: ExtensionAPI): void {
  registerExportTool(pi);
  registerExportCommand(pi);
  registerBuildCommand(pi);
  registerBuildTool(pi);
  registerPlanCommand(pi);
  registerRunCommand(pi);
  registerStatusTool(pi);
  registerStatusCommand(pi);
  registerPreflightCommand(pi);
  registerPreflightTool(pi);
}
