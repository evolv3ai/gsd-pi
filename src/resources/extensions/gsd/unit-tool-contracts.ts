// Project/App: gsd-pi
// File Purpose: Central Unit-to-tool contracts for phase-aware GSD tool surfaces.

export interface UnitToolSurfaceContract {
  allowedGsdTools: readonly string[];
  requiredWorkflowTools: readonly string[];
  forbiddenGsdTools?: Readonly<Record<string, string>>;
}

export const RUN_UAT_WORKFLOW_TOOL_NAMES = [
  "gsd_uat_exec",
  "gsd_uat_result_save",
  "gsd_resume",
  "gsd_milestone_status",
  "gsd_journal_query",
] as const;

export const RUN_UAT_READ_ONLY_TOOL_NAMES = [
  "find",
  "glob",
  "grep",
  "ls",
  "read",
] as const;

export const RUN_UAT_BROWSER_TOOL_NAMES = [
  "browser_navigate",
  "browser_click",
  "browser_type",
  "browser_fill_form",
  "browser_click_ref",
  "browser_fill_ref",
  "browser_wait_for",
  "browser_assert",
  "browser_verify",
  "browser_screenshot",
  "browser_snapshot_refs",
  "browser_find",
  "browser_get_console_logs",
  "browser_get_network_logs",
  "browser_evaluate",
  "browser_reload",
  "browser_batch",
  "browser_act",
] as const;

export const RUN_UAT_TOOL_PRESENTATION_PLAN_ID = "run-uat/default-v1";

