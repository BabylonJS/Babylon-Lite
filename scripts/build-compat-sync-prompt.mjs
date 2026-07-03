/**
 * Builds the prompt for the compat-sync agent step and writes it to stdout.
 *
 * Used by azure-pipelines-compat-sync.yml. Keeping the prompt in a script (rather
 * than an inline shell heredoc) avoids YAML indentation bleeding into the prompt
 * and safely handles arbitrary issue text (newlines, quotes, `$`, backticks).
 *
 * When the pipeline was triggered by a `compat`-labelled issue, the issue's
 * title + body are fetched from the GitHub API and appended so the agent acts on
 * the actual request rather than just the issue number.
 *
 * Env:
 *   - ISSUE_NUMBER   triggering issue number, or "none"/"0"/empty for a plain sync
 *   - TARGET_REPO    "owner/repo" the issue lives in
 *   - REPO_TOKEN     repo-scoped token able to read the issue (private repos too)
 */

const BASE_PROMPT = `Follow the instructions in .github/copilot/skills/update-compat-layer.md to reconcile the @babylonjs/lite-compat layer against the latest Babylon.js and Babylon Lite changes. This run is fundamentally about reacting to change: pick up EVERYTHING that changed upstream (Task 1) and close API-parity gaps in the compat surface (Task 3). Be COMPREHENSIVE, not minimal: implement every API that is newly possible this sync and cover every core/loaders change since the last synced commit — do not stop after a single API or a single change. The "land at least one" outcomes in the skill are a floor, not the goal; the goal is to address the full set of changes and newly-unblocked gaps this run. Add GPU-free tests for everything you implement. Lab-scene parity (Task 2) is conditional: only drive a lab oracle scene to pixel parity if a new Lite feature or other Lite change this run makes a previously-skipped scene possible; otherwise do no scene work. Update packages/babylon-lite-compat/COMPAT-STATUS.md (including the synced commit SHA and date). Before finishing, run the compat checks from the skill's 'Test coverage' section and make sure they pass: 'pnpm exec vitest run --project compat', the two compat typechecks, ESLint, and Prettier. Only run 'pnpm build:bundle-scenes' if you added anything to packages/babylon-lite/ core this run (to prove tree-shakeability). Do NOT run 'pnpm test:perf' or the Lite parity suite ('pnpm test:parity'); do NOT change bundle-size ceilings or golden reference screenshots. Do not open a pull request or push — the pipeline does that. As your final step, write a concise (max ~70 chars), descriptive one-line PR title summarizing the specific changes this run to the file '.compat-sync-pr-title.txt' in the repo root (e.g. "Wrap AnimationGroup blending + 3 loader stubs" or "Add MorphTargetManager API and sync to BJS abc1234"); write the bare summary only — do NOT add a '[compat-sync]' prefix or any other prefix, the pipeline prepends it deterministically. If there is nothing to change, make no edits and do not write the title file.`;

/** Resolve the triggering issue number, treating "none"/"0"/empty as no issue. */
function resolveIssueNumber(raw) {
    const value = (raw ?? "").trim();
    if (!value || value.toLowerCase() === "none" || value === "0") {
        return undefined;
    }
    return value;
}

async function fetchIssue(repo, issueNumber, token) {
    const response = await fetch(`https://api.github.com/repos/${repo}/issues/${issueNumber}`, {
        headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": "compat-sync-pipeline",
        },
    });
    if (!response.ok) {
        throw new Error(`Failed to fetch issue #${issueNumber} from ${repo} (${response.status}): ${await response.text()}`);
    }
    return await response.json();
}

async function main() {
    const issueNumber = resolveIssueNumber(process.env.ISSUE_NUMBER);
    if (!issueNumber) {
        process.stdout.write(BASE_PROMPT);
        return;
    }

    const repo = process.env.TARGET_REPO;
    const token = process.env.REPO_TOKEN;
    if (!repo || !token) {
        throw new Error("ISSUE_NUMBER is set but TARGET_REPO and/or REPO_TOKEN are missing.");
    }

    const issue = await fetchIssue(repo, issueNumber, token);
    const title = (issue.title ?? "").toString();
    const body = (issue.body ?? "").toString();

    const issueSection = [
        "",
        "",
        `This run was triggered by issue #${issueNumber} (labeled 'compat'). Treat the following issue as the specific request to address; prioritize it over the general sync above where they differ, and reference issue #${issueNumber} in your work.`,
        "",
        `Issue title: ${title}`,
        "",
        "Issue body:",
        body,
    ].join("\n");

    process.stdout.write(BASE_PROMPT + issueSection);
}

main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
});
