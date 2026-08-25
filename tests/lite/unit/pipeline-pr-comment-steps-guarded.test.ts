import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "fs";
import { join } from "path";

const repoRoot = join(__dirname, "..", "..", "..");

interface CommentTask {
    location: string;
    body: string;
}

/**
 * Every `GitHubComment@0` task across the pipelines and the shared step
 * templates they include, located by `file:line`.
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
    const roots = [
        { dir: repoRoot, label: "" },
        { dir: join(repoRoot, "config", "templates"), label: "config/templates" },
    ];

    const files: { path: string; location: string }[] = [];
    for (const { dir, label } of roots) {
        for (const name of readdirSync(dir)) {
            if (!/\.ya?ml$/.test(name)) {
                continue;
            }
            if (label === "" && !/^azure-pipelines.*\.ya?ml$/.test(name)) {
                continue;
            }
            files.push({ path: join(dir, name), location: label ? `${label}/${name}` : name });
        }
    }

    // Guard the collector, not the function. An empty file list would make
    // every assertion below vacuously true while still reporting success.
    expect(files.length, "no pipeline YAML files found").toBeGreaterThan(0);

    const tasks: CommentTask[] = [];
    for (const { path, location } of files) {
        const lines = readFileSync(path, "utf8").split("\n");
        for (let i = 0; i < lines.length; i++) {
            const start = /^(\s*)-\s+task:\s*GitHubComment@0\s*$/.exec(lines[i] ?? "");
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