export const UNIT_TOOL_CONTRACTS: Record<string, UnitToolSurfaceContract> = {
  "research-milestone": {
    allowedGsdTools: ["gsd_summary_save", "gsd_decision_save"],
    requiredWorkflowTools: ["gsd_summary_save"],
  },
  "plan-milestone": {
    allowedGsdTools: [
      "gsd_milestone_status",
      "gsd_plan_milestone",
      "gsd_plan_slice",
      "gsd_decision_save",
      "gsd_requirement_update",
    ],
    requiredWorkflowTools: ["gsd_milestone_status", "gsd_plan_milestone", "gsd_plan_slice"],
  },
  "discuss-milestone": {
    allowedGsdTools: [
      "gsd_summary_save",
      "gsd_decision_save",
      "gsd_requirement_save",
      "gsd_requirement_update",
      "gsd_plan_milestone",
      "gsd_milestone_generate_id",
    ],
    requiredWorkflowTools: [
      "ask_user_questions",
      "gsd_summary_save",
      "gsd_requirement_save",
      "gsd_requirement_update",
      "gsd_plan_milestone",
      "gsd_milestone_generate_id",
    ],
  },
  "discuss-slice": {
    allowedGsdTools: ["gsd_summary_save", "gsd_decision_save"],
    requiredWorkflowTools: ["ask_user_questions", "gsd_summary_save"],
  },
  "validate-milestone": {
    allowedGsdTools: ["gsd_milestone_status", "gsd_validate_milestone", "gsd_reassess_roadmap", "subagent"],
    requiredWorkflowTools: ["gsd_milestone_status", "gsd_validate_milestone", "gsd_reassess_roadmap"],
  },
  "complete-milestone": {
    allowedGsdTools: [
      "gsd_milestone_status",
      "gsd_requirement_update",
      "gsd_summary_save",
      "gsd_complete_milestone",
      "subagent",
    ],
    requiredWorkflowTools: [
      "gsd_milestone_status",
      "gsd_requirement_update",
      "gsd_summary_save",
      "gsd_complete_milestone",
    ],
  },
  "research-slice": {
    allowedGsdTools: ["gsd_summary_save", "gsd_decision_save"],
    requiredWorkflowTools: ["gsd_summary_save"],
  },
  "plan-slice": {
    allowedGsdTools: ["gsd_plan_slice", "gsd_reassess_roadmap", "gsd_decision_save"],
    requiredWorkflowTools: ["gsd_plan_slice", "gsd_reassess_roadmap"],
  },
  "refine-slice": {
    allowedGsdTools: ["gsd_plan_slice", "gsd_decision_save"],
    requiredWorkflowTools: ["gsd_plan_slice"],
  },
  "replan-slice": {
    allowedGsdTools: ["gsd_replan_slice", "gsd_decision_save"],
    requiredWorkflowTools: ["gsd_replan_slice"],
  },
  "complete-slice": {
    allowedGsdTools: [
      "gsd_slice_complete",
      "gsd_task_reopen",
      "gsd_replan_slice",
      "gsd_decision_save",
      "gsd_requirement_update",
      "gsd_summary_save",
      "subagent",
    ],
    requiredWorkflowTools: [
      "gsd_slice_complete",
      "gsd_task_reopen",
      "gsd_replan_slice",
      "gsd_requirement_update",
      "gsd_summary_save",
    ],
    forbiddenGsdTools: {
      gsd_uat_result_save: "Run UAT owns persisted UAT Assessment.",
    },
  },
  "reassess-roadmap": {
    allowedGsdTools: ["gsd_milestone_status", "gsd_reassess_roadmap"],
    requiredWorkflowTools: ["gsd_milestone_status", "gsd_reassess_roadmap"],
  },
  "execute-task": {
    allowedGsdTools: ["gsd_task_complete", "gsd_decision_save"],
    requiredWorkflowTools: ["gsd_task_complete"],
  },
  "execute-task-simple": {
    allowedGsdTools: ["gsd_task_complete", "gsd_decision_save"],
    requiredWorkflowTools: ["gsd_task_complete"],
  },
  "reactive-execute": {
    allowedGsdTools: ["gsd_task_complete", "gsd_summary_save", "gsd_decision_save"],
    requiredWorkflowTools: ["gsd_task_complete", "gsd_summary_save"],
  },
  "run-uat": {
    allowedGsdTools: [...RUN_UAT_WORKFLOW_TOOL_NAMES, "subagent"],
    requiredWorkflowTools: [...RUN_UAT_WORKFLOW_TOOL_NAMES],
    forbiddenGsdTools: {
      gsd_exec: "Use gsd_uat_exec so acceptance evidence is typed as UAT-owned.",
      gsd_save_gate_result: "gsd_uat_result_save owns the aggregate UAT gate.",
      gsd_summary_save: "gsd_uat_result_save owns persisted UAT Assessment writes.",
    },
  },
  "gate-evaluate": {
    allowedGsdTools: ["gsd_save_gate_result"],
    requiredWorkflowTools: ["gsd_save_gate_result"],
  },
  "rewrite-docs": {
    allowedGsdTools: ["gsd_summary_save", "gsd_decision_save"],
    requiredWorkflowTools: [],
  },
  "workflow-preferences": {
    allowedGsdTools: ["gsd_summary_save"],
    requiredWorkflowTools: [],
  },
  "discuss-project": {
    allowedGsdTools: ["gsd_summary_save", "gsd_decision_save", "gsd_requirement_save"],
    requiredWorkflowTools: ["ask_user_questions", "gsd_summary_save"],
  },
  "discuss-requirements": {
    allowedGsdTools: ["gsd_requirement_save", "gsd_summary_save"],
    requiredWorkflowTools: ["ask_user_questions", "gsd_requirement_save", "gsd_summary_save"],
  },
  "research-decision": {
    allowedGsdTools: ["gsd_summary_save"],
    requiredWorkflowTools: ["ask_user_questions"],
  },
  "research-project": {
    allowedGsdTools: ["gsd_summary_save", "gsd_decision_save"],
    requiredWorkflowTools: [],
  },
};

export const AUTO_UNIT_SCOPED_TOOLS: Record<string, readonly string[]> = Object.fromEntries(
  Object.entries(UNIT_TOOL_CONTRACTS).map(([unitType, contract]) => [unitType, contract.allowedGsdTools]),
);

export function getUnitToolSurfaceContract(unitType: string): UnitToolSurfaceContract | undefined {
  return UNIT_TOOL_CONTRACTS[unitType];
}

export function getRequiredWorkflowToolsForUnit(unitType: string): string[] {
  return [...(UNIT_TOOL_CONTRACTS[unitType]?.requiredWorkflowTools ?? [])];
}

export function getForbiddenGsdToolReason(unitType: string, toolName: string): string | undefined {
  return UNIT_TOOL_CONTRACTS[unitType]?.forbiddenGsdTools?.[toolName];
}
