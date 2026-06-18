/**
 * Compat-layer sync — PR driver (Azure DevOps port of the gh-aw safe-output job).
 *
 * Runs AFTER an agent step has executed the `update-compat-layer` skill (which may
 * have edited files under `packages/babylon-lite-compat/`, plus `scene-config.json`
 * and lab oracle scenes when it lands a new scene). This script is the
 * deterministic, CI-owned half of the job:
 *
 *   1. Re-validate independently (compat unit tests + typecheck) — we never trust
 *      the agent's self-report; the pipeline verifies.
 *   2. Detect whether the agent actually changed anything.
 *   3. If it did, create a branch, commit, push, and open a DRAFT PR via the GitHub
 *      API. The PR is ALWAYS a draft (mirroring the gh-aw `create-pull-request:
 *      draft: true` safe output); the independent validation result is captured in
 *      the body so a reviewer sees whether the guardrails passed before merging.
 *
 * Idempotent: a run with no BJS/Lite changes produces no commit and no PR (the
 * gh-aw `noop` equivalent).
 *
 * Required env:
 *   - GITHUB_TOKEN        token with `contents:write` + `pull_requests:write`
 *   - GITHUB_REPOSITORY   e.g. "BabylonJS/Babylon-Lite"
 * Optional env:
 *   - BASE_BRANCH         default "master"
 *   - GIT_USER_NAME       default "Babylon.js CI"
 *   - GIT_USER_EMAIL      default "bjsplat@gmail.com"
 *   - ISSUE_NUMBER        when set, the run was triggered by an issue labeled
 *                         `compat`; referenced in the PR body so it auto-links
 *   - DRY_RUN             when "true", do everything except push + open PR
 */

import { execFileSync } from "child_process";

const REPO = requireEnv("GITHUB_REPOSITORY");
const TOKEN = requireEnv("GITHUB_TOKEN");
const BASE_BRANCH = process.env.BASE_BRANCH ?? "master";
const GIT_USER_NAME = process.env.GIT_USER_NAME ?? "Babylon.js CI";
const GIT_USER_EMAIL = process.env.GIT_USER_EMAIL ?? "bjsplat@gmail.com";
// Treat the ADO sentinel "none" (and "0"/empty) as "no triggering issue". ADO marks
// string parameters as required, so manual runs pass "none" rather than an empty string.
const ISSUE_NUMBER = normalizeIssueNumber(process.env.ISSUE_NUMBER);
const DRY_RUN = process.env.DRY_RUN === "true";

/** Labels applied to the opened PR (mirrors the gh-aw safe-output `labels`). */
const PR_LABELS = ["compat", "automation"];

async function main(): Promise<void> {
    // 1. Independent validation (does not throw — captured for the PR body).
    const validation = runValidation();

    // 2. Did the agent change anything at all? (compat wrappers, tests, the status
    //    file, and — when a scene is landed — scene-config.json + lab oracle files).
    const changedFiles = listChangedFiles();
    if (changedFiles.length === 0) {
        console.log("No changes this run. Nothing to do (noop).");
        return;
    }
    console.log(`Detected ${changedFiles.length} changed file(s):\n${changedFiles.map((f) => `  ${f}`).join("\n")}`);

    // 3. Branch, commit, push, draft PR.
    const date = new Date().toISOString().slice(0, 10);
    const branch = `compat-sync/${date}`;

    configureGit();
    runGit(["checkout", "-b", branch]);
    runGit(["add", "-A"]);
    runGit(["commit", "-m", commitMessage(date)]);

    if (DRY_RUN) {
        console.log(`[dry-run] Would push ${branch} to ${REPO} and open a draft PR.`);
        return;
    }

    // Push the branch directly to the TARGET repo (REPO) rather than the checkout's
    // `origin`. This decouples "where the pipeline runs" (e.g. a fork) from "where the
    // PR lands" (e.g. upstream BabylonJS/Babylon-Lite) — GITHUB_TOKEN just needs push
    // access to REPO. The PR is then a same-repo PR with head = branch.
    const pushUrl = `https://x-access-token:${TOKEN}@github.com/${REPO}.git`;
    runGit(["push", "--force-with-lease", pushUrl, `HEAD:refs/heads/${branch}`]);
    const { url, number } = await openPullRequest(branch, validation, changedFiles);
    await applyLabels(number);
    console.log(`Opened draft PR: ${url}`);
}

interface ValidationResult {
    passed: boolean;
    log: string;
}

