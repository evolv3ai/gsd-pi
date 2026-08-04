import assert from "node:assert/strict";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";
import YAML from "yaml";

const root = process.cwd();
const workflow = YAML.parse(readFileSync(".github/workflows/update-model-catalog.yml", "utf8"));
const steps = workflow.jobs.refresh.steps;
const releaseTokenStep = steps.find((step) => step.name === "Require release token");
const commitStep = steps.find((step) => step.name === "Commit, push, and open refresh PR");
const countScript = join(root, "packages/pi-ai/scripts/model-catalog-counts.mjs");
const generatorScript = join(root, "packages/pi-ai/scripts/generate-models.ts");
const selectorScript = join(root, "packages/pi-ai/scripts/select-model-catalog-pr.mjs");
const shrinkageScript = join(root, "packages/pi-ai/scripts/model-catalog-shrinkage.mjs");

function run(command, args, options = {}) {
	const result = spawnSync(command, args, {
		cwd: options.cwd ?? root,
		encoding: "utf8",
		env: { ...process.env, ...options.env },
		input: options.input,
	});
	if (options.expectSuccess !== false) {
		assert.equal(result.status, 0, `${command} ${args.join(" ")} failed:\n${result.stdout}\n${result.stderr}`);
	}
	return result;
}

function git(cwd, ...args) {
	return run("git", args, { cwd }).stdout.trim();
}

function createGeneratorPreload(tempRoot) {
	const preloadPath = join(tempRoot, "mock-generator-io.mjs");
	writeFileSync(
		preloadPath,
		[
			'import fs from "node:fs";',
			'import { syncBuiltinESMExports } from "node:module";',
			"const originalWriteFileSync = fs.writeFileSync.bind(fs);",
			"globalThis.fetch = async (url) => {",
			"\tconst target = String(url);",
			'\tif (process.env.FAIL_SOURCE === "openrouter" && target.includes("openrouter.ai")) {',
			'\t\tthrow new Error("OpenRouter unavailable");',
			"\t}",
			'\tif (process.env.FAIL_SOURCE === "vercel" && target.includes("ai-gateway.vercel.sh")) {',
			'\t\tthrow new Error("Vercel AI Gateway unavailable");',
			"\t}",
			"\treturn {",
			"\t\tasync json() {",
			'\t\t\tif (target.includes("models.dev")) {',
			'\t\t\t\treturn { anthropic: { models: { test: { name: "Test", tool_call: true } } } };',
			"\t\t\t}",
			'\t\t\tif (target.includes("openrouter.ai")) {',
			'\t\t\t\treturn { data: [{ id: process.env.MODEL_ID || "test/model", name: process.env.MODEL_NAME || "Test", context_length: process.env.MODEL_CONTEXT_WINDOW || 4096, top_provider: { max_completion_tokens: process.env.MODEL_MAX_TOKENS || 4096 }, pricing: { prompt: process.env.MODEL_PROMPT_COST || "0", completion: process.env.MODEL_COMPLETION_COST || "0" }, supported_parameters: ["tools"] }] };',
			"\t\t\t}",
			'\t\t\treturn { data: [{ id: "test-model", name: "Test", tags: ["tool-use"] }] };',
			"\t\t},",
			"\t};",
			"};",
			"fs.writeFileSync = (targetPath, data) => {",
			'\tif (process.env.FAIL_WRITE === "1") throw new Error("forced write failure");',
			"\tif (!process.env.WRITE_LOG) return;",
			"\t// The generator emits both models.generated.ts and models.generated.json.",
			"\t// Mirror each emission to a WRITE_LOG sibling that preserves the source",
			"\t// extension so the TypeScript inspection is never clobbered by the JSON",
			"\t// catalog write (previously both collapsed onto WRITE_LOG, last wins).",
			'\tconst dest = String(targetPath).endsWith(".json") ? process.env.WRITE_LOG.replace(/\\.ts$/, ".json") : process.env.WRITE_LOG;',
			"\toriginalWriteFileSync(dest, data);",
			"};",
			"syncBuiltinESMExports();",
		].join("\n"),
	);
	return pathToFileURL(preloadPath).href;
}

