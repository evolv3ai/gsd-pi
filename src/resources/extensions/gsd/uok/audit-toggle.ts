const AUDIT_ENV_KEY = "GSD_UOK_AUDIT_UNIFIED";
const suppressedBasePaths = new Set<string>();

export function setUnifiedAuditEnabled(enabled: boolean): void {
  process.env[AUDIT_ENV_KEY] = enabled ? "1" : "0";
}

export function setUnifiedAuditSuppressedForBasePath(basePath: string, suppressed: boolean): void {
  if (suppressed) {
    suppressedBasePaths.add(basePath);
    return;
  }
  suppressedBasePaths.delete(basePath);
}

export function isUnifiedAuditEnabled(basePath?: string): boolean {
  if (basePath && suppressedBasePaths.has(basePath)) return false;
  return process.env[AUDIT_ENV_KEY] !== "0";
}

export function getUnifiedAuditOverride(): boolean | undefined {
  const raw = process.env[AUDIT_ENV_KEY];
  if (raw === "0") return false;
  if (raw === "1") return true;
  return undefined;
}

export function restoreUnifiedAuditOverride(override: boolean | undefined): void {
  if (override === undefined) {
    delete process.env[AUDIT_ENV_KEY];
    return;
  }
  setUnifiedAuditEnabled(override);
}

export function clearUnifiedAuditOverrideForTests(): void {
  delete process.env[AUDIT_ENV_KEY];
  suppressedBasePaths.clear();
}
