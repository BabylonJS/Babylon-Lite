import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { GITHUB_COMMENT_TASK, pipelineYamlFiles, repoRoot } from "./pipeline-files";

/**
 * Guards the claim this repository's post-merge validation rests on: **no job
 * that needs a pull request runs on a `master` build.**
 *
 * `azure-pipelines.yml` was `trigger: none` until recently, so nothing
 * validated `master` after a merge. Giving it a `master` trigger fixed that and
 * created a new hazard in the same edit: six of its nine jobs read pull-request
 * context that does not exist on a master build. `System.PullRequest.*`
 * variables are empty there, and a `GitHubComment@0` task pointed at an empty
 * PR number does not quietly no-op -- it fails. Those jobs are held off master
 * by a `condition:` and nothing else.
 *
 * A `condition:` is one line, carries no type, and is invisible to every other
 * check in this repository. Deleting all eight of them was measured against the
 * full unit suite while this file was being written: **2052 passed**. The
 * property the master trigger depends on had no executable coverage at all, and
 * the only mention of `refs/heads/master` anywhere under `tests/` was a
 * sentence in a comment describing the gate. Prose asserting a property the
 * code does not check is the failure mode this suite exists to catch, and it
 * had settled on the suite's own subject.
 *
 * Two clauses, deliberately pointing in opposite directions, because the two
 * ways to get this wrong need opposite repairs:
 *
 * 1. **A PR-context job loses its gate** -- it then runs on master and fails
 *    for a reason that has nothing to do with the merge that triggered it. The
 *    repair is to add the gate.
 * 2. **A deterministic job gains a gate** -- master then runs fewer jobs, and
 *    in the limit runs none. That build is *green*. It is green because it did
 *    nothing, which is precisely the state the master trigger was added to end,
 *    and a green master is the one signal nobody investigates. The repair is to
 *    remove the gate.
 *
 * Clause 2 is the one worth defending in review, because "we gated one more
 * job" never looks like a regression in a diff. It is the original bug of this
 * PR, reachable one `condition:` at a time.
 */

/**
 * A job is PR-context when its body reads a `System.PullRequest.*` variable or
 * posts a `GitHubComment@0`.
 *
 * Derived from content rather than listed by name, so a *new* job that reads PR
 * context is covered on the commit that adds it. A hand-maintained list of job
 * names would be correct today and silently short by one the first time someone
 * copies an existing job, which is how every job in this file was written.
 */
const PR_CONTEXT_MARKERS = [/System\.PullRequest\./, GITHUB_COMMENT_TASK];

/**
 * Pull-request context reaches a job through `- template:` as readily as
 * through its own steps, and the job body then says only `- template: ...`.
 *
 * This was not a hypothetical. The first version of this guard matched markers
 * against job bodies alone and classified `PerfRegression` and `ParityCloud` as
 * gated for cost rather than for correctness -- but both include
 * `upload-test-report.yml`, which posts a `GitHubComment@0` keyed on
 * `$(System.PullRequest.PullRequestNumber)`. Their gates are load-bearing in
 * both senses, and a future "this job is cheap now, ungate it" would have been
 * waved through by a guard whose whole purpose is to stop exactly that.
 *
 * Resolution is bounded rather than recursive-until-fixpoint: a cycle in
 * pipeline templates is an ADO error long before it is this guard's problem,
 * and an unbounded walk here would hang the test rather than report anything.
 */
function withTemplatesResolved(text: string, depth = 3): string {
    if (depth === 0) {
        return text;
    }

    return text.replace(/^\s*-\s*template:\s*(\S+)\s*$/gm, (line, path: string) => {
        try {
            return line + "\n" + withTemplatesResolved(readFileSync(join(repoRoot, path), "utf8"), depth - 1);
        } catch {
            // A template this guard cannot read is left as its own text. Being
            // unable to resolve an include is not evidence that the include is
            // safe, so the line stays and the markers still see it.
            return line;
        }
    });
}

/**
 * The gate itself, spelled tolerantly.
 *
 * Matching the exact source line would make this guard fail on a reformat and
 * pass on a rewrite that changed the branch -- backwards on both counts.
 */
