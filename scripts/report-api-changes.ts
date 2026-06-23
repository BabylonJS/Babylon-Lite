/// <reference types="node" />

import { execFileSync } from "child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, resolve } from "path";
import { Extractor, ExtractorConfig, ExtractorLogLevel } from "@microsoft/api-extractor";
import { format as prettierFormat, resolveConfig as resolvePrettierConfig, type Options as PrettierOptions } from "prettier";

type PullRequestInfo = {
    title: string;
    body: string;
};

type CallableSignature = {
    prefix: string;
    parameters: string[];
    suffix: string;
};

const PACKAGE_NAME = "@babylonjs/lite";
const API_REPORT_FILE_NAME = "babylon-lite.api.md";
const BREAKING_MARKER = /^(?:BREAKING[ -]CHANGE:|[a-z][a-z0-9-]*(?:\([^)]+\))?!:)/m;
const COMMENT_MAX_DIFF_LENGTH = 30_000;

function run(command: string, args: string[], cwd: string, options: { allowFailure?: boolean; inheritStdio?: boolean } = {}): string {
    try {
        return (
            execFileSync(command, args, {
                cwd,
                encoding: "utf-8",
                stdio: options.inheritStdio ? "inherit" : ["ignore", "pipe", "pipe"],
            })?.trim() ?? ""
        );
    } catch (error) {
        if (options.allowFailure) {
            const output = error instanceof Error && "stdout" in error ? String((error as { stdout?: unknown }).stdout ?? "") : "";
            return output.trim();
        }
        throw error;
    }
}

