import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { GITHUB_COMMENT_TASK, matchesAnyLine, pipelineYamlFiles, repoRoot } from "./pipeline-files";

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
 * True when a job body carries either marker.
 *
 * Spelled once, and matched line-by-line, because the two markers are not the
 * same shape: `System.PullRequest.` is a substring that can appear anywhere,
 * while `GITHUB_COMMENT_TASK` is anchored `^...$`. Testing an anchored pattern
 * against a whole job body with a bare `.test()` asks whether the body *is*
 * that line, not whether it *contains* it -- so the second marker matched
 * nothing at all, for the whole life of this file.
 *
 * It went unseen because a disjunction only needs one true disjunct: every job
 * that posts a `GitHubComment@0` here also names
 * `$(System.PullRequest.PullRequestNumber)`, so the live marker covered for the
 * dead one. Deleting the dead marker outright left this file at nine passed.
 * The specimens below are what a per-disjunct control needs and the repository
 * does not contain.
 */
function readsPullRequestContext(text: string): boolean {
    return PR_CONTEXT_MARKERS.some((marker) => matchesAnyLine(marker, text));
}

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
 * Note which marker actually catches them, because an earlier version of this
 * comment claimed the wrong one: it is the `System.PullRequest.` substring in
 * the template's `id:` input, not the `GitHubComment@0` task line. Template
 * resolution is what those two jobs need; the comment marker contributes
 * nothing to them and never did.
 *
 * Resolution follows the chain to its end rather than to a budget. The first
 * version stopped after three hops, on the reasoning that an unbounded walk
 * would hang on a template cycle -- true, but the budget was justified by the
 * repository's *current* nesting rather than by anything the bound entails.
 * Templates nest one deep today, so three looked generous. Measured with a
 * four-hop chain ending in `$(System.PullRequest.PullRequestNumber)` on an
 * ungated job: ten passed. Not a wrong diagnosis, no category change, nothing
 * -- the truncated text simply contains no marker, and the job reads as
 * deterministic.
 *
 * Carrying the visited set removes the budget without reintroducing the hang: a
 * path already on the current chain is not followed again, and the set of
 * readable paths is finite, so the walk terminates. Per-branch rather than
 * global, so two siblings including the same template both resolve it -- a
 * diamond is not a cycle.
 *
 * A cycle therefore stops silently, and that exemption is load-bearing on a
 * fact rather than on a count: ADO rejects a template cycle when it compiles
 * the pipeline, so a cycle cannot reach master through a build that ran. That
 * is the distinction the depth budget failed -- "nothing external prevents
 * this, it just has not happened yet" is not the same claim as "the platform
 * rejects it".
 *
 * `root` is a parameter so the walk can be exercised against a fixture tree.
 * Writing chain fixtures into `config/templates/` would put them inside a
 * directory every other clause scans.
 */
function withTemplatesResolved(text: string, root: string = repoRoot, seen: ReadonlySet<string> = new Set()): string {
    return text.replace(/^\s*-\s*template:\s*(\S+)\s*$/gm, (line, path: string) => {
        if (seen.has(path)) {
            return line;
        }

        let body: string;

        try {
            body = readFileSync(join(root, path), "utf8");
        } catch {
            // A template this guard cannot read is left as its own text.
            //
            // An earlier version of this comment claimed "the markers still see
            // it", which is false comfort dressed as a safety argument: the
            // surviving line is `- template: config/templates/x.yml`, which
            // contains no `System.PullRequest.` and no `GitHubComment@0`, so the
            // markers see *nothing* and the job silently leaves the PR-context
            // set. Measured -- moving `upload-test-report.yml` aside drops
            // `PerfRegression` and `ParityCloud` out of that set entirely.
            //
            // The fallback is therefore not safe on its own, and this is why
            // `resolves every template a dual-context job includes` exists: an
            // unreadable include is caught there, by name, as its own failure
            // rather than as a downstream job that looks like it changed
            // category.
            //
            // Scoped to the read alone, deliberately. Wrapping the recursive
            // call too made this catch absorb the `RangeError` from an
            // unbounded walk, so defeating the cycle guard above produced
            // eleven passed rather than a hang: the overflow unwound to the
            // outermost frame and was reported as an unreadable template. That
            // made the cycle guard untestable and this handler a catch-all
            // wearing a specific comment.
            return line;
        }

        return line + "\n" + withTemplatesResolved(body, root, new Set([...seen, path]));
    });
}

