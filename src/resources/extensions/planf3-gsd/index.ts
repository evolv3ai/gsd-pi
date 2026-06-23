import type { ExtensionAPI } from "@gsd/pi-coding-agent";
import { registerExportTool, registerExportCommand } from "./tools/planf3_gsd_export.ts";

export default function planf3Gsd(pi: ExtensionAPI): void {
  registerExportTool(pi);
  registerExportCommand(pi);
}
