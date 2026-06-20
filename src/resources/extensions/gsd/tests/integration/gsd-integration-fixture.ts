import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export type GsdIntegrationProject = {
  root: string;
};

export type CreateGsdIntegrationProjectOptions = {
  prefix?: string;
  initialFiles?: Record<string, string>;
};

export function projectRoot(project: GsdIntegrationProject | string): string {
  return typeof project === "string" ? project : project.root;
}

export function git(project: GsdIntegrationProject | string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd: projectRoot(project),
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

export function createGsdIntegrationProject(
  options: CreateGsdIntegrationProjectOptions | string = {},
): GsdIntegrationProject {
  const resolvedOptions = typeof options === "string" ? { prefix: options } : options;
  const prefix = resolvedOptions.prefix ?? "gsd-integration-";
  const root = realpathSync(mkdtempSync(join(tmpdir(), prefix)));

  git(root, "init");
  git(root, "config", "user.email", "test@test.com");
  git(root, "config", "user.name", "Test");
  git(root, "config", "core.autocrlf", "false");

  writeProjectFile(root, "README.md", "# test\n");
  for (const [relativePath, content] of Object.entries(resolvedOptions.initialFiles ?? {})) {
    writeProjectFile(root, relativePath, content);
  }
  git(root, "add", ".");
  git(root, "commit", "-m", "init");
  git(root, "branch", "-M", "main");

  return { root };
}

export function writeProjectFile(
  project: GsdIntegrationProject | string,
  relativePath: string,
  content: string,
): string {
  const filePath = join(projectRoot(project), relativePath);
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, content, "utf-8");
  return filePath;
}

export function writeGsdMilestoneContext(
  project: GsdIntegrationProject | string,
  milestoneId: string,
  content = `# ${milestoneId} Context\n`,
): string {
  return writeProjectFile(
    project,
    join(".gsd", "milestones", milestoneId, "CONTEXT.md"),
    content,
  );
}

export function commitAll(project: GsdIntegrationProject | string, message: string): void {
  git(project, "add", ".");
  git(project, "commit", "-m", message);
}

export function cleanupGsdIntegrationProject(project: GsdIntegrationProject | string): void {
  rmSync(projectRoot(project), { recursive: true, force: true });
}