test("workflow runs only upstream and requires RELEASE_PAT", () => {
	assert.equal(workflow.jobs.refresh.if, "github.repository == 'open-gsd/gsd-pi'");
	assert.equal(
		steps.find((step) => step.name === "Checkout main").with.token,
		"${{ secrets.RELEASE_PAT }}",
	);
	assert.equal(commitStep.env.GH_TOKEN, "${{ secrets.RELEASE_PAT }}");

	const missing = run("bash", ["-c", releaseTokenStep.run], {
		env: { RELEASE_PAT: "" },
		expectSuccess: false,
	});
	assert.notEqual(missing.status, 0);
	assert.match(missing.stderr, /RELEASE_PAT is required to open a bot PR that triggers CI/);

	run("bash", ["-c", releaseTokenStep.run], { env: { RELEASE_PAT: "test-token" } });
});

test("catalog count snapshots share one executable implementation", (t) => {
	const tempRoot = mkdtempSync(join(root, ".model-catalog-counts-"));
	t.after(() => rmSync(tempRoot, { recursive: true, force: true }));

	const catalogDir = join(tempRoot, "catalog");
	mkdirSync(catalogDir);
	writeFileSync(
		join(catalogDir, "models.generated.ts"),
		[
			"export const MODELS = {",
			'\t"alpha": {',
			'\t\t"alpha-one": {',
			"\t\t},",
			'\t\t"alpha\\"two": {',
			"\t\t},",
			"\t},",
			"};",
		].join("\n"),
	);

	const typescriptCounts = run(process.execPath, [countScript, catalogDir]);
	assert.equal(typescriptCounts.stdout, 'providers=1\nmodels=2\nprovider_counts={"alpha":2}\n');

	writeFileSync(
		join(catalogDir, "models.generated.json"),
		JSON.stringify({ alpha: { one: {} }, beta: { two: {}, three: {} } }),
	);
	const jsonCounts = run(process.execPath, [countScript, catalogDir]);
	assert.equal(
		jsonCounts.stdout,
		'providers=2\nmodels=3\nprovider_counts={"alpha":1,"beta":2}\n',
	);

	const countSteps = steps.filter((step) => step.name.startsWith("Snapshot catalog counts"));
	assert.equal(countSteps.length, 2);
	assert.equal(countSteps[0].run, countSteps[1].run);
	assert.match(countSteps[0].run, /model-catalog-counts\.mjs/);
});

test("catalog shrinkage detection flags only losses greater than half", () => {
	const suspicious = run(
		process.execPath,
		[
			shrinkageScript,
			JSON.stringify({ alpha: 10, beta: 3 }),
			JSON.stringify({ alpha: 4, beta: 3 }),
		],
	);
	assert.equal(suspicious.stdout, "suspicious=true\nproviders=alpha (10 to 4)\n");

	const acceptable = run(
		process.execPath,
		[
			shrinkageScript,
			JSON.stringify({ alpha: 10, beta: 3 }),
			JSON.stringify({ alpha: 5, beta: 3, gamma: 1 }),
		],
	);
	assert.equal(acceptable.stdout, "suspicious=false\nproviders=\n");

	const shrinkageStep = steps.find((step) => step.id === "shrinkage");
	assert.equal(
		shrinkageStep.env.BEFORE_PROVIDER_COUNTS,
		"${{ steps.before.outputs.provider_counts }}",
	);
	assert.equal(
		shrinkageStep.env.AFTER_PROVIDER_COUNTS,
		"${{ steps.after.outputs.provider_counts }}",
	);
	assert.equal(commitStep.env.SUSPICIOUS_SHRINKAGE, "${{ steps.shrinkage.outputs.suspicious }}");
	assert.equal(commitStep.env.SHRUNK_PROVIDERS, "${{ steps.shrinkage.outputs.providers }}");
});

test("bot PR selection rejects fork and wrong-owner collisions", () => {
	const pullRequests = [
		{
			url: "https://example.test/fork/1",
			isCrossRepository: true,
			headRepositoryOwner: { login: "contributor" },
		},
		{
			url: "https://example.test/wrong-owner/1",
			isCrossRepository: false,
			headRepositoryOwner: { login: "attacker" },
		},
		{
			url: "https://example.test/pr/1",
			isCrossRepository: false,
			headRepositoryOwner: { login: "open-gsd" },
		},
	];

	const selected = run(process.execPath, [selectorScript, "open-gsd"], {
		input: JSON.stringify(pullRequests),
	});
	assert.equal(selected.stdout, "https://example.test/pr/1");

	const forkOnly = run(process.execPath, [selectorScript, "open-gsd"], {
		input: JSON.stringify(pullRequests.slice(0, 2)),
	});
	assert.equal(forkOnly.stdout, "");
});

