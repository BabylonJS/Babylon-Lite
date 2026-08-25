import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { GITHUB_COMMENT_TASK, pipelineYamlFiles } from "./pipeline-files";

interface CommentTask {
    location: string;
    body: string;
}

/**
 * Every `GitHubComment@0` task across the scanned pipelines and step
 * templates, located by `file:line`.
 *
 * The subject is Azure's task specifically. GitHub Actions posts PR comments a
 * different way -- `actions/github-script`, `gh pr comment` -- and this
 * predicate would not recognise any of them, even though `.github/workflows/`
 * is inside the shared scope. That is not a hole today: no workflow in this
 * repo posts a comment, verified by searching for all three forms. But it is
 * true *incidentally*, not structurally -- unlike a step template, which cannot
 * declare a job-level thing -- so the first workflow that comments on a PR will
 * need this predicate widened, and nothing here will fail to prompt it.
 *
 * Recorded rather than guarded because there is no subject to guard yet, and a
 * check with an empty subject is the failure this file exists to prevent. The
 * distinction that matters is that "correct for a reason nobody wrote down" is
 * indistinguishable from "correct by luck" at the next edit.
 *
 * These are collected because the job-level PR gate is deliberately the weaker
 * of two possible conditions. Jobs that read PR context are gated on
 * `ne(Build.SourceBranch, 'refs/heads/master')` rather than on
 * `startsWith(..., 'refs/pull/')`, so that a build queued by hand against a
 * feature branch still runs parity/perf/api-report on demand -- a workflow this
 * pipeline has always supported. On such a build there is no pull request, so
 * `System.PullRequest.PullRequestNumber` is empty, exactly as it is on master.
 *
 * That is only survivable because these tasks tolerate the absence. The header
 * comment in azure-pipelines.yml states as much, and the reasoning for the
 * weaker gate rests on it. This test exists so that claim is checked rather
 * than merely written down: prose that a future author *acts on* is an input,
 * not documentation, and an input nobody verifies is how a gate ends up
 * protecting something it no longer protects.
 */
function commentTasks(): CommentTask[] {
    // Shared with the pipefail guard so the two scopes cannot drift apart, and
    // asserted against a tree walk by the closure check in
    // pipeline-piped-steps-set-pipefail.test.ts.
    const files = pipelineYamlFiles();

    // Guard the collector, not the function. An empty file list would make
    // every assertion below vacuously true while still reporting success.
    expect(files.length, "no pipeline YAML files found").toBeGreaterThan(0);

    const tasks: CommentTask[] = [];
    for (const { path, location } of files) {
        const lines = readFileSync(path, "utf8").split("\n");
        for (let i = 0; i < lines.length; i++) {
            const start = GITHUB_COMMENT_TASK.exec(lines[i] ?? "");
            if (!start) {
                continue;
            }
            const dashIndent = (start[1] ?? "").length;

            // The task's own mapping: every following line indented deeper than
            // the `-` marker. Stops at the next list item or the next shallower
            // key, so a sibling task's `continueOnError` can never be mistaken
            // for this one's.
            const body: string[] = [];
            let j = i + 1;
            for (; j < lines.length; j++) {
                const line = lines[j] ?? "";
                if (line.trim() === "") {
                    continue;
                }
                if (line.search(/\S/) <= dashIndent) {
                    break;
                }
                body.push(line);
            }
            tasks.push({ location: `${location}:${i + 1}`, body: body.join("\n") });
            i = j - 1;
        }
    }

    // Guard the collector, not the individual test. An empty list would make
    // the offenders assertion vacuously true -- zero tasks have zero problems
    // -- and putting the floor in only one of the two `it` blocks below would
    // leave the other one silently satisfiable. Inside the collector, every
    // caller inherits it and no future test can opt out by accident.
    //
    // Four today: API Report and Bundle Size in azure-pipelines.yml, plus one
    // in each shared step template. A floor rather than an equality, so adding
    // a comment task is not a failure -- losing the ability to see them is.
    expect(tasks.length, "expected to find the known GitHubComment@0 tasks").toBeGreaterThanOrEqual(4);
    return tasks;
}

describe("GitHubComment tasks tolerate a missing pull request", () => {
    it("collects every GitHubComment@0 task in the pipelines", () => {
        const tasks = commentTasks();

        // Print the subject rather than trusting that it was found. "N things,
        // all correct" is only meaningful if N is visible -- a silently empty
        // set satisfies "all correct" too.
        console.log(`GitHubComment@0 tasks: ${tasks.length}`);
        for (const task of tasks) {
            console.log(`  ${task.location}`);
        }
    });

    it("marks every GitHubComment@0 task continueOnError", () => {
        const offenders = commentTasks()
            .filter((task) => !/^\s*continueOnError:\s*true\s*(?:#.*)?$/m.test(task.body))
            .map((task) => task.location);

        // A GitHubComment@0 whose `id` is an empty PR number does not no-op --
        // it errors, and without continueOnError it fails the whole job. That
        // turns "queue a parity run against my branch" into a red build for a
        // reason unrelated to parity, and it would quietly invalidate the
        // rationale documented for the weaker job-level gate.
        expect(offenders, `GitHubComment@0 task(s) without continueOnError: true:\n  ${offenders.join("\n  ")}`).toEqual([]);
    });
});

describe("GITHUB_COMMENT_TASK selects the tasks this guard is shown", () => {
    // Pinned because it is now a shared selector: this guard reads it and the
    // closure check in pipeline-piped-steps-set-pipefail.test.ts keys discovery
    // on it. An untested selector is the one defect no count in either file can
    // detect, because both inventories are computed by it.
    it.each([
        ["    - task: GitHubComment@0", true],
        ["- task: GitHubComment@0", true],
        ["  - task:  GitHubComment@0  ", true],
        // Case-insensitive, on the same asymmetry as SHELL_STEP_KEY: missing a
        // real task is silent, matching an invalid spelling is harmless.
        ["    - task: githubcomment@0", true],

        // A different task entirely.
        ["    - task: PublishBuildArtifacts@1", false],
        // A different major version has a different input contract; matching it
        // here would assert this guard had checked something it had not.
        ["    - task: GitHubComment@1", false],
        // Prose about the task is not the task.
        ["    # - task: GitHubComment@0", false],
        ["    displayName: post a GitHubComment@0", false],
        ["", false],
    ])("%j -> %s", (line, expected) => {
        expect(GITHUB_COMMENT_TASK.test(line)).toBe(expected);
    });
});