/**
 * The two condition forms that keep a job off a master build, spelled
 * tolerantly.
 *
 * Both must be accepted, and the first version of this guard accepted only the
 * first -- while `azure-pipelines.yml`'s own header comment and `TESTING.md`
 * both instruct you to use the second for a job that cannot function without a
 * PR at all. A job written to follow this repository's documentation was
 * therefore reported as ungated, and the advice attached told the author to
 * replace `startsWith(..., 'refs/pull/')` with `ne(..., 'refs/heads/master')`.
 *
 * Following that is a downgrade, not a lateral move. "Not master" is weaker
 * than "is a pull request": a manually queued build of a feature branch is
 * neither, and `System.PullRequest.*` is just as empty there as it is on
 * master. So the diagnostic argued for a gate that admits a case the author had
 * correctly excluded -- a guard telling someone to loosen the thing the guard
 * exists to enforce, citing documentation that says the opposite.
 *
 * Matching the exact source line would fail on a reformat and pass on a rewrite
 * that changed the branch, so both forms are matched structurally.
 */
const GATE_FORMS = [
    /ne\(\s*variables\[\s*['"]Build\.SourceBranch['"]\s*\]\s*,\s*['"]refs\/heads\/master['"]\s*\)/i,
    /startsWith\(\s*variables\[\s*['"]Build\.SourceBranch['"]\s*\]\s*,\s*['"]refs\/pull\/['"]\s*\)/i,
];

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
 * Jobs deliberately held off master for a reason other than pull-request
 * context -- cost, external flakiness, anything that is a judgement rather than
 * a mechanical requirement.
 *
 * Empty today, and that is a real statement rather than a placeholder: every
 * one of the six gated jobs needs a pull request, so the gated set and the
 * PR-context set coincide exactly. `PerfRegression` and `ParityCloud` are the
 * near misses -- both are excluded from master primarily because BrowserStack
 * is slow and externally flaky -- but both also post a `GitHubComment@0`
 * through `upload-test-report.yml`, so they qualify on mechanism too and do not
 * need to be listed.
 *
 * The list exists so that the first genuinely cost-only gate has to be written
 * down next to its reason, instead of arriving as one more `condition:` that
 * nobody can distinguish from the mechanically required ones.
 */
const COST_GATED_JOBS: string[] = [];

type DocSection = { block: string; starts: number; ends: number };

/**
 * A named region of `TESTING.md`, with each anchor's occurrence count.
 *
 * The counts are returned rather than resolved here because both anchors are
 * `indexOf` -- first match. An earlier version asserted only that the section
 * was *findable*, and that floor is satisfied more easily as the section gets
 * wider, not less. Measured: adding one earlier line containing "Deliberately
 * excluded from" moved `start` backwards over the sentence naming the three
 * jobs master runs, and gating `UnitTests` off master then went from a named
 * failure to silence -- the widened block "documented" it. A floor that a
 * degrading artifact satisfies more easily is not a floor, so the caller
 * asserts uniqueness as well as presence.
 */
function docSection(startAnchor: string, endAnchor: string): DocSection {
    const doc = readFileSync(join(repoRoot, "TESTING.md"), "utf8");
    const starts = doc.split(startAnchor).length - 1;
    const ends = doc.split(endAnchor).length - 1;
    const start = doc.indexOf(startAnchor);
    const end = doc.indexOf(endAnchor, start + 1);
    return { block: start === -1 || end === -1 ? "" : doc.slice(start, end), starts, ends };
}

/** Every job name `TESTING.md` sets in bold inside `section`. */
function boldNamesIn(section: string): string[] {
    return [...section.matchAll(/\*\*([^*]+)\*\*/g)].map((match) => (match[1] ?? "").trim());
}

/**
 * The prose promise `COST_GATED_JOBS` makes, turned into a check.
 *
 * The hatch was added so that gating a job for cost becomes "a reviewed
 * decision rather than a bare condition". Measured immediately afterwards, that
 * was worth exactly nothing: adding a deterministic job, gating it off master
 * and writing its name into the constant takes the file from one failure to
 * seven passed. The job leaves post-merge validation in silence, *through the
 * escape hatch added to make leaving deliberate* -- the repair and the
 * regression in one commit.
 *
 * Every clause that could have seen it is phrased in terms of the hatch, and a
 * hatch reaches all of those by construction. So the binding has to sit
 * somewhere the hatch cannot edit, and `TESTING.md` is that place: it already
 * carries the excluded list with a reason per entry, and no edit to this
 * constant changes a word of it.
 *
 * Deliberately a low bar -- the job's display name has to appear in that one
 * section. It is not a proof that the reason is good. It forces the exclusion
 * into a second file in the same diff, written in prose, where the person
 * reviewing decides. That is all the original comment claimed and more than it
 * delivered.
 */
function deliberatelyExcludedFromMaster(): DocSection {
    return docSection("Deliberately excluded from", "Those jobs are gated");
}

/**
 * The sentence stating which jobs master re-runs after a merge.
 *
 * This exists because `KNOWN_MASTER_JOBS` is hand-maintained and, until now,
 * nothing pinned its *contents* -- only clauses that consumed them. A consumed
 * constant is defeated by editing the constant, and that edit is an absence: a
 * name disappears from a TypeScript array and the diff looks like test
 * bookkeeping. Measured as a chain, each step taking the cheapest repair the
 * previous failure suggests:
 *
 * 1. gate `UnitTests` off master -- two clauses fire;
 * 2. delete `"UnitTests"` from `KNOWN_MASTER_JOBS` -- the named clause goes
 *    quiet;
 * 3. add it to `COST_GATED_JOBS` -- the hatch clause fires;
 * 4. add a bullet to the excluded list -- **eleven passed**.
 *
 * Four edits, a third of post-merge validation gone, every step resolving a
 * real failure, and `TESTING.md` left contradicting itself: the sentence below
 * still said master re-runs Unit Tests while the list above it said Unit Tests
 * was excluded. Nothing read both.
 *
 * Pinning the constant against this sentence makes step 2 a prose edit in a
 * file describing what CI does, rather than a deletion in an array. It does not
 * make the chain impossible -- nothing here can -- it makes the cheapest
 * repair a *statement* about coverage instead of the absence of one.
 */
function postMergeJobsInDoc(): DocSection {
    return docSection("Every push to `master` therefore re-runs", "They run in parallel");
}

/** A job's `displayName`, which is the string `TESTING.md` refers to it by. */
function displayNameOf(job: PipelineJob | undefined): string | undefined {
    return /^\s+displayName:\s*"([^"]+)"\s*$/m.exec(job?.body ?? "")?.[1];
}

/**
 * The template references this guard's marker detection currently rests on.
 *
 * Named rather than counted, for the reason the other floors are: a count drifts
 * and `> 0` is satisfied by one survivor. `PerfRegression` and `ParityCloud`
 * carry no PR-context marker of their own -- their entire claim to being gated
 * for correctness arrives through `upload-test-report.yml` -- so if the
 * reference collector stops finding these paths, the clause below is asserting
 * something about an empty set while passing.
 */
const KNOWN_TEMPLATE_REFERENCES = ["config/templates/upload-test-report.yml", "config/templates/upload-static-site.yml"];

/** Every `- template:` path a resolved body still names, at any depth. */
function templateReferencesIn(text: string): string[] {
    return [...text.matchAll(/^\s*-\s*template:\s*(\S+)\s*$/gm)].map((match) => match[1] ?? "");
}

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

type PipelineJob = { name: string; body: string; gated: boolean; hasOwnCondition: boolean };

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
            gated: ownCondition.some((line) => GATE_FORMS.some((form) => form.test(line))),
            hasOwnCondition: ownCondition.length > 0,
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

        // The negative half is stated as a *derivation*, not as a name that must
        // stay out.
        //
        // `not.toContain("azure-pipelines-npm-publish.yml")` was the earlier
        // form, and it has the failure shape this file has now hit twice: it
        // enforces the conclusion after the reason stops holding. That pipeline
        // is out of subject because it never builds a pull request -- if it ever
        // gains a `pr:` trigger it becomes exactly what this guard is for, and
        // the by-name assertion would greet that correct change by demanding the
        // file be kept out, which means deleting the trigger or special-casing
        // the guard.
        //
        // So the assertion is on the mechanism instead, and the counterfactual
        // below is the half that makes it one: give the real file a pull-request
        // trigger and it enters the subject on its own. An exclusion that cannot
        // be reversed by changing the thing it depends on is a name, whatever
        // the comment beside it says.
        const publish = readFileSync(join(repoRoot, "azure-pipelines-npm-publish.yml"), "utf8");

        expect(
            canBuildPullRequests(publish),
            "azure-pipelines-npm-publish.yml is out of subject because it never builds a pull request; if that changed, the exclusion below is no longer the reason"
        ).toBe(false);
        expect(selected, "azure-pipelines-npm-publish.yml builds master only and never a pull request").not.toContain("azure-pipelines-npm-publish.yml");
        expect(
            canRunOnMaster(publish) && canBuildPullRequests(publish.replace(/^pr:\s*none\s*$/m, "pr:\n  branches:\n    include:\n      - master")),
            "the same file with a pull-request trigger must enter the subject; if it does not, this exclusion is by name rather than by mechanism and a future dual-context publish pipeline goes unguarded"
        ).toBe(true);
    });

    it("gates every job that reads pull-request context", () => {
        const prContextJobs = dualContextPipelines.flatMap((file) =>
            file.jobs.filter((job) => readsPullRequestContext(job.body)).map((job) => ({ ...job, location: file.location }))
        );

        for (const name of KNOWN_PR_CONTEXT_JOBS) {
            expect(
                prContextJobs.map((job) => job.name),
                `${name} reads pull-request context; if it is no longer detected as such, this clause has stopped watching it rather than been satisfied by it`
            ).toContain(name);
        }

        // Split by what the author must actually do, not by what the guard
        // noticed. A job with no `condition:` needs one added; a job that has
        // one needs that one changed. Telling the second author to "add" a
        // condition is not merely unhelpful -- a job takes exactly one
        // `condition:` key, so a literal second one is invalid YAML, and the
        // only way to comply is to guess. This axis is separate from the
        // no-job-to-gate split below, and it was introduced by widening the
        // accepted forms above: once two spellings pass, "absent" and "present
        // but wrong" stop being the same state.
        const missing = prContextJobs.filter((job) => !job.gated && !job.hasOwnCondition).map((job) => `${job.location} > ${job.name}`);
        const ineffective = prContextJobs.filter((job) => !job.gated && job.hasOwnCondition).map((job) => `${job.location} > ${job.name}`);

        expect(
            missing,
            `these jobs read pull-request context and carry no job-level condition, so they run on a master build where those variables are empty:\n  ${missing.join("\n  ")}\n` +
                `Add one of:\n` +
                `  condition: and(succeeded(), ne(variables['Build.SourceBranch'], 'refs/heads/master'))\n` +
                `  condition: and(succeeded(), startsWith(variables['Build.SourceBranch'], 'refs/pull/'))\n` +
                `at the job's own indentation -- the second if the job cannot function without a pull request at all. ` +
                `A condition on one step inside the job does not count; the job would still start.`
        ).toEqual([]);

        expect(
            ineffective,
            `these jobs read pull-request context and DO carry a job-level condition, but it does not keep them off master:\n  ${ineffective.join("\n  ")}\n` +
                `Do NOT add a second condition -- a job accepts only one. Widen the existing one, keeping its current clauses, ` +
                `so that it also excludes master: ne(variables['Build.SourceBranch'], 'refs/heads/master') or ` +
                `startsWith(variables['Build.SourceBranch'], 'refs/pull/').`
        ).toEqual([]);
    });

    it("reports pull-request context that has no job to gate", () => {
        // A different failure needing the opposite repair, split out because a
        // single diagnostic covering both would send half its readers to fix
        // the wrong thing. A step template has no job of its own, so there is
        // no `condition:` to add -- the gate has to go on the caller, or the
        // step has to leave the template. Population is zero today; the clause
        // costs nothing until that stops being true.
        const ungatable = dualContextPipelines.filter((file) => file.jobs.length === 0 && readsPullRequestContext(file.text)).map((file) => file.location);

        expect(
            ungatable,
            `these files read pull-request context but declare no job, so there is nowhere to put a master gate:\n  ${ungatable.join("\n  ")}\n` +
                `Do NOT add a condition here -- gate the job that includes the template, or move the step out of it.`
        ).toEqual([]);
    });

    it("follows a template chain to its end rather than to a budget", () => {
        // Exercised against a fixture tree because the separating case is a
        // chain deeper than the repository has: templates nest one level here,
        // so every depth budget above one is indistinguishable from no budget
        // on this tree. That is what hid the old bound -- its adequacy was a
        // property of today's pipelines, not of the number.
        //
        // The chain is five hops with the marker only at the leaf, so a walk
        // that stops early returns text containing no marker at all. That is
        // the failure mode worth pinning: not a wrong answer, an absent one.
        const dir = mkdtempSync(join(tmpdir(), "tpl-chain-"));

        try {
            const hops = ["a", "b", "c", "d"];
            hops.forEach((hop, index) => writeFileSync(join(dir, `${hop}.yml`), `steps:\n    - template: ${hops[index + 1] ?? "leaf"}.yml\n`));
            writeFileSync(join(dir, "leaf.yml"), 'steps:\n    - script: echo "$(System.PullRequest.PullRequestNumber)"\n');

            expect(
                readsPullRequestContext(withTemplatesResolved("steps:\n    - template: a.yml\n", dir)),
                `pull-request context ${hops.length + 1} template hops down was not found. Template resolution is stopping short, and a job whose only PR context ` +
                    `arrives through a chain that long reads as deterministic -- so this guard would report it as safe to run on master, silently.`
            ).toBe(true);

            // A cycle must terminate by being recognised, not by exhausting the
            // stack. ADO rejects one at compile time so it cannot reach a real
            // build -- but the assertion has to be able to tell the two exits
            // apart, or it passes under both. Recognised, the line expands once
            // and stops, leaving two mentions; overflowing, nothing expands at
            // all and one mention survives.
            writeFileSync(join(dir, "loop.yml"), "steps:\n    - template: loop.yml\n");
            const cycle = withTemplatesResolved("steps:\n    - template: loop.yml\n", dir);

            expect(
                cycle.split("loop.yml").length - 1,
                "a template cycle must stop because the walk recognises it, not because the stack ran out. " +
                    "One mention means nothing expanded, which is what an absorbed overflow looks like -- and an overflow is not a guarantee, it is a resource limit."
            ).toBe(2);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("classifies each pull-request marker on its own", () => {
        // A negative per *predicate*, not per assertion -- and the predicate
        // count here is two, taken from the logic rather than from the name.
        // `readsPullRequestContext` reads as one thing and is a disjunction, so
        // every control that mutated it whole was measuring whichever disjunct
        // happened to be stronger on this repository. That was always the same
        // one: no job in the tree posts a `GitHubComment@0` without also naming
        // `$(System.PullRequest.PullRequestNumber)`, so the marker meant to
        // catch the ones that don't was free to be broken, and was.
        //
        // These are specimens rather than fixture pipelines because the file
        // that would separate the disjuncts is one the repository has no reason
        // to contain -- a job that comments on a pull request while leaving the
        // task's `id` to default. Adding it to the tree to satisfy a test would
        // be inventing a job to be tested about.
        const specimens = [
            {
                what: "a task line with the id left to default, which is the case the second marker exists for",
                body: '          - job: Snapshot\n            steps:\n                - task: GitHubComment@0\n                  inputs:\n                      comment: "hi"\n',
                marker: "comment task",
            },
            {
                what: "a variable read with no comment task anywhere",
                body: '          - job: Snapshot\n            steps:\n                - script: echo "$(System.PullRequest.PullRequestNumber)"\n',
                marker: "variable",
            },
        ];

        for (const specimen of specimens) {
            expect(
                readsPullRequestContext(specimen.body),
                `a job body carrying only the ${specimen.marker} marker -- ${specimen.what} -- is not being recognised as pull-request context.\n` +
                    `It would be reported as a job master can safely run, and on a master build the thing it depends on is empty. ` +
                    `Each marker has to hold up alone: the other one covering for it in today's tree is what let this one stay broken.`
            ).toBe(true);
        }

        // The disjunction is only meaningful if a body carrying neither is
        // rejected -- without this the clause above passes on a predicate hard-
        // wired to true.
        expect(
            readsPullRequestContext("          - job: Docs\n            steps:\n                - script: pnpm run docs\n"),
            "a job that reads no pull-request context at all is being classified as if it did, which would gate the deterministic jobs off master one by one"
        ).toBe(false);
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

    it("distinguishes a pull-request-only pipeline from a dual-context one", () => {
        // The subject is a conjunction -- runs on master AND builds pull
        // requests -- and the repository supplies a negative for only one half
        // of it. Every pipeline here that builds pull requests also builds
        // master, so `canBuildPullRequests` alone reproduces the subject exactly
        // and `canRunOnMaster` is along for the ride.
        //
        // Measured: defeating `canRunOnMaster` to a constant `true` leaves the
        // whole file green at 6 passed, while defeating `canBuildPullRequests`
        // the same way fires four clauses. One conjunct is load-bearing and
        // untested, with no visible gap -- an exact assertion over a conjunction
        // is satisfied by whichever conjunct is stronger on the available
        // specimens.
        //
        // The specimens are written here rather than added to the repository as
        // real pipelines, because the missing negative is a *file this repo does
        // not contain*: a pipeline that builds pull requests and never builds
        // master. Adding one to make a guard testable would be inventing
        // infrastructure to satisfy a test.
        //
        // It is not hypothetical. A PR-only pipeline is an ordinary thing to add
        // -- a cheap lint pass that has no reason to run post-merge -- and if
        // `canRunOnMaster` ever answers `true` for it, every clause here starts
        // demanding master gates on a pipeline that cannot build master. Guards
        // that demand pointless changes on a correct tree get deleted.
        const specimens = [
            {
                what: "dual-context: master trigger and a pr trigger",
                text: "trigger:\n  branches:\n    include:\n      - master\n\npr:\n  branches:\n    include:\n      - master\n",
                master: true,
                pullRequest: true,
            },
            { what: "pull-request only: explicitly no CI trigger", text: "trigger: none\n\npr:\n  branches:\n    include:\n      - master\n", master: false, pullRequest: true },
            {
                what: "pull-request only: CI trigger names other branches",
                text: "trigger:\n  branches:\n    include:\n      - release/*\n\npr:\n  branches:\n    include:\n      - master\n",
                master: false,
                pullRequest: true,
            },
            { what: "master only: pr trigger explicitly disabled", text: "trigger:\n  branches:\n    include:\n      - master\n\npr: none\n", master: true, pullRequest: false },
            { what: "master only: no pr trigger at all", text: "trigger:\n  branches:\n    include:\n      - master\n", master: true, pullRequest: false },
        ];

        for (const specimen of specimens) {
            expect(canRunOnMaster(specimen.text), `${specimen.what}: canRunOnMaster should be ${specimen.master}`).toBe(specimen.master);
            expect(canBuildPullRequests(specimen.text), `${specimen.what}: canBuildPullRequests should be ${specimen.pullRequest}`).toBe(specimen.pullRequest);
        }
    });

    it("resolves every template a dual-context job includes", () => {
        // A floor on the transform rather than on its output.
        //
        // Every other clause reads markers out of a *resolved* job body, which
        // makes template resolution a silent dependency of all of them. When it
        // stops contributing -- a template renamed, moved, or its path
        // retyped -- the include does not vanish loudly; the job simply stops
        // carrying the evidence, and the loss surfaces downstream as a job that
        // appears to have changed category.
        //
        // Measured, and this is why the clause is here rather than in a comment:
        // moving `upload-test-report.yml` aside while adding a gated job whose
        // only pull-request context comes through it produces exactly one
        // actionable failure, "this job is gated but needs no PR", whose remedy
        // is to record it in COST_GATED_JOBS. Following that advice is not a
        // near miss -- it permanently certifies a job the guard has gone blind
        // to, and every clause is green afterwards.
        //
        // An unreadable include is unambiguous in a way that "this template
        // still posts a comment" would not be: ADO fails the pipeline on it too,
        // so this floor cannot fire on a tree that is otherwise correct. A floor
        // asserting the template still *carries markers* would fire the day
        // someone legitimately stops posting a comment, and a guard that is red
        // on a correct tree gets deleted rather than fixed.
        const referenced = dualContextPipelines.flatMap((file) => file.jobs.flatMap((job) => templateReferencesIn(job.body)));

        // The floor's own failure has two causes needing opposite repairs, and
        // the partition between them is a property of the input rather than of
        // what this check distinguishes: either the collector produced nothing
        // at all, or it produced references and this particular one is not among
        // them. Total by construction, so it cannot grow a third branch.
        //
        // One sentence covering both -- which is what this message was -- leaves
        // whoever hits it with a diagnosis and no action, and the two actions are
        // not variations of each other: one edits this constant, the other says
        // the constant is fine and the code above it is broken.
        for (const path of KNOWN_TEMPLATE_REFERENCES) {
            expect(
                referenced,
                referenced.length === 0
                    ? `no dual-context job references any template at all, so this clause is checking an empty set and the readability floor below it cannot fail.\n` +
                          `The reference collector or the job splitter has stopped producing references. Fix that rather than editing KNOWN_TEMPLATE_REFERENCES -- the constant is not what broke, and shortening it here would hide the collector's failure permanently.`
                    : `templates are still being collected (${[...new Set(referenced)].join(", ")}), but no dual-context job references ${path} any more.\n` +
                          `If that include was deliberately removed, drop ${path} from KNOWN_TEMPLATE_REFERENCES -- the constant exists to make the removal visible, not to prevent it.\n` +
                          `Then check the jobs that relied on it: pull-request context reaching them through that template is now gone, so a gate justified by it may no longer be justified at all.`
            ).toContain(path);
        }

        const missing = [...new Set(referenced)].filter((path) => !existsSync(join(repoRoot, path)));

        expect(
            missing,
            `a dual-context job includes a template that cannot be read: ${missing.join(", ")}.\n` +
                `Pull-request context reaches jobs through templates, so an include this guard cannot resolve is context it cannot see -- ` +
                `the job then looks like it needs no pull request, and the advice attached to that failure is to record it as cost-gated, which would make the blindness permanent. ` +
                `Fix the path, or if the template is genuinely gone, remove the include from the job.`
        ).toEqual([]);
    });

    it("pins the post-merge job set to the sentence documenting it", () => {
        const { block, starts, ends } = postMergeJobsInDoc();

        expect(
            starts,
            `"Every push to \`master\` therefore re-runs" appears ${starts} times in TESTING.md; the slice takes the first, so a second one re-points it silently.`
        ).toBe(1);
        expect(ends, `"They run in parallel" appears ${ends} times in TESTING.md, so the sentence's end is whichever comes first.`).toBe(1);

        // The floor, and it is deliberately taken from the pipeline rather than
        // from either thing being compared. The two assertions below are
        // *equalities*, and equalities are satisfied by both sides being empty
        // -- measured: emptying `KNOWN_MASTER_JOBS` and rewriting the sentence
        // to name nobody is two edits in two files, passes the one-edit test,
        // and left twelve clauses green with the post-merge job set gone
        // entirely. Every clause about that set had become vacuously true at
        // once, including this one.
        //
        // The set of ungated jobs is the only side of the correspondence that
        // is not somebody's assertion: a constant is edited in a diff and prose
        // is written by hand, but a job stops appearing here only when it
        // genuinely stops running on master. So it is what the floor is taken
        // from, and it makes the empty case cost what it should -- gating every
        // job off master, which is the state the trigger was added to end.
        const ungated = dualContextPipelines.flatMap((file) => file.jobs).filter((job) => !job.gated);
        const ungatedLabels = ungated.map((job) => displayNameOf(job)).filter((label): label is string => label !== undefined);

        expect(
            ungatedLabels.length,
            `every job in the dual-context pipeline is gated off master, so a master build runs nothing and is green for it. ` +
                `That is precisely the gap this pipeline's master trigger exists to close.`
        ).toBeGreaterThan(0);

        const byName = new Map(dualContextPipelines.flatMap((file) => file.jobs).map((job) => [job.name, job]));
        const expected = KNOWN_MASTER_JOBS.map((name) => displayNameOf(byName.get(name))).filter((label): label is string => label !== undefined);

        expect(
            boldNamesIn(block).sort(),
            `TESTING.md says master re-runs ${boldNamesIn(block).join(", ") || "(nobody)"}, but the pipeline leaves ${ungatedLabels.join(", ")} ungated.\n` +
                `These have to move together. If a job is genuinely leaving post-merge validation, say so here in the same diff -- that sentence is what a reader ` +
                `checks, and a name quietly leaving a TypeScript array is not a statement anybody reviews.`
        ).toEqual([...ungatedLabels].sort());

        expect([...expected].sort(), `KNOWN_MASTER_JOBS resolves to ${expected.join(", ") || "(nobody)"}, but the pipeline leaves ${ungatedLabels.join(", ")} ungated.`).toEqual(
            [...ungatedLabels].sort()
        );

        // Constant-free on purpose. The assertions above read
        // KNOWN_MASTER_JOBS or the pipeline, so a mutation reaching those moves
        // them together; this one compares TESTING.md against itself and cannot
        // be reached from any constant in this file. It is what catches the end
        // state of the four-edit chain, where the document claimed a job was
        // both re-run on every push and deliberately excluded.
        const alsoExcluded = boldNamesIn(block).filter((name) => deliberatelyExcludedFromMaster().block.includes(name));

        expect(
            alsoExcluded,
            `TESTING.md says master re-runs ${alsoExcluded.join(", ")} and also lists it as deliberately excluded from master. Both cannot be true.\n` +
                `Whichever is stale, the other one is what somebody will read when deciding whether post-merge validation still covers this.`
        ).toEqual([]);
    });

    it("locates TESTING.md's excluded-jobs section unambiguously", () => {
        // Split off from the clause below because the two answer different
        // questions -- "can this check see anything" versus "is this particular
        // gate justified" -- and a control that can only name which *test* fired
        // cannot tell those apart while they share one. The failures below are
        // about the section itself, so they belong to the section.
        const { block, starts, ends } = deliberatelyExcludedFromMaster();

        expect(
            starts,
            `"Deliberately excluded from" appears ${starts} times in TESTING.md. The section is sliced from the *first* match, so a second one silently re-points ` +
                `it -- and it widens rather than empties, which no floor below can see. Reword the other mention, or move this anchor to something that stays unique.`
        ).toBe(1);
        expect(ends, `"Those jobs are gated" appears ${ends} times in TESTING.md, so the section's end is whichever comes first. Same failure as the start anchor, same fix.`).toBe(
            1
        );

        expect(
            block,
            "TESTING.md's 'Deliberately excluded from master' section could not be located, so this check would accept any cost gate at all. " +
                "Its anchors moved -- re-point them here rather than removing this check, which is the only one a COST_GATED_JOBS entry cannot silence."
        ).toContain("Bundle Size");

        // The width check, and the only assertion here that gets *harder* to
        // satisfy as the section grows. Presence floors all get easier, which is
        // how the backwards-widening above survived one. A job cannot be both
        // "master runs this after every merge" and "master deliberately stopped
        // running this", so finding a post-merge job named in the excluded list
        // means either the two statements really do contradict each other or the
        // slice has swallowed prose that is not the list -- and the sentence
        // immediately above the list happens to name all three.
        const byName = new Map(dualContextPipelines.flatMap((file) => file.jobs).map((job) => [job.name, job]));
        const contradictory = KNOWN_MASTER_JOBS.map((name) => displayNameOf(byName.get(name))).filter((label): label is string => label !== undefined && block.includes(label));

        expect(
            contradictory,
            `TESTING.md's excluded-from-master list names ${contradictory.join(", ")}, which KNOWN_MASTER_JOBS says master still runs.\n` +
                `Either the section really has grown to contradict itself, or -- far likelier -- its anchors have drifted and the slice now covers surrounding prose. ` +
                `Check the anchors first: a section that is too wide accepts every cost gate silently, which is the one failure the presence check above cannot report.`
        ).toEqual([]);
    });

    it("makes a cost gate argue for itself where the hatch cannot reach", () => {
        // This clause never consults COST_GATED_JOBS to decide whether something
        // is acceptable -- it consults it only to find what must be justified,
        // and reads the justification from a file the constant cannot edit. That
        // asymmetry is the whole point: a hatch silences every clause phrased in
        // terms of it, so the one clause that binds has to be phrased outside.
        const { block } = deliberatelyExcludedFromMaster();
        const jobsByName = new Map(dualContextPipelines.flatMap((file) => file.jobs).map((job) => [job.name, job]));
        const undocumented = COST_GATED_JOBS.filter((name) => {
            const label = displayNameOf(jobsByName.get(name));
            return label === undefined || !block.includes(label);
        });

        expect(
            undocumented,
            `these jobs are recorded in COST_GATED_JOBS but nothing in TESTING.md says master stopped validating them: ${undocumented.join(", ")}.\n` +
                `Add each one's displayName, exactly as the pipeline spells it, to the "Deliberately excluded from master" list with the reason it is too slow or too flaky to run post-merge. ` +
                `A job can leave post-merge validation -- it just cannot leave quietly, and this constant on its own is quiet.`
        ).toEqual([]);
    });

    it("keeps the gated set and the pull-request set identical", () => {
        // The named list above catches a post-merge job being removed. It is
        // structurally blind to the opposite motion: a *new* job that arrives
        // already gated is simply not in the list, so master quietly validates
        // less and every existing check stays green. Measured -- deriving that
        // list instead, then deleting the Lint job outright, removes 102 lines
        // of master validation and passes 4/4.
        //
        // Neither direction subsumes the other, so this clause states the
        // invariant the two sets actually satisfy today: a job is gated **if
        // and only if** it needs a pull request. That is checkable without
        // naming anything, which is what lets it cover jobs that do not exist
        // yet -- and it is a genuine claim about this pipeline rather than a
        // restatement, because "gated" and "needs a PR" are independently
        // derived, one from a condition and one from job content.
        const jobs = dualContextPipelines.flatMap((file) => file.jobs);
        const gated = jobs
            .filter((job) => job.gated)
            .map((job) => job.name)
            .sort();
        const expected = [...new Set([...jobs.filter((job) => readsPullRequestContext(job.body)).map((job) => job.name), ...COST_GATED_JOBS])].sort();

        // Two different failures reach this assertion, and they need opposite
        // repairs. A job may be gated because someone decided it was too slow --
        // real, and COST_GATED_JOBS is where that decision gets written down. Or
        // the job may need a pull request exactly as before, and this guard has
        // merely stopped seeing it, in which case recording it as cost-gated
        // certifies the blindness instead of fixing it.
        //
        // The axis that separates them is whether the job's evidence could have
        // arrived through an include, so the remedy is split on that rather than
        // on which one seems more likely. Splitting on the input's structure is
        // what makes it exhaustive: a job either has a `- template:` or it does
        // not.
        const unexplained = gated.filter((name) => !expected.includes(name));
        const viaTemplate = unexplained.filter((name) => templateReferencesIn(jobs.find((job) => job.name === name)?.body ?? "").length > 0);

        expect(
            gated,
            `the set of jobs held off master and the set that needs a pull request have diverged.\n` +
                `  gated:      ${gated.join(", ")}\n` +
                `  expected:   ${expected.join(", ")}\n` +
                (viaTemplate.length > 0
                    ? `${viaTemplate.join(", ")} include a template, so the missing evidence may be the include rather than the job -- check that clause first; ` +
                      `recording a job as cost-gated while its template silently stops resolving is how this guard goes blind to it permanently.\n`
                    : "") +
                `A job gated without needing a pull request shrinks post-merge validation, which is a decision rather than a detail. ` +
                `If it is deliberate -- gating something purely because it is slow or flaky -- add it to COST_GATED_JOBS with the reason, ` +
                `so the next reader meets an argument instead of a bare condition. A job that needs a pull request and has no gate is the other clause's failure, not this one's.`
        ).toEqual(expected);
    });
});