function normalizeBranchRef(value: string | undefined): string {
    const branch = value?.replace(/^refs\/heads\//, "").trim();
    return branch || "master";
}

function escapeAzureVariableValue(value: string): string {
    return value.replace(/%/g, "%AZP25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
}

function packageDir(projectRoot: string): string {
    return resolve(projectRoot, "packages/babylon-lite");
}

function generateApiReport(projectRoot: string, outputDir: string): string {
    const currentPackageDir = packageDir(projectRoot);
    const entryPoint = resolve(currentPackageDir, "dist/index.d.ts");
    const reportFolder = resolve(outputDir, "approved");
    const reportTempFolder = resolve(outputDir, "temp");

    if (!existsSync(entryPoint)) {
        throw new Error(`Cannot generate API report because ${entryPoint} does not exist.`);
    }

    mkdirSync(reportFolder, { recursive: true });
    mkdirSync(reportTempFolder, { recursive: true });

    const config = ExtractorConfig.prepare({
        configObject: {
            projectFolder: currentPackageDir,
            mainEntryPointFilePath: entryPoint,
            compiler: {
                overrideTsconfig: {
                    compilerOptions: {
                        target: "es2022",
                        module: "esnext",
                        moduleResolution: "bundler",
                        lib: ["es2022", "dom", "dom.iterable"],
                        types: ["@webgpu/types"],
                        strict: true,
                        declaration: true,
                        skipLibCheck: true,
                    },
                    include: [entryPoint],
                },
            },
            apiReport: {
                enabled: true,
                reportFileName: "babylon-lite",
                reportFolder,
                reportTempFolder,
            },
            docModel: { enabled: false },
            tsdocMetadata: { enabled: false },
            dtsRollup: { enabled: false },
            messages: {
                compilerMessageReporting: {
                    default: { logLevel: ExtractorLogLevel.Warning },
                },
                extractorMessageReporting: {
                    default: { logLevel: ExtractorLogLevel.Warning },
                    "ae-missing-release-tag": { logLevel: ExtractorLogLevel.None },
                    "ae-undocumented": { logLevel: ExtractorLogLevel.None },
                    "ae-forgotten-export": { logLevel: ExtractorLogLevel.None },
                    "ae-unresolved-link": { logLevel: ExtractorLogLevel.None },
                    "ae-internal-missing-underscore": { logLevel: ExtractorLogLevel.Error },
                },
                tsdocMessageReporting: {
                    default: { logLevel: ExtractorLogLevel.None },
                },
            },
        },
        configObjectFullPath: undefined,
        packageJsonFullPath: resolve(currentPackageDir, "package.json"),
    });

    const result = Extractor.invoke(config, {
        localBuild: true,
        showVerboseMessages: false,
        messageCallback: (message) => {
            if (String(message.messageId).startsWith("console-api-report-")) {
                message.handled = true;
            }
        },
    });
    if (!result.succeeded) {
        throw new Error(`API Extractor failed: ${result.errorCount} errors, ${result.warningCount} warnings`);
    }

    const reportPath = resolve(reportTempFolder, API_REPORT_FILE_NAME);
    if (!existsSync(reportPath)) {
        throw new Error(`API Extractor did not write the expected report at ${reportPath}.`);
    }

    return reportPath;
}

/**
 * Run the TypeScript block inside the `.api.md` report through Prettier so the diff
 * we feed to `breakingApiLines` and post on the PR reflects semantic changes only.
 *
 * API Extractor's `apiReport` writer occasionally emits formatting quirks — e.g. when
 * trailing `@internal` members are trimmed from an interface, the closing `}` ends up
 * glued to the previous member's `;` instead of on its own line. Without normalization,
 * that whitespace-only change shows up as a removed public API line and trips the
 * breaking-change gate. Routing both the current and target reports through the same
 * Prettier config makes the comparison robust to any present or future formatting
 * wobble in the report writer.
 *
 * Failure-safe: if the fenced block can't be located, or Prettier rejects the input,
 * we leave the report untouched (and log a warning) so the script still produces a
 * diff, just with the pre-fix behavior.
 */
const TS_FENCE_PATTERN = /```ts\r?\n([\s\S]*?)\r?\n```/;

async function normalizeApiReport(reportPath: string, prettierConfig: PrettierOptions): Promise<void> {
    const raw = readFileSync(reportPath, "utf-8");
    const match = TS_FENCE_PATTERN.exec(raw);
    if (!match) {
        console.warn(`normalizeApiReport: no \`\`\`ts fence found in ${reportPath}; skipping normalization.`);
        return;
    }

    let formatted: string;
    try {
        formatted = await prettierFormat(match[1]!, { ...prettierConfig, parser: "typescript" });
    } catch (error) {
        console.warn(`normalizeApiReport: Prettier failed on ${reportPath}; skipping normalization. ${error instanceof Error ? error.message : String(error)}`);
        return;
    }

    const normalized = raw.slice(0, match.index) + "```ts\n" + formatted.trimEnd() + "\n```" + raw.slice(match.index + match[0].length);
    if (normalized !== raw) {
        writeFileSync(reportPath, normalized);
    }
}

function createBaselineWorktree(rootDir: string, targetRef: string): string {
    const worktreeDir = mkdtempSync(resolve(tmpdir(), "babylon-lite-api-baseline-"));
    run("git", ["fetch", "origin", `${targetRef}:refs/remotes/origin/${targetRef}`], rootDir, { inheritStdio: true });

    // Build the baseline at the point where this branch diverged from the target
    // branch, not at the target branch tip. Otherwise public API that landed on
    // the target branch *after* this PR branched off is reported as "removed" by
    // the PR — a false breaking-change positive for branches that are merely
    // behind (e.g. a demo-only PR that never touched the framework). The merge
    // base is the exact framework state the PR started from, so the diff reflects
    // only what this PR itself changed. Fall back to the target tip if the merge
    // base cannot be resolved (e.g. a shallow clone with unrelated histories).
    const mergeBase = run("git", ["merge-base", "HEAD", `origin/${targetRef}`], rootDir, { allowFailure: true });
    const baselineRef = mergeBase || `origin/${targetRef}`;
    run("git", ["worktree", "add", "--detach", worktreeDir, baselineRef], rootDir, { inheritStdio: true });
    return worktreeDir;
}

function removeTargetWorktree(rootDir: string, worktreeDir: string): void {
    run("git", ["worktree", "remove", "--force", worktreeDir], rootDir, { allowFailure: true, inheritStdio: true });
    rmSync(worktreeDir, { recursive: true, force: true });
}

function buildPackage(projectRoot: string, options: { installDependencies: boolean }): void {
    if (options.installDependencies) {
        run("pnpm", ["install", "--frozen-lockfile"], projectRoot, { inheritStdio: true });
    }
    run("pnpm", ["--filter", "babylon-lite", "exec", "vite", "build", "--logLevel", "warn"], projectRoot, { inheritStdio: true });
}

function diffReports(rootDir: string, targetReport: string, currentReport: string): string {
    return run("git", ["diff", "--no-index", "--unified=3", "--", targetReport, currentReport], rootDir, { allowFailure: true });
}

function normalizeApiLine(line: string): string {
    return line.trim().replace(/\s+/g, " ");
}

function isIgnorableApiLine(content: string): boolean {
    return !content || content === "}" || content.startsWith("//") || content.startsWith("/*") || content.startsWith("*");
}

function collectChangedApiLines(diff: string, marker: "+" | "-"): string[] {
    const changedLines: string[] = [];

    for (const line of diff.split(/\r?\n/)) {
        if (!line.startsWith(marker) || line.startsWith(`${marker}${marker}${marker}`)) {
            continue;
        }

        const content = normalizeApiLine(line.slice(1));
        if (isIgnorableApiLine(content)) {
            continue;
        }

        changedLines.push(content);
    }

    return changedLines;
}

function updateDepth(character: string, depth: { angle: number; square: number; curly: number }): void {
    if (character === "<") {
        depth.angle += 1;
    } else if (character === ">" && depth.angle > 0) {
        depth.angle -= 1;
    } else if (character === "[") {
        depth.square += 1;
    } else if (character === "]" && depth.square > 0) {
        depth.square -= 1;
    } else if (character === "{") {
        depth.curly += 1;
    } else if (character === "}" && depth.curly > 0) {
        depth.curly -= 1;
    }
}

function findParameterStart(line: string): number {
    const depth = { angle: 0, square: 0, curly: 0 };

    for (let index = 0; index < line.length; index += 1) {
        const character = line[index]!;
        if (character === "(" && depth.angle === 0 && depth.square === 0 && depth.curly === 0) {
            return index;
        }
        updateDepth(character, depth);
    }

    return -1;
}

function findParameterEnd(line: string, parameterStart: number): number {
    const depth = { angle: 0, square: 0, curly: 0 };
    let parenDepth = 0;

    for (let index = parameterStart; index < line.length; index += 1) {
        const character = line[index]!;
        if (character === "(" && depth.angle === 0 && depth.square === 0 && depth.curly === 0) {
            parenDepth += 1;
        } else if (character === ")" && depth.angle === 0 && depth.square === 0 && depth.curly === 0) {
            parenDepth -= 1;
            if (parenDepth === 0) {
                return index;
            }
        } else {
            updateDepth(character, depth);
        }
    }

    return -1;
}

function splitParameters(parametersText: string): string[] {
    const parameters: string[] = [];
    const depth = { angle: 0, square: 0, curly: 0 };
    let parenDepth = 0;
    let segmentStart = 0;

    for (let index = 0; index < parametersText.length; index += 1) {
        const character = parametersText[index]!;

        if (character === "(" && depth.angle === 0 && depth.square === 0 && depth.curly === 0) {
            parenDepth += 1;
        } else if (character === ")" && depth.angle === 0 && depth.square === 0 && depth.curly === 0 && parenDepth > 0) {
            parenDepth -= 1;
        } else if (character === "," && depth.angle === 0 && depth.square === 0 && depth.curly === 0 && parenDepth === 0) {
            parameters.push(normalizeApiLine(parametersText.slice(segmentStart, index)));
            segmentStart = index + 1;
        } else {
            updateDepth(character, depth);
        }
    }

    const finalParameter = normalizeApiLine(parametersText.slice(segmentStart));
    if (finalParameter) {
        parameters.push(finalParameter);
    }

    return parameters;
}

function parseCallableSignature(line: string): CallableSignature | undefined {
    const parameterStart = findParameterStart(line);
    if (parameterStart === -1) {
        return undefined;
    }

    const parameterEnd = findParameterEnd(line, parameterStart);
    if (parameterEnd === -1) {
        return undefined;
    }

    return {
        prefix: normalizeApiLine(line.slice(0, parameterStart)),
        parameters: splitParameters(line.slice(parameterStart + 1, parameterEnd)),
        suffix: normalizeApiLine(line.slice(parameterEnd + 1)),
    };
}

function isOptionalParameter(parameter: string): boolean {
    return parameter.startsWith("...") || /^[A-Za-z_$][\w$]*\s*\?:/.test(parameter);
}

function isNonBreakingOptionalParameterExpansion(removedLine: string, addedLine: string): boolean {
    const removedSignature = parseCallableSignature(removedLine);
    const addedSignature = parseCallableSignature(addedLine);

    if (!removedSignature || !addedSignature) {
        return false;
    }

    if (removedSignature.prefix !== addedSignature.prefix || removedSignature.suffix !== addedSignature.suffix) {
        return false;
    }

    if (addedSignature.parameters.length <= removedSignature.parameters.length) {
        return false;
    }

    for (let index = 0; index < removedSignature.parameters.length; index += 1) {
        if (removedSignature.parameters[index] !== addedSignature.parameters[index]) {
            return false;
        }
    }

    return addedSignature.parameters.slice(removedSignature.parameters.length).every(isOptionalParameter);
}

const CONST_LITERAL_PATTERN = /^export (?:declare )?const ([A-Za-z_$][\w$]*) = (.+);$/;
const CONST_TYPED_PATTERN = /^export (?:declare )?const ([A-Za-z_$][\w$]*): (.+);$/;

/**
 * Widen a literal initializer (as it appears in an `.api.md` const line) to the
 * primitive base type the TypeScript compiler would infer for it without an
 * explicit annotation. Returns `undefined` for initializers we cannot classify
 * (object/array/enum/call expressions, etc.), which keeps the change classified
 * as breaking by default.
 */
function widenLiteralType(literal: string): string | undefined {
    const trimmed = literal.trim();
    if (/^(['"]).*\1$/.test(trimmed) || trimmed.startsWith("`")) {
        return "string";
    }
    if (trimmed === "true" || trimmed === "false") {
        return "boolean";
    }
    if (/^-?\d[\d_]*n$/.test(trimmed)) {
        return "bigint";
    }
    if (/^-?(?:0[xob][0-9a-f_]+|(?:\d[\d_]*)?\.?\d[\d_]*(?:e[+-]?\d+)?)$/i.test(trimmed)) {
        return "number";
    }
    return undefined;
}

/**
 * Treat a `const` whose only change is its literal type widening to that
 * literal's primitive base type as non-breaking — e.g.
 * `export const VERSION = "0.1.0";` → `export const VERSION: string;`. This is
 * what happens when a const that used to hold a compile-time literal is computed
 * at build time instead (its declared type widens from `"0.1.0"` to `string`).
 * Value consumers are unaffected and only the exact-literal *type* is lost, so
 * we classify it as additive rather than breaking.
 */
function isNonBreakingConstLiteralWidening(removedLine: string, addedLine: string): boolean {
    const removed = CONST_LITERAL_PATTERN.exec(removedLine);
    const added = CONST_TYPED_PATTERN.exec(addedLine);
    if (!removed || !added || removed[1] !== added[1]) {
        return false;
    }
    return widenLiteralType(removed[2]!) === added[2]!.trim();
}

/**
 * The TypedArray / buffer-view types that TypeScript 5.7 made generic over their
 * backing buffer (`Float32Array` → `Float32Array<TArrayBuffer extends ArrayBufferLike>`).
 * Older TypeScript libs render these without a type argument, so when the API-report
 * baseline is built from a merge base that predates the TS bump, every typed-array
 * member shows up as a removed/changed line (`Float32Array` ↔ `Float32Array<ArrayBuffer>`).
 * That is a pure rendering change, not a public API break.
 */
const GENERIC_TYPED_ARRAY_NAMES = [
    "Int8Array",
    "Uint8Array",
    "Uint8ClampedArray",
    "Int16Array",
    "Uint16Array",
    "Int32Array",
    "Uint32Array",
    "Float16Array",
    "Float32Array",
    "Float64Array",
    "BigInt64Array",
    "BigUint64Array",
];

const GENERIC_TYPED_ARRAY_PATTERN = new RegExp(`\\b(${GENERIC_TYPED_ARRAY_NAMES.join("|")})<\\s*(?:ArrayBuffer|ArrayBufferLike)\\s*>`, "g");

/**
 * Drop the *implicit/default* buffer type argument from TypedArray types so two reports
 * compare equal regardless of which TypeScript lib emitted them (e.g.
 * `Float32Array<ArrayBuffer>` → `Float32Array`). Only `ArrayBuffer` / `ArrayBufferLike`
 * — the argument inferred for an ordinary, non-shared typed array — is stripped. An
 * explicit non-default backing buffer such as `SharedArrayBuffer` is left intact so a
 * deliberate `Float32Array<ArrayBuffer>` → `Float32Array<SharedArrayBuffer>` change still
 * reads as a real (breaking) API change.
 */
function normalizeTypedArrayGenerics(line: string): string {
    return line.replace(GENERIC_TYPED_ARRAY_PATTERN, "$1");
}

/**
 * Treat a member whose only change is a TypedArray gaining or losing its TS 5.7 *default*
 * buffer type argument (e.g. `Float32Array` ↔ `Float32Array<ArrayBuffer>`) as non-breaking.
 * The runtime type is unchanged; only the lib's textual rendering differs. A change to a
 * non-default backing buffer (e.g. `SharedArrayBuffer`) is not normalized and stays breaking.
 */
function isNonBreakingTypedArrayGenericWidening(removedLine: string, addedLine: string): boolean {
    if (removedLine === addedLine) {
        return false;
    }
    return normalizeTypedArrayGenerics(removedLine) === normalizeTypedArrayGenerics(addedLine);
}

export function breakingApiLines(diff: string): string[] {
    const removedLines = collectChangedApiLines(diff, "-");
    const addedLines = collectChangedApiLines(diff, "+");

    return removedLines.filter(
        (removedLine) =>
            !addedLines.some(
                (addedLine) =>
                    isNonBreakingOptionalParameterExpansion(removedLine, addedLine) ||
                    isNonBreakingConstLiteralWidening(removedLine, addedLine) ||
                    isNonBreakingTypedArrayGenericWidening(removedLine, addedLine)
            )
    );
}

function truncateDiff(diff: string): string {
    if (diff.length <= COMMENT_MAX_DIFF_LENGTH) {
        return diff;
    }

    return `${diff.slice(0, COMMENT_MAX_DIFF_LENGTH)}\n\n... diff truncated for GitHub comment length ...`;
}

function formatComment(diff: string, breakingLines: string[]): string {
    if (!diff) {
        return "**API Report**: No public API changes detected.";
    }

    const lines = ["## API Changes", "", `API Extractor detected public API changes for \`${PACKAGE_NAME}\`.`];

    if (breakingLines.length > 0) {
        lines.push("", "**Potentially breaking changes detected.** Removed or changed public API lines:", "");
        for (const line of breakingLines.slice(0, 20)) {
            lines.push(`- \`${line.replace(/`/g, "\\`")}\``);
        }
        if (breakingLines.length > 20) {
            lines.push(`- ...and ${breakingLines.length - 20} more removed/changed lines.`);
        }
    } else {
        lines.push("", "No removed public API lines were detected; this appears to be additive.");
    }

    lines.push("", "<details>", "<summary>API Extractor diff</summary>", "", "```diff", truncateDiff(diff), "```", "", "</details>");

    return lines.join("\n");
}

function getPullRequestFromEnv(): PullRequestInfo | undefined {
    if (!process.env.PR_TITLE && !process.env.PR_BODY) {
        return undefined;
    }

    return {
        title: process.env.PR_TITLE ?? "",
        body: process.env.PR_BODY ?? "",
    };
}

async function getPullRequestFromGitHub(): Promise<PullRequestInfo | undefined> {
    const repository = process.env.GITHUB_REPOSITORY;
    const pullRequestNumber = process.env.PR_NUMBER;
    const token = process.env.GITHUB_TOKEN;

    if (!repository || !pullRequestNumber || !token) {
        return undefined;
    }

    const response = await fetch(`https://api.github.com/repos/${repository}/pulls/${pullRequestNumber}`, {
        headers: {
            accept: "application/vnd.github+json",
            authorization: `Bearer ${token}`,
            "user-agent": "babylon-lite-api-report-check",
        },
    });

    if (!response.ok) {
        throw new Error(`Failed to read PR metadata from GitHub: ${response.status} ${response.statusText}`);
    }

    const pullRequest = (await response.json()) as { title?: unknown; body?: unknown };
    return {
        title: typeof pullRequest.title === "string" ? pullRequest.title : "",
        body: typeof pullRequest.body === "string" ? pullRequest.body : "",
    };
}

async function hasBreakingMarkerInPullRequest(): Promise<boolean> {
    const pullRequest = getPullRequestFromEnv() ?? (await getPullRequestFromGitHub());
    if (!pullRequest) {
        return false;
    }

    return BREAKING_MARKER.test(`${pullRequest.title}\n\n${pullRequest.body}`);
}

async function main(): Promise<void> {
    const rootDir = resolve(__dirname, "..");
    const targetBranch = normalizeBranchRef(process.env.SYSTEM_PULLREQUEST_TARGETBRANCH ?? process.env.API_REPORT_TARGET_BRANCH);
    const outputDir = resolve(rootDir, "test-results/api-report");
    const currentOutputDir = resolve(outputDir, "current");
    const targetOutputDir = resolve(outputDir, "target");
    const commentPath = process.env.API_REPORT_COMMENT_PATH ?? resolve(outputDir, "api-report-comment.md");
    let targetWorktree = "";

    console.log(`Generating API report comparison against ${targetBranch}.`);
    rmSync(outputDir, { recursive: true, force: true });
    mkdirSync(outputDir, { recursive: true });

    try {
        // Resolve the Prettier config once, from a real file path inside the current repo, so
        // both reports get normalized with identical options. Prettier's `resolveConfig` requires
        // a file path (not a directory) — it starts the upward search at `dirname(path)`. We use
        // this script itself as the anchor so the resolved config tracks the *current* branch,
        // never the target worktree (otherwise a `.prettierrc` change between branches could
        // reintroduce formatting-only diffs).
        const prettierConfig = (await resolvePrettierConfig(resolve(__dirname, "report-api-changes.ts"))) ?? {};

        console.log("Building current branch package...");
        buildPackage(rootDir, { installDependencies: false });
        const currentReport = generateApiReport(rootDir, currentOutputDir);
        await normalizeApiReport(currentReport, prettierConfig);

        console.log(`Building baseline package from the merge base with origin/${targetBranch}...`);
        targetWorktree = createBaselineWorktree(rootDir, targetBranch);
        buildPackage(targetWorktree, { installDependencies: true });
        const targetReport = generateApiReport(targetWorktree, targetOutputDir);
        await normalizeApiReport(targetReport, prettierConfig);

        const diff = diffReports(rootDir, targetReport, currentReport);
        const breakingLines = breakingApiLines(diff);
        const comment = formatComment(diff, breakingLines);

        mkdirSync(dirname(commentPath), { recursive: true });
        writeFileSync(commentPath, comment, "utf-8");
        console.log(comment);

        const hasApiChanges = diff.length > 0;
        console.log(`##vso[task.setvariable variable=POST_API_COMMENT]${hasApiChanges ? "true" : "false"}`);
        console.log(`##vso[task.setvariable variable=API_COMMENT_BODY]${escapeAzureVariableValue(comment)}`);

        if (breakingLines.length > 0 && !(await hasBreakingMarkerInPullRequest())) {
            console.error(
                "API Extractor detected removed or changed public API lines, but the PR title or description does not contain a breaking-change marker. " +
                    "Add a Conventional Commit breaking marker such as 'feat!: ...' or a 'BREAKING CHANGE:' footer."
            );
            process.exitCode = 1;
        }
    } finally {
        if (targetWorktree) {
            removeTargetWorktree(rootDir, targetWorktree);
        }
    }
}

if (require.main === module) {
    void main();
}