test("generator reports unexpected failures with a nonzero exit", (t) => {
	const tempRoot = mkdtempSync(join(root, ".model-catalog-generator-"));
	t.after(() => rmSync(tempRoot, { recursive: true, force: true }));

	const result = run(
		process.execPath,
		["--import", createGeneratorPreload(tempRoot), generatorScript],
		{ env: { FAIL_WRITE: "1" }, expectSuccess: false },
	);

	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /forced write failure/);
});

test("generator refuses partial upstream catalogs", async (t) => {
	const tempRoot = mkdtempSync(join(root, ".model-catalog-upstreams-"));
	t.after(() => rmSync(tempRoot, { recursive: true, force: true }));
	const preload = createGeneratorPreload(tempRoot);

	for (const source of ["openrouter", "vercel"]) {
		await t.test(`${source} failure`, () => {
			const writeLog = join(tempRoot, `${source}-write.log`);
			const result = run(
				process.execPath,
				["--import", preload, generatorScript],
				{
					env: { FAIL_SOURCE: source, WRITE_LOG: writeLog },
					expectSuccess: false,
				},
			);

			assert.notEqual(result.status, 0, `${source} failure must stop generation`);
			assert.equal(existsSync(writeLog), false, `${source} failure must not write the catalog`);
		});
	}
});

test("generator rejects nonnumeric model limits before writing", async (t) => {
	const tempRoot = mkdtempSync(join(root, ".model-catalog-limits-"));
	t.after(() => rmSync(tempRoot, { recursive: true, force: true }));
	const preload = createGeneratorPreload(tempRoot);
	const maliciousValue = "1, injected: (globalThis.catalogInjected = true)";

	for (const field of ["contextWindow", "maxTokens"]) {
		await t.test(`${field} value`, () => {
			const writeLog = join(tempRoot, `${field}.generated.ts`);
			const env = {
				WRITE_LOG: writeLog,
				...(field === "contextWindow"
					? { MODEL_CONTEXT_WINDOW: maliciousValue }
					: { MODEL_MAX_TOKENS: maliciousValue }),
			};
			const result = run(
				process.execPath,
				["--import", preload, generatorScript],
				{ env, expectSuccess: false },
			);

			assert.notEqual(result.status, 0);
			assert.match(result.stderr, /must be a finite number/);
			assert.equal(existsSync(writeLog), false);
		});
	}
});

test("generator rejects nonfinite model costs before writing", async (t) => {
	const tempRoot = mkdtempSync(join(root, ".model-catalog-costs-"));
	t.after(() => rmSync(tempRoot, { recursive: true, force: true }));
	const preload = createGeneratorPreload(tempRoot);

	for (const [field, value] of [["prompt", "not-a-price"], ["completion", "Infinity"]]) {
		await t.test(`${field} cost`, () => {
			const writeLog = join(tempRoot, `${field}.generated.ts`);
			const env = {
				WRITE_LOG: writeLog,
				...(field === "prompt"
					? { MODEL_PROMPT_COST: value }
					: { MODEL_COMPLETION_COST: value }),
			};
			const result = run(
				process.execPath,
				["--import", preload, generatorScript],
				{ env, expectSuccess: false },
			);

			assert.notEqual(result.status, 0);
			assert.match(result.stderr, /Model costs must be finite numbers/);
			assert.equal(existsSync(writeLog), false);
		});
	}
});

test("generator safely serializes upstream model strings", async (t) => {
	const tempRoot = mkdtempSync(join(root, ".model-catalog-serialization-"));
	t.after(() => rmSync(tempRoot, { recursive: true, force: true }));
	const preload = createGeneratorPreload(tempRoot);
	const maliciousId = 'model"with\\escape\nline';
	const maliciousName = 'Model", injected: (globalThis.catalogInjected = true), ignored: "';

	for (const field of ["id", "name"]) {
		await t.test(`${field} string`, () => {
			const modelId = field === "id" ? maliciousId : "test/model";
			const modelName = field === "name" ? maliciousName : "Test";
			const generatedPath = join(tempRoot, `${field}.generated.ts`);
			run(
				process.execPath,
				["--import", preload, generatorScript],
				{ env: { MODEL_ID: modelId, MODEL_NAME: modelName, WRITE_LOG: generatedPath } },
			);

			const inspect = run(
				process.execPath,
				[
					"--experimental-strip-types",
					"--input-type=module",
					"-e",
					[
						"globalThis.catalogInjected = false;",
						`const { MODELS } = await import(${JSON.stringify(pathToFileURL(generatedPath).href)});`,
						"const model = MODELS.openrouter[process.env.MODEL_ID];",
						"process.stdout.write(JSON.stringify({ injected: globalThis.catalogInjected, model }));",
					].join("\n"),
				],
				{ env: { MODEL_ID: modelId } },
			);
			const result = JSON.parse(inspect.stdout);

			assert.equal(result.injected, false);
			assert.equal(result.model.id, modelId);
			assert.equal(result.model.name, modelName);
			assert.equal(result.model.api, "openai-completions");
			assert.equal(result.model.provider, "openrouter");
			assert.equal(result.model.baseUrl, "https://openrouter.ai/api/v1");
			assert.equal(result.model.contextWindow, 4096);
			assert.equal(result.model.maxTokens, 4096);
		});
	}
});