const MASTER_GATE = /ne\(\s*variables\[\s*['"]Build\.SourceBranch['"]\s*\]\s*,\s*['"]refs\/heads\/master['"]\s*\)/i;

/**
 * Named floors. Both clauses assert an *absence* -- no ungated PR-context job,
 * no gated deterministic job -- and an absence is satisfied perfectly by
 * looking at nothing. If the job splitter below stops splitting, or the trigger
 * filter stops selecting `azure-pipelines.yml`, both clauses pass while
 * measuring an empty set.
 *
 * So each clause is floored by the names its own failure would remove, one per
 * job the clause is about, rather than by a count. A count would have to be
 * edited every time a job is added -- drift -- and `> 0` is satisfied by a
 * single survivor, which is the exact defect these floors exist to prevent.
 */
const KNOWN_PR_CONTEXT_JOBS = ["ReleaseMarkers", "ApiReport", "BundleSize", "PerfRegression", "ParityCloud", "PlaygroundSnapshot"];
const KNOWN_MASTER_JOBS = ["UnitTests", "Lint", "Compat"];

/**
 * True when this pipeline can produce a build of `master`.
 *
 * Absent or unrecognised trigger blocks are treated as **can run on master**,
 * which is the safe direction: a file wrongly included here fails only if it
 * also carries PR context, whereas a file wrongly excluded is invisible
 * forever.
 */
function canRunOnMaster(text: string): boolean {
    const declared = /^trigger:[ \t]*(\S*)[ \t]*$/m.exec(text);
    if (!declared) {
        return true;
    }
    if (declared[1] === "none") {
        return false;
    }
    if (declared[1] !== "") {
        return true;
    }

    const block = text.slice(declared.index + declared[0].length);
    const body = block.split("\n").slice(1);
    const end = body.findIndex((line) => line.trim() !== "" && !/^\s/.test(line));
    return (end === -1 ? body : body.slice(0, end)).some((line) => /(^|[\s/])master\s*$/.test(line));
}

/** True when this pipeline builds pull requests. */
function canBuildPullRequests(text: string): boolean {
    const declared = /^pr:[ \t]*(\S*)[ \t]*$/m.exec(text);
    return declared !== null && declared[1] !== "none";
}

type PipelineJob = { name: string; body: string; gated: boolean };

/**
 * Splits a pipeline into its jobs.
 *
 * `body` is the job with its templates resolved, because that is what the
 * markers must see. `gated` is read from the *unresolved* lines, because a
 * `condition:` written inside a template belongs to a step in that template and
 * says nothing about whether the job runs -- inlining first would let a
 * template's own `condition: failed()` be mistaken for the job's gate.
 *
 * The `condition:` that counts sits at the indentation of the job's sibling
 * keys -- `- job: X` at indent N puts `displayName:` and `condition:` at N + 2.
 * A `condition:` on a step inside the job is deeper and gates only that step,
 * so accepting any `condition:` in the body would let one guarded step certify
 * an unguarded job.
 */
function jobsIn(text: string): PipelineJob[] {
    const lines = text.split("\n");
    const starts: { name: string; line: number; keyIndent: number }[] = [];

    lines.forEach((line, index) => {
        const match = /^(\s*)-\s+job:\s*(\S+)\s*$/.exec(line);
        if (match) {
            starts.push({ name: match[2] ?? "", line: index, keyIndent: (match[1] ?? "").length + 2 });
        }
    });

    return starts.map((start, index) => {
        const raw = lines.slice(start.line, starts[index + 1]?.line ?? lines.length);
        const ownCondition = raw.filter((line) => new RegExp(`^\\s{${start.keyIndent}}condition:`).test(line));
        return {
            name: start.name,
            body: withTemplatesResolved(raw.join("\n")),
            gated: ownCondition.some((line) => MASTER_GATE.test(line)),
        };
    });
}

/**
 * The subject is pipelines that build **both** pull requests and master.
 *
 * That is the hazard this PR created and the narrowest set that contains it. A
 * PR-only pipeline always has PR context; a master-only pipeline never claims
 * to. Only a dual-context pipeline runs the same job definition in a context
 * where the variables exist and one where they do not.
 *
 * Scoping this way deliberately leaves `azure-pipelines-npm-publish.yml` out.
 * It builds master only, and it includes a template that posts a
 * `GitHubComment@0` -- so on every publish that task runs with an empty PR
 * number. That is pre-existing, is held harmless by the `continueOnError: true`
 * that `pipeline-pr-comment-steps-guarded.test.ts` already enforces on every
 * such task, and is not this guard's subject. Pulling it in would mean shipping
 * a guard that fails on an unmodified tree, and a guard that is red on arrival
 * gets deleted rather than obeyed.
 */
const dualContextPipelines = pipelineYamlFiles()
    .map((file) => ({ location: file.location, text: readFileSync(file.path, "utf8") }))
    .filter((file) => canRunOnMaster(file.text) && canBuildPullRequests(file.text))
    .map((file) => ({ ...file, jobs: jobsIn(file.text) }));

describe("pull-request jobs cannot run on a master build", () => {
    it("selects the pipelines that build both a pull request and master", () => {
        const selected = dualContextPipelines.map((file) => file.location);
        console.log(`dual-context pipelines: ${selected.join(", ")}`);

        // Floored in both directions. A filter that selects nothing makes every
        // clause below vacuous; one that selects everything makes them loud but
        // wrong, and would drag in master-only pipelines whose PR-context steps
        // are tolerated by design. Naming one file on each side fails whichever
        // way it breaks -- and the excluded name is the one whose inclusion
        // would turn this file red on a tree nobody touched.
        expect(selected, "azure-pipelines.yml is the pipeline this guard exists for; losing it empties every clause below").toContain("azure-pipelines.yml");
        expect(selected, "azure-pipelines-npm-publish.yml builds master only and never a pull request").not.toContain("azure-pipelines-npm-publish.yml");
    });

    it("gates every job that reads pull-request context", () => {
        const prContextJobs = dualContextPipelines.flatMap((file) =>
            file.jobs.filter((job) => PR_CONTEXT_MARKERS.some((marker) => marker.test(job.body))).map((job) => ({ ...job, location: file.location }))
        );

        for (const name of KNOWN_PR_CONTEXT_JOBS) {
            expect(
                prContextJobs.map((job) => job.name),
                `${name} reads pull-request context; if it is no longer detected as such, this clause has stopped watching it rather than been satisfied by it`
            ).toContain(name);
        }

        const ungated = prContextJobs.filter((job) => !job.gated).map((job) => `${job.location} > ${job.name}`);
        expect(
            ungated,
            `these jobs read pull-request context but would still run on a master build, where those variables are empty:\n  ${ungated.join("\n  ")}\n` +
                `Add condition: and(succeeded(), ne(variables['Build.SourceBranch'], 'refs/heads/master')) at the job's own indentation. ` +
                `A condition on one step inside the job does not count -- the job would still start.`
        ).toEqual([]);
    });

    it("reports pull-request context that has no job to gate", () => {
        // A different failure needing the opposite repair, split out because a
        // single diagnostic covering both would send half its readers to fix
        // the wrong thing. A step template has no job of its own, so there is
        // no `condition:` to add -- the gate has to go on the caller, or the
        // step has to leave the template. Population is zero today; the clause
        // costs nothing until that stops being true.
        const ungatable = dualContextPipelines.filter((file) => file.jobs.length === 0 && PR_CONTEXT_MARKERS.some((marker) => marker.test(file.text))).map((file) => file.location);

        expect(
            ungatable,
            `these files read pull-request context but declare no job, so there is nowhere to put a master gate:\n  ${ungatable.join("\n  ")}\n` +
                `Do NOT add a condition here -- gate the job that includes the template, or move the step out of it.`
        ).toEqual([]);
    });

    it("leaves the deterministic jobs ungated so master still validates something", () => {
        const byName = new Map(dualContextPipelines.flatMap((file) => file.jobs).map((job) => [job.name, job]));

        // Named rather than derived, and the asymmetry is deliberate. Clause
        // one derives its subject from content because a new PR-context job
        // must be covered the moment it appears. This clause cannot: "runs on
        // master" is not a property visible in a job's body, it is the absence
        // of a gate, so deriving it would make the clause assert that ungated
        // jobs are ungated. These three names are the post-merge job set, and
        // the list changing is a decision that belongs in a diff.
        for (const name of KNOWN_MASTER_JOBS) {
            expect(byName.has(name), `${name} is one of the jobs master runs after a merge; it has disappeared or been renamed`).toBe(true);
            expect(
                byName.get(name)?.gated,
                `${name} now skips on master. Master then validates less than it did, and a master build that skips every job is green having run nothing -- ` +
                    `which is the state the master trigger was added to end. Remove the condition, or move the job out of the post-merge set deliberately.`
            ).toBe(false);
        }
    });
});
