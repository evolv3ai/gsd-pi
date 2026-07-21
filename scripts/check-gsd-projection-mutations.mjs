import { readFileSync, readdirSync } from "node:fs";
import { extname, join, relative, resolve } from "node:path";
import ts from "typescript";

const workspaceRoot = process.cwd();
const policyPath = join(workspaceRoot, "src", "resources", "extensions", "gsd", "projection-path-policy.ts");
const policyModule = ts.transpileModule(readFileSync(policyPath, "utf8"), {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ESNext },
});
const { classifyGsdLogicalPath } = await import(
  `data:text/javascript;base64,${Buffer.from(policyModule.outputText).toString("base64")}`
);
const sourceRoot = process.argv[2]
  ? resolve(process.argv[2])
  : join(workspaceRoot, "src", "resources", "extensions", "gsd");
const directMutators = new Set([
  "appendFile", "appendFileSync", "chmod", "chmodSync", "chown", "chownSync",
  "copyFile", "copyFileSync", "cp", "cpSync", "createWriteStream", "link", "linkSync",
  "lchmod", "lchmodSync", "lchown", "lchownSync", "lutimes", "lutimesSync", "mkdir",
  "mkdirSync", "mkdtemp", "mkdtempSync", "open", "openSync", "rename", "renameSync",
  "rm", "rmSync", "rmdir", "rmdirSync", "symlink", "symlinkSync", "truncate",
  "truncateSync", "unlink", "unlinkSync", "utimes", "utimesSync", "writeFile", "writeFileSync",
]);
const ownedBoundaries = new Set(["atomic-write.ts", "managed-projection-history.ts"]);

function sourceFiles(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "tests") files.push(...sourceFiles(path));
    } else if (extname(entry.name) === ".ts" && !entry.name.endsWith(".test.ts")) {
      files.push(path);
    }
  }
  return files;
}

const files = sourceFiles(sourceRoot);
const program = ts.createProgram(files, {
  allowJs: false,
  module: ts.ModuleKind.NodeNext,
  moduleResolution: ts.ModuleResolutionKind.NodeNext,
  target: ts.ScriptTarget.ESNext,
});
const checker = program.getTypeChecker();
const summaries = new Map();
const violationSites = new Set();

function functionNode(node) {
  return ts.isFunctionDeclaration(node)
    || ts.isFunctionExpression(node)
    || ts.isArrowFunction(node)
    || ts.isMethodDeclaration(node);
}

function enclosingFunction(node) {
  let current = node.parent;
  while (current !== undefined && !functionNode(current)) current = current.parent;
  return current ?? node.getSourceFile();
}

function resolvedFunction(call) {
  return checker.getResolvedSignature(call)?.declaration;
}

function returnsPathValue(declaration) {
  const signature = checker.getSignatureFromDeclaration(declaration);
  if (!signature) return false;
  const type = checker.getReturnTypeOfSignature(signature);
  const values = type.isUnion() ? type.types : [type];
  return values.every(value => (
    (value.flags & (ts.TypeFlags.String | ts.TypeFlags.StringLiteral | ts.TypeFlags.Undefined | ts.TypeFlags.Null)) !== 0
  ));
}

function importedFsMutators(source) {
  const named = new Set();
  const namespaces = new Set();
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || statement.moduleSpecifier.text !== "node:fs") continue;
    const bindings = statement.importClause?.namedBindings;
    if (bindings && ts.isNamedImports(bindings)) {
      for (const element of bindings.elements) {
        if (directMutators.has((element.propertyName ?? element.name).text)) named.add(element.name.text);
      }
    } else if (bindings && ts.isNamespaceImport(bindings)) {
      namespaces.add(bindings.name.text);
    }
  }
  return { named, namespaces };
}

function symbolOriginatesFromNodeFs(symbol) {
  const target = symbol && (symbol.flags & ts.SymbolFlags.Alias) !== 0
    ? checker.getAliasedSymbol(symbol)
    : symbol;
  return target?.declarations?.some((declaration) => (
    declaration.getSourceFile().fileName.endsWith("/node/fs.d.ts")
  )) ?? false;
}