test("refresh workflow ignores fork PRs and manages its own bot PR without JSON output", (t) => {
	const tempRoot = mkdtempSync(join(root, ".model-catalog-workflow-"));
	t.after(() => rmSync(tempRoot, { recursive: true, force: true }));

	const remote = join(tempRoot, "remote.git");
	const repo = join(tempRoot, "repo");
	const binDir = join(tempRoot, "bin");
	const ghLog = join(tempRoot, "gh.log");
	const ghState = join(tempRoot, "pr-open");
	const ghAutoMergeState = join(tempRoot, "auto-merge-enabled");
	const ghDisableHeadLog = join(tempRoot, "disable-head.log");
	const ghBodyLog = join(tempRoot, "pr-body.md");
	mkdirSync(repo);
	mkdirSync(binDir);
	const repoScripts = join(repo, "packages/pi-ai/scripts");
	mkdirSync(repoScripts, { recursive: true });
	copyFileSync(selectorScript, join(repoScripts, "select-model-catalog-pr.mjs"));
	git(tempRoot, "init", "--bare", remote);
	git(repo, "init", "-b", "main");
	git(repo, "config", "user.name", "Test User");
	git(repo, "config", "user.email", "test@example.com");

	const catalogDir = join(repo, "packages/pi-ai/src");
	mkdirSync(catalogDir, { recursive: true });
	const typescriptCatalog = join(catalogDir, "models.generated.ts");
	writeFileSync(typescriptCatalog, "version one\n");
	git(repo, "add", typescriptCatalog, repoScripts);
	git(repo, "commit", "-m", "initial catalog");
	git(repo, "remote", "add", "origin", remote);
	git(repo, "push", "-u", "origin", "main");

	const ghPath = join(binDir, "gh");
	writeFileSync(
		ghPath,
		[
			"#!/bin/sh",
			'printf "%s\\n" "$*" >> "$GH_LOG"',
			'previous=""',
			'for argument in "$@"; do',
			'\tif [ "$previous" = "--body-file" ]; then cp "$argument" "$GH_BODY_LOG"; fi',
			'\tprevious="$argument"',
			"done",
			'if [ "$1 $2" = "pr list" ]; then',
			'\tif [ -f "$GH_STATE" ]; then printf "%s\\n" \'[{"url":"https://example.test/fork/1","isCrossRepository":true,"headRepositoryOwner":{"login":"contributor"}},{"url":"https://example.test/wrong-owner/1","isCrossRepository":false,"headRepositoryOwner":{"login":"attacker"}},{"url":"https://example.test/pr/1","isCrossRepository":false,"headRepositoryOwner":{"login":"open-gsd"}}]\'; else printf "%s\\n" "[]"; fi',
			'elif [ "$1 $2" = "pr create" ]; then',
			'\ttouch "$GH_STATE"',
			'\tprintf "%s\\n" "https://example.test/pr/1"',
			'elif [ "$1 $2" = "pr close" ]; then',
			'\trm -f "$GH_STATE"',
			'elif [ "$1 $2" = "pr view" ]; then',
			'\tif [ -f "$GH_AUTO_MERGE_STATE" ]; then printf "%s\\n" "true"; else printf "%s\\n" "false"; fi',
			'elif [ "$1 $2" = "pr merge" ]; then',
			'\tcase "$*" in',
			'\t\t*--disable-auto*) git --git-dir="$GH_REMOTE" show bot/model-catalog-refresh:packages/pi-ai/src/models.generated.ts > "$GH_DISABLE_HEAD_LOG"; rm -f "$GH_AUTO_MERGE_STATE" ;;',
			'\t\t*--auto*) if [ "$GH_AUTO_FAIL" = "1" ]; then exit 1; else touch "$GH_AUTO_MERGE_STATE"; fi ;;',
			"\tesac",
			"fi",
		].join("\n"),
	);
	chmodSync(ghPath, 0o755);

	const env = {
		AFTER_MODELS: "2",
		AFTER_PROVIDERS: "1",
		BEFORE_MODELS: "1",
		BEFORE_PROVIDERS: "1",
		GITHUB_RUN_NUMBER: "1",
		GITHUB_REPOSITORY_OWNER: "open-gsd",
		GH_AUTO_FAIL: "0",
		GH_AUTO_MERGE_STATE: ghAutoMergeState,
		GH_DISABLE_HEAD_LOG: ghDisableHeadLog,
		GH_BODY_LOG: ghBodyLog,
		GH_LOG: ghLog,
		GH_REMOTE: remote,
		GH_STATE: ghState,
		PATH: `${binDir}:${process.env.PATH}`,
		SHRUNK_PROVIDERS: "",
		SUSPICIOUS_SHRINKAGE: "false",
		TMPDIR: tempRoot,
	};

	writeFileSync(typescriptCatalog, "version two\n");
	const firstRun = run("bash", ["-c", commitStep.run], { cwd: repo, env });
	assert.match(firstRun.stdout, /Opened PR: https:\/\/example\.test\/pr\/1/);
	assert.equal(existsSync(ghAutoMergeState), true);
	assert.equal(git(remote, "show", "bot/model-catalog-refresh:packages/pi-ai/src/models.generated.ts"), "version two");

	git(repo, "checkout", "main");
	writeFileSync(typescriptCatalog, "version three\n");
	const secondRun = run("bash", ["-c", commitStep.run], {
		cwd: repo,
		env: {
			...env,
			GITHUB_RUN_NUMBER: "2",
			SHRUNK_PROVIDERS: "openrouter (10 to 4)",
			SUSPICIOUS_SHRINKAGE: "true",
		},
	});
	assert.match(secondRun.stdout, /Updated PR: https:\/\/example\.test\/pr\/1/);
	assert.match(secondRun.stdout, /auto-merge disabled and human review required/);
	assert.match(readFileSync(ghBodyLog, "utf8"), /> \[!WARNING\]/);
	assert.match(readFileSync(ghBodyLog, "utf8"), /openrouter \(10 to 4\)/);
	assert.equal(readFileSync(ghDisableHeadLog, "utf8"), "version two\n");
	assert.equal(existsSync(ghAutoMergeState), false);
	assert.equal(git(remote, "show", "bot/model-catalog-refresh:packages/pi-ai/src/models.generated.ts"), "version three");

	git(repo, "checkout", "main");
	writeFileSync(typescriptCatalog, "version four\n");
	const thirdRun = run("bash", ["-c", commitStep.run], {
		cwd: repo,
		env: { ...env, GH_AUTO_FAIL: "1", GITHUB_RUN_NUMBER: "3" },
	});
	assert.match(thirdRun.stdout, /auto-merge unavailable; leaving PR for manual review/);
	assert.doesNotMatch(readFileSync(ghBodyLog, "utf8"), /> \[!WARNING\]/);
	assert.equal(git(remote, "show", "bot/model-catalog-refresh:packages/pi-ai/src/models.generated.ts"), "version four");

	git(repo, "checkout", "main");
	const cleanRun = run("bash", ["-c", commitStep.run], {
		cwd: repo,
		env: { ...env, GITHUB_RUN_NUMBER: "4" },
	});
	assert.match(cleanRun.stdout, /Closed stale refresh PR: https:\/\/example\.test\/pr\/1/);
	assert.equal(existsSync(ghState), false);

	const ghCalls = readFileSync(ghLog, "utf8").split("\n");
	assert.equal(ghCalls.filter((call) => call.startsWith("pr create ")).length, 1);
	assert.equal(ghCalls.filter((call) => call.startsWith("pr close ")).length, 1);
	assert.equal(ghCalls.filter((call) => call.startsWith("pr edit ")).length, 2);
	assert.equal(ghCalls.filter((call) => call.startsWith("pr list ")).length, 4);
	assert.equal(ghCalls.filter((call) => call.startsWith("pr merge ")).length, 3);
	assert.equal(ghCalls.some((call) => call.includes("https://example.test/fork/1")), false);
	assert.equal(git(remote, "branch", "--list", "bot/model-catalog-refresh"), "bot/model-catalog-refresh");
	assert.equal(git(remote, "ls-tree", "-r", "--name-only", "bot/model-catalog-refresh").includes("models.generated.json"), false);
});