function runValidation(): ValidationResult {
    const steps: Array<{ name: string; cmd: string; args: string[] }> = [
        { name: "compat unit tests", cmd: "npx", args: ["vitest", "run", "--project", "compat"] },
        { name: "compat typecheck", cmd: "npx", args: ["tsc", "-p", "packages/babylon-lite-compat/tsconfig.json", "--noEmit"] },
    ];

    let passed = true;
    const log: string[] = [];
    for (const step of steps) {
        try {
            execFileSync(step.cmd, step.args, { cwd: process.cwd(), encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
            log.push(`- ✅ ${step.name}`);
        } catch (error) {
            passed = false;
            const message = error instanceof Error ? error.message : String(error);
            log.push(`- ❌ ${step.name}\n\n\`\`\`\n${message.slice(0, 2000)}\n\`\`\``);
        }
    }
    return { passed, log: log.join("\n") };
}

function listChangedFiles(): string[] {
    const out = runGit(["status", "--porcelain"]);
    return out
        .split("\n")
        .map((line) => line.slice(3).trim())
        .filter(Boolean);
}

function commitMessage(date: string): string {
    // Conventional-commit "chore" so the npm release pipeline never mistakes a
    // compat sync for a feature/breaking change in @babylonjs/lite.
    return `chore(compat): Babylon.js compat-layer sync (${date})`;
}

function bjsSha(): string {
    const out = runGit(["grep", "-hoE", "Last synced BJS commit:\\** `[0-9a-f]{7,40}`", "--", "packages/babylon-lite-compat/COMPAT-STATUS.md"], true);
    const match = out.match(/`([0-9a-f]{7,40})`/);
    return match ? match[1]! : "(unknown)";
}

async function openPullRequest(branch: string, validation: ValidationResult, changedFiles: string[]): Promise<{ url: string; number: number }> {
    const title = `[compat-sync] Babylon.js compat-layer sync`;
    const body = [
        "Automated sync of `@babylonjs/lite-compat` against the latest Babylon.js and Babylon Lite changes,",
        "produced by the [`update-compat-layer`](.github/copilot/skills/update-compat-layer.md) skill.",
        "",
        ...(ISSUE_NUMBER ? [`Addresses #${ISSUE_NUMBER}.`, ""] : []),
        `**Synced against BJS commit:** \`${bjsSha()}\``,
        "",
        "### Validation (run independently by the pipeline)",
        validation.log,
        "",
        "### Changed files",
        changedFiles.map((f) => `- \`${f}\``).join("\n"),
        "",
        validation.passed
            ? "> Validation passed. Please review the wrapper changes and the updated `COMPAT-STATUS.md` before merging."
            : "> ⚠️ Validation did **not** fully pass (see above). Opened as a draft for a maintainer to resolve before merging.",
        "",
        "> Opened as a **draft** by the compat-sync pipeline. Review and mark ready when satisfied.",
    ].join("\n");

    const response = await fetch(`https://api.github.com/repos/${REPO}/pulls`, {
        method: "POST",
        headers: {
            Authorization: `Bearer ${TOKEN}`,
            Accept: "application/vnd.github+json",
            "Content-Type": "application/json",
            "X-GitHub-Api-Version": "2022-11-28",
        },
        body: JSON.stringify({ title, head: branch, base: BASE_BRANCH, body, draft: true }),
    });

    if (!response.ok) {
        throw new Error(`Failed to open PR (${response.status}): ${await response.text()}`);
    }
    const json = (await response.json()) as { html_url?: string; number?: number };
    return { url: json.html_url ?? "(unknown URL)", number: json.number ?? 0 };
}

/** Apply the automation labels to the freshly-opened PR (best-effort). */
async function applyLabels(prNumber: number): Promise<void> {
    if (!prNumber) {
        return;
    }
    const response = await fetch(`https://api.github.com/repos/${REPO}/issues/${prNumber}/labels`, {
        method: "POST",
        headers: {
            Authorization: `Bearer ${TOKEN}`,
            Accept: "application/vnd.github+json",
            "Content-Type": "application/json",
            "X-GitHub-Api-Version": "2022-11-28",
        },
        body: JSON.stringify({ labels: PR_LABELS }),
    });
    if (!response.ok) {
        // Non-fatal: labels may not exist in the repo. Log and continue.
        console.warn(`Could not apply labels (${response.status}): ${await response.text()}`);
    }
}

function configureGit(): void {
    runGit(["config", "user.name", GIT_USER_NAME]);
    runGit(["config", "user.email", GIT_USER_EMAIL]);
}

function runGit(args: string[], allowFailure = false): string {
    try {
        return execFileSync("git", args, { cwd: process.cwd(), encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }).trim();
    } catch (error) {
        if (allowFailure) {
            return "";
        }
        throw new Error(redactToken(error instanceof Error ? error.message : String(error)));
    }
}

function requireEnv(name: string): string {
    const value = process.env[name];
    if (!value) {
        throw new Error(`Missing required environment variable: ${name}`);
    }
    return value;
}

/** Strip the auth token from any string before it can be logged. */
function redactToken(text: string): string {
    return TOKEN ? text.split(TOKEN).join("***") : text;
}

/** Resolve the triggering issue number, treating "none"/"0"/empty as no issue. */
function normalizeIssueNumber(raw: string | undefined): string | undefined {
    const value = raw?.trim();
    if (!value || value.toLowerCase() === "none" || value === "0") {
        return undefined;
    }
    return value;
}

main().catch((error: unknown) => {
    console.error(redactToken(error instanceof Error ? error.message : String(error)));
    process.exit(1);
});