function isDirectMutation(call, imports) {
  if (ts.isIdentifier(call.expression)) return imports.named.has(call.expression.text);
  if (!ts.isPropertyAccessExpression(call.expression)
    || !directMutators.has(call.expression.name.text)) return false;
  if (ts.isIdentifier(call.expression.expression)
    && imports.namespaces.has(call.expression.expression.text)) return true;
  const property = checker.getSymbolAtLocation(call.expression.name);
  return property?.declarations?.some((declaration) => {
    if (!ts.isPropertySignature(declaration) || !declaration.type || !ts.isTypeQueryNode(declaration.type)) {
      return false;
    }
    return symbolOriginatesFromNodeFs(checker.getSymbolAtLocation(declaration.type.exprName));
  }) ?? false;
}

function mutationArguments(call, imports) {
  if (!isDirectMutation(call, imports)) return [];
  const name = ts.isIdentifier(call.expression) ? call.expression.text : call.expression.name.text;
  if (["copyFile", "copyFileSync", "cp", "cpSync", "link", "linkSync", "symlink", "symlinkSync"].includes(name)) {
    return [1];
  }
  if (name === "rename" || name === "renameSync") return [0, 1];
  return [0];
}

/**
 * Classify static path text for .gsd-rootedness. Covers shapes the exact-match
 * literal check missed:
 * - a single literal that already joins the root (".gsd/milestones/M001" or
 *   "out/.gsd/research/x.md"): rooted, with the segment after ".gsd/"
 *   classified for managed/control;
 * - a bare ".gsd" segment: rooted only (unchanged legacy behavior — a dynamic
 *   first segment stays unclassified, same as join(base, ".gsd", name)).
 * Returns the first logical path segment after the ".gsd/" marker, or null
 * when nothing static follows it.
 */
function gsdRootedHeadSegment(rawText) {
  const text = rawText.replaceAll("\\", "/").normalize("NFC").toLocaleLowerCase("en-US");
  if (text === ".gsd") return { rooted: true, headSegment: null };
  const marker = ".gsd/";
  const start = text.startsWith(marker) ? 0 : text.indexOf(`/${marker}`);
  if (start < 0) return { rooted: false, headSegment: null };
  const remainder = text.slice(start + (start === 0 ? 0 : 1) + marker.length).replace(/\/+$/, "");
  const headSegment = remainder.split("/")[0] ?? "";
  return { rooted: true, headSegment: headSegment.length > 0 ? headSegment : null };
}

