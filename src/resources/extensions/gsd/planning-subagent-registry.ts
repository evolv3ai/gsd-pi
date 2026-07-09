/**
 * Read-only planning specialists that controlled planning dispatch may use.
 *
 * Unit manifests and project preferences still declare per-unit subsets. This
 * registry is the global safety classification checked by the write gate and
 * preference validation before any configured planning allowlist takes effect.
 */

const PLANNING_DISPATCH_AGENT_REGISTRY = {
  mnemo: { readOnlySpecialist: true },
  scout: { readOnlySpecialist: true },
  planner: { readOnlySpecialist: true },
  reviewer: { readOnlySpecialist: true },
  security: { readOnlySpecialist: true },
  tester: { readOnlySpecialist: true },
} as const satisfies Record<string, { readonly readOnlySpecialist: boolean }>;

export const ALLOWED_PLANNING_DISPATCH_AGENTS = new Set<string>(
  Object.entries(PLANNING_DISPATCH_AGENT_REGISTRY)
    .filter(([, metadata]) => metadata.readOnlySpecialist)
    .map(([agentId]) => agentId),
);

export function isReadOnlyPlanningDispatchAgent(agentId: string): boolean {
  const metadata = PLANNING_DISPATCH_AGENT_REGISTRY[agentId as keyof typeof PLANNING_DISPATCH_AGENT_REGISTRY];
  return metadata?.readOnlySpecialist === true;
}

export function allowedPlanningDispatchAgentsList(): string {
  return [...ALLOWED_PLANNING_DISPATCH_AGENTS].join(", ");
}