function dependency(expression, owner, seen = new Set()) {
  const parameters = new Set();
  let rooted = false;
  let segment = false;
  let reserved = false;
  let directManaged = false;
  // Object-literal property values such as { logical_path: ".gsd/phases" } are
  // serialized labels, not path construction. Classifying their ".gsd/"-rooted
  // head segment would conflate metadata with an actual mutation target, so
  // label positions keep the legacy exact-root/fragment classification only.
  function applyStaticPathText(text, isLabelValue) {
    if (!isLabelValue) {
      const rootedInfo = gsdRootedHeadSegment(text);
      if (rootedInfo.rooted) {
        rooted = true;
        if (rootedInfo.headSegment !== null) {
          const classification = classifyGsdLogicalPath(rootedInfo.headSegment);
          segment ||= classification === "managed";
          reserved ||= classification === "control";
        }
        reserved ||= text.endsWith(".lock");
        return;
      }
    }
    if (text.normalize("NFC").toLocaleLowerCase("en-US") === ".gsd") rooted = true;
    else {
      const classification = classifyGsdLogicalPath(text);
      segment ||= classification === "managed";
      reserved ||= classification === "control" || text.endsWith(".lock");
    }
  }
  function isPropertyValuePosition(node) {
    return ts.isPropertyAssignment(node.parent) && node.parent.initializer === node;
  }
  function visit(node) {
    if (ts.isStringLiteralLike(node)) {
      applyStaticPathText(node.text, isPropertyValuePosition(node));
    }
    if (ts.isTemplateExpression(node)) {
      // Template expressions are not StringLiteralLike, so `.gsd/milestones/${mid}`
      // used to escape the gate. Stitch the static head and span literals; the
      // first static segment after ".gsd/" decides managed/control.
      let staticText = node.head.text;
      for (const span of node.templateSpans) staticText += span.literal.text;
      applyStaticPathText(staticText, isPropertyValuePosition(node));
    }
    if (ts.isCallExpression(node)) {
      const callee = resolvedFunction(node);
      if (callee && functionNode(callee) && returnsPathValue(callee) && !seen.has(callee)) {
        seen.add(callee);
        const returns = [];
        function collectReturns(child) {
          if (ts.isReturnStatement(child) && child.expression) returns.push(child.expression);
          else if (child !== callee && functionNode(child)) return;
          ts.forEachChild(child, collectReturns);
        }
        if (ts.isArrowFunction(callee) && !ts.isBlock(callee.body)) returns.push(callee.body);
        else if (callee.body) collectReturns(callee.body);
        for (const returned of returns) {
          const nested = dependency(returned, callee, seen);
          rooted ||= nested.rooted;
          segment ||= nested.segment;
          reserved ||= nested.reserved;
          directManaged ||= nested.managed;
          for (const parameter of nested.parameters) {
            const argument = node.arguments[parameter];
            if (!argument) continue;
            const supplied = dependency(argument, owner, seen);
            supplied.parameters.forEach(index => parameters.add(index));
            rooted ||= supplied.rooted;
            segment ||= supplied.segment;
            reserved ||= supplied.reserved;
            directManaged ||= supplied.managed;
          }
        }
      }
    }
    if (ts.isIdentifier(node)) {
      const symbol = checker.getSymbolAtLocation(node);
      const parameterIndex = owner && "parameters" in owner ? owner.parameters.findIndex((parameter) => (
        checker.getSymbolAtLocation(parameter.name) === symbol
      )) : -1;
      if (parameterIndex >= 0) parameters.add(parameterIndex);
      const declaration = symbol?.valueDeclaration;
      if (declaration && !seen.has(declaration) && ts.isVariableDeclaration(declaration) && declaration.initializer) {
        seen.add(declaration);
        const nested = dependency(declaration.initializer, owner, seen);
        nested.parameters.forEach((index) => parameters.add(index));
        directManaged ||= nested.managed;
        rooted ||= nested.rooted;
        segment ||= nested.segment;
        reserved ||= nested.reserved;
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(expression);
  return { parameters, rooted, segment, reserved, managed: (directManaged || (rooted && segment)) && !reserved };
}

for (const source of program.getSourceFiles().filter((source) => files.includes(source.fileName))) {
  summaries.set(source, new Set());
  function visit(node) {
    if (functionNode(node)) summaries.set(node, new Set());
    ts.forEachChild(node, visit);
  }
  visit(source);
}

let changed = true;
while (changed) {
  changed = false;
  for (const source of program.getSourceFiles().filter((item) => files.includes(item.fileName))) {
    const imports = importedFsMutators(source);
    const boundary = ownedBoundaries.has(relative(sourceRoot, source.fileName).replaceAll("\\", "/"));
    if (boundary) continue;
    function visit(node) {
      if (ts.isCallExpression(node)) {
        const owner = enclosingFunction(node);
        const summary = owner && summaries.get(owner);
        let required = [];
        if (isDirectMutation(node, imports)) required = mutationArguments(node, imports);
        else {
          const callee = resolvedFunction(node);
          const calleeSummary = callee && summaries.get(callee);
          if (calleeSummary) required = [...calleeSummary];
        }
        for (const index of required) {
          const argument = node.arguments[index];
          if (!argument || !summary) continue;
          const observed = dependency(argument, owner);
          if (observed.managed) violationSites.add(node);
          for (const parameter of observed.parameters) {
            if (!summary.has(parameter)) {
              summary.add(parameter);
              changed = true;
            }
          }
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
}

const failures = [];
for (const site of violationSites) {
  const source = site.getSourceFile();
  const position = source.getLineAndCharacterOfPosition(site.getStart(source));
  failures.push(`${relative(workspaceRoot, source.fileName)}:${position.line + 1}`);
}

if (failures.length > 0) {
  process.stderr.write(`Managed projection mutations must use atomic-write.ts:\n${[...new Set(failures)].sort().join("\n")}\n`);
  process.exitCode = 1;
}
