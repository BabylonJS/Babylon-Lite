import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { GITHUB_COMMENT_TASK, SHELL_STEP_KEY, isYamlFile, matchesAnyLine, pipelineYamlFiles, repoRoot } from "./pipeline-files";

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
/**
 * Comment-only lines, which a pipeline never executes.
 *
 * Measured: add `# System.PullRequest.PullRequestNumber is unavailable here` to
 * the `Lint & Type Check` job and two clauses fire, demanding a job be gated
 * off master because of a sentence explaining that it isn't. The advice
 * attached to that failure argues for shrinking post-merge validation, which is
 * the direction this whole file exists to resist -- and the pipeline header
 * discusses `System.PullRequest.*` at length precisely because it is worth
 * explaining, so the tree invites the mistake.
 *
 * Only whole-line comments are removed. A `#` inside a value can be quoted
 * data, and cutting at it would be a second hand-rolled YAML rule with no
 * parser to check it against.
 */
function stripCommentLines(text: string): string {
    return text
        .split("\n")
        .filter((line) => !/^\s*#/.test(line))
        .join("\n");
}

/**
 * Whether a job depends on something only a pull-request build supplies.
 *
 * Reads the job's substance, not its commentary -- but where that line falls
 * depends on the question being asked, so this is deliberately not the same
 * exclusion the cost floor makes. `condition:` is commentary about *what a step
 * runs*; it is substance here, because
 * `ne(variables['System.PullRequest.PullRequestNumber'], '')` is the most
 * explicit form the dependency takes and dropping conditions would blind this
 * to it. `displayName` is kept for the same reason at lower stakes: ADO expands
 * macros in it.
 */
function readsPullRequestContext(text: string): boolean {
    return PR_CONTEXT_MARKERS.some((marker) => matchesAnyLine(marker, stripCommentLines(text)));
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
 * Whether a `condition:` line keeps its job off a master build.
 *
 * Factored out of {@link jobsIn} so the boundary table below controls the same
 * expression the pipeline is judged by. Spelling `GATE_FORMS.some(...)` twice
 * would let the table certify one copy while the other widened -- the two-lists
 * failure {@link SHELL_STEP_KEYS} exists to prevent, and the reason this file
 * already imports that constant instead of rewriting it.
 */
function acceptedAsGate(line: string): boolean {
    return GATE_FORMS.some((form) => form.test(line));
}

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
 * somewhere the hatch cannot edit, and `TESTING.md` is that place: it carries
 * the excluded list with a reason per entry, and no edit to this constant
 * changes a word of it.
 *
 * On how much that is worth, measured rather than assumed. The four anchors this
 * binding reads appear **zero** times in `origin/master:TESTING.md` -- the whole
 * post-merge section is this PR's deliverable. They arrived in commit 1
 * (`f57a9b22`); this binding arrived in commit 41 (`3e830a06`). So it is not
 * independent testimony: same author, same pull request. What it does buy is
 * that the section was written to describe the change, not to satisfy a test
 * that did not exist yet for another forty commits, and that the exclusion has
 * to be argued in prose in the same diff where a reviewer will read it.
 *
 * Deliberately a low bar -- the job has to be named in that section's list, by
 * its `displayName` or a declared alias. It is not a proof that the reason is
 * good. It forces the exclusion into a second file in the same diff, written in
 * prose, where the person reviewing decides. That is all the original comment
 * claimed and more than it delivered.
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

/** A job's `displayName` in the pipeline. See `DOC_NAME_ALIASES` before assuming `TESTING.md` uses the same string. */
function displayNameOf(job: PipelineJob | undefined): string | undefined {
    return /^\s+displayName:\s*"([^"]+)"\s*$/m.exec(job?.body ?? "")?.[1];
}

/**
 * The two jobs `TESTING.md` calls something other than their `displayName`.
 *
 * This existed from this PR's first commit and was invisible because the grant
 * it feeds is evaluated zero times while `COST_GATED_JOBS` is empty. Measured by
 * putting a job into that constant, the binding was wrong in *both* directions
 * at once:
 *
 *   PerfRegression cost-gated  ->  "nothing in TESTING.md says master stopped
 *                                  validating them", while the section plainly
 *                                  says "**Perf Regression** (~53 min)"
 *
 * -- a grant the document really makes, unreadable, for exactly the two jobs
 * most likely to ever be cost-gated. And the other way, because the old test was
 * `block.includes(label)` over the whole section rather than over its list:
 *
 *   a sentence reading "Unlike **Bundle Size**, which master still runs on
 *   every push, the jobs below are skipped" GRANTED Bundle Size its exclusion
 *
 * -- prose denying the exclusion satisfying the check for it. Containment over a
 * region cannot tell a list entry from a sentence about one, so the fix is an
 * identity over parsed bullets, and the two name spaces have to be reconciled
 * explicitly rather than by hoping they coincide.
 *
 * Kept as an alias rather than renamed in either artifact: the display names are
 * what Azure DevOps shows in its UI, the doc names are what a person writing
 * about CI reaches for, and neither is wrong for its own audience.
 */
const DOC_NAME_ALIASES: Record<string, string> = {
    "Perf Regression": "Performance: Lite vs Stable",
    "Parity Cloud": "Parity Tests (Cloud Browser)",
};

/**
 * The display names `TESTING.md` lists as deliberately excluded from `master`.
 *
 * Bullets only. A name mentioned in the section's surrounding prose is not a
 * grant, which is the whole distinction the old containment test could not draw.
 */
function excludedJobLabels(): string[] {
    const bullets = deliberatelyExcludedFromMaster()
        .block.split("\n")
        .filter((line) => /^\s*[-*]\s/.test(line));
    return boldNamesIn(bullets.join("\n")).map((name) => DOC_NAME_ALIASES[name] ?? name);
}

/**
 * The template references this guard's marker detection rests on, read off disk
 * rather than listed here.
 *
 * Named rather than counted, for the reason the other floors are: a count drifts
 * and `> 0` is satisfied by one survivor. `PerfRegression` and `ParityCloud`
 * carry no PR-context marker of their own -- their entire claim to being gated
 * for correctness arrives through `upload-test-report.yml` -- so if the
 * reference collector stops finding these paths, the clause below is asserting
 * something about an empty set while passing.
 *
 * That paragraph was true of an authored list, and the list was the defect it
 * described. Measured: replacing it with `[]` left this file at **15 passed**.
 * The loop below iterates it, so emptying it asks nothing -- the guard written
 * to stop a vacuous assertion was the assertion that could be made vacuous, and
 * the comment arguing for it kept reading as a reason to trust it.
 *
 * `config/templates/` is not an assertion. No edit to this file removes a
 * template from it, and the failure the clause exists for -- a template that
 * stops being reachable while still sitting on disk -- is precisely the state
 * a directory listing still reports and a shortened list would not.
 *
 * `isYamlFile` here is measured and left uncovered *by this file*, deliberately.
 * Replacing it with `() => true` leaves all fifteen clauses green -- but only
 * because `config/templates/` holds nothing but `.yml`, so no input separates
 * the two. The predicate itself is pinned by a table in
 * `pipeline-piped-steps-set-pipefail.test.ts`, and the only way to give this
 * call site an arm of its own is to drop a non-YAML file into the directory,
 * which is adding a file to the tree to be tested about. Recorded rather than
 * faked: dead by the tree's shape, not by type -- and live the moment the
 * directory stops being homogeneous.
 */
function templateFilesOnDisk(): string[] {
    return readdirSync(join(repoRoot, "config", "templates"))
        .filter(isYamlFile)
        .map((name) => `config/templates/${name}`)
        .sort();
}

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

/**
 * True when a pipeline builds both master and pull requests.
 *
 * Named rather than written inline in the filter below, and that is the whole
 * reason it exists: as an inline conjunction, deleting `canRunOnMaster` from it
 * left all thirteen clauses green, and no test could reach the selection to say
 * otherwise -- a counterfactual written against the two predicates still passes,
 * because the predicates are not what the mutation edits. A conjunction that
 * nothing can call is a conjunction nothing can control.
 */
function isDualContext(text: string): boolean {
    return canRunOnMaster(text) && canBuildPullRequests(text);
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
/**
 * The column a line's content starts at. For a sequence item the mapping's
 * keys begin *after* the dash, so `- name: NODE_VERSION` and the `value:`
 * beneath it are siblings rather than parent and child. Measuring the dash
 * instead reported all nine real pipelines as malformed on the first attempt.
 */
function contentColumn(line: string): number {
    const indent = line.length - line.trimStart().length;
    const dash = /^-\s+/.exec(line.slice(indent));
    return indent + (dash ? dash[0].length : 0);
}

/**
 * Lines that cannot be YAML, found without a YAML parser.
 *
 * Everything else in this file reads the pipeline as *text* -- `jobsIn` is a
 * line regex, `readsPullRequestContext` is a substring scan. That is fine for
 * what they ask, but it means well-formedness is not a property any of them can
 * see, and a file that Azure DevOps would reject outright reads as a perfectly
 * good pipeline with perfectly correct gating.
 *
 * Measured, and it is worse than an unchecked assumption: inserting a
 * `condition:` two columns too deep under `- job: UnitTests` produces a file
 * PyYAML refuses at line 277, and this suite reported **twelve passed**.
 * `jobsIn` derives its key indent from the job line and simply found no
 * condition there, so the job read as ungated -- the malformed file and a
 * correct one are indistinguishable to every clause here.
 *
 * That matters twice over. For the repository it is bounded by the platform,
 * since ADO rejects malformed YAML before running anything. For the *probes*
 * that mutate this file it is not bounded at all: a mutation that corrupts the
 * pipeline reports green, which reads exactly like "the guard is blind to this"
 * and would be recorded as a finding. A guard's own floors are the tripwire for
 * the harness measuring it, and this file had none.
 *
 * The invariant is narrow on purpose, and its exact shape came from a parser
 * rather than from me. The first version said "a key that already has a scalar
 * value cannot have a more-indented line after it, because there is nothing for
 * that line to belong to". That reasoning is wrong, and PyYAML says so:
 *
 *     value: "22.x" + deeper `c: 1`     REJECTS
 *     value: "22.x" + deeper `more`     REJECTS
 *     name: NODE_VERSION + deeper `c: 1`  REJECTS
 *     name: NODE_VERSION + deeper `more`  ACCEPTS -> "NODE_VERSION more"
 *
 * A *plain* scalar legally continues onto deeper lines; a *quoted* one cannot.
 * And the line that ends the continuation is not "starts with a key" but
 * "contains a mapping colon": `echo two: three` and a trailing `echo two:` are
 * both refused, while `echo two:three`, `http://x/y` and a deeper `- x` all fold
 * into the value as text.
 *
 * Three more shapes were found only by enumerating candidates for the *legal*
 * direction, because every specimen written first was a corruption. All are
 * accepted, and the first two versions of this predicate called them broken:
 *
 *     script: # note   + deeper `c: 1`   ACCEPTS -> script is the mapping {c: 1}
 *     script: {a: 1,   + deeper `b: 2}`  ACCEPTS -> a flow collection may span lines
 *     script: "x       + deeper `y"`     ACCEPTS -> so may a quoted scalar
 *
 * A value that is only a comment is not a value at all -- the key is empty and
 * deeper lines legally belong to it. An unterminated quote or an unbalanced
 * flow collection is a value still being written, and the deeper line finishes
 * it. So the flag is raised only for a value that is *self-contained*: nothing
 * about it can be continued, therefore nothing deeper can belong to it.
 *
 * Being wrong in this direction is the expensive one. A guard that fires on
 * correct code gets deleted, so an unrecognised shape is skipped rather than
 * reported, and every branch below is pinned by a specimen carrying an actual
 * parser verdict.
 *
 * So this reports two different things, because they need two different
 * remedies. `illegal` is a file Azure DevOps will refuse. `folded` is legal YAML
 * that silently swallows the deeper line into the value above -- not a parse
 * error, but almost never what someone writing a pipeline step meant, and
 * invisible in review precisely because it parses.
 *
 * It is still not a YAML validator and does not try to be; adding a parser
 * dependency to satisfy a test would be inventing infrastructure to be tested
 * about, and no YAML parser is resolvable from this project in any case. Block
 * scalars (`|`, `>`) are skipped, as their bodies are legitimately deeper.
 */
const MAPPING_COLON = /:(?:\s|$)/;
const CLOSED_DOUBLE_QUOTE = /^"(?:[^"\\]|\\.)*"/;
const CLOSED_SINGLE_QUOTE = /^'(?:[^']|'')*'(?!')/;

/**
 * Whether a flow collection opened in `value` is also closed in it. Quoted
 * spans are stepped over so a brace inside a string does not count, and an
 * unquoted `#` at depth zero starts a comment.
 */
function flowIsClosed(value: string): boolean {
    let depth = 0;
    let quote = "";

    for (let index = 0; index < value.length; index++) {
        const character = value[index] ?? "";
        if (quote) {
            if (character === "\\" && quote === '"') index++;
            else if (character === quote) quote = "";
            continue;
        }
        if (character === '"' || character === "'") quote = character;
        else if (character === "{" || character === "[") depth++;
        else if (character === "}" || character === "]") depth--;
        else if (character === "#" && depth === 0) break;
    }

    return depth === 0;
}

type ValueShape = "block" | "empty" | "continuable" | "self-contained" | "plain";

function valueShape(value: string): ValueShape {
    if (value.startsWith("|") || value.startsWith(">")) return "block";
    if (value.startsWith("#")) return "empty";
    if (value.startsWith('"')) return CLOSED_DOUBLE_QUOTE.test(value) ? "self-contained" : "continuable";
    if (value.startsWith("'")) return CLOSED_SINGLE_QUOTE.test(value) ? "self-contained" : "continuable";
    if (value.startsWith("{") || value.startsWith("[")) return flowIsClosed(value) ? "self-contained" : "continuable";
    return "plain";
}

function structureProblems(text: string): { illegal: string[]; folded: string[] } {
    const lines = text.split("\n");
    const illegal: string[] = [];
    const folded: string[] = [];

    for (let index = 0; index < lines.length; index++) {
        const line = lines[index] ?? "";
        if (!line.trim() || line.trim().startsWith("#")) continue;

        const scalar = /^(?:-\s+)?[A-Za-z_$][\w.$-]*:[ \t]+(\S.*)$/.exec(line.trimStart());
        if (!scalar) continue;

        const shape = valueShape((scalar[1] ?? "").trim());
        if (shape === "block" || shape === "empty" || shape === "continuable") continue;

        let next = index + 1;
        while (next < lines.length && (!(lines[next] ?? "").trim() || (lines[next] ?? "").trim().startsWith("#"))) next++;
        if (next >= lines.length) continue;

        if (contentColumn(lines[next] ?? "") <= contentColumn(line)) continue;

        const where = `line ${next + 1} is indented deeper than line ${index + 1} ("${line.trim().slice(0, 44)}"), which already has a value`;

        if (shape === "self-contained" || MAPPING_COLON.test((lines[next] ?? "").trim())) illegal.push(where);
        else folded.push(`${where}, and is legal YAML that folds into it`);
    }

    return { illegal, folded };
}

/**
 * The work a job actually runs, as opposed to the work its comments discuss.
 *
 * Read through {@link SHELL_STEP_KEY} rather than a fresh regex, for the reason
 * that constant's own comment gives: this file previously asked "is this a
 * shell step" in two places and got two answers. A second spelling here would
 * be a third.
 *
 * Comments are dropped, and that is the whole point of extracting commands at
 * all. `UnitTests` names `build:bundle-scenes`, `test:parity` and `test:perf`
 * inside the block comment explaining what it deliberately does *not* do, so a
 * check that searched the job body would fail on an unmodified tree -- and a
 * guard that is red on arrival gets deleted rather than obeyed.
 *
 * The block-scalar body ends at the step's own content column, past the `- `,
 * which is why {@link contentColumn} is reused instead of the raw indent.
 * Measuring the dash instead pulls the step's sibling keys (`displayName`,
 * `env`) in as if they were shell text -- harmless for the markers below, and
 * exactly the kind of imprecision that stops being harmless when somebody adds
 * a marker that happens to appear in a display name.
 */
function commandsIn(body: string): string[] {
    const lines = body.split("\n");
    const commands: string[] = [];

    for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index] ?? "";
        const match = SHELL_STEP_KEY.exec(line);
        if (!match) {
            continue;
        }

        const column = contentColumn(line);
        const inline = (match[2] ?? "").trim();

        if (inline.startsWith("|") || inline.startsWith(">")) {
            for (index += 1; index < lines.length; index += 1) {
                const scalar = lines[index] ?? "";
                if (scalar.trim() !== "" && contentColumn(scalar) <= column) {
                    index -= 1;
                    break;
                }
                commands.push(scalar.trim());
            }
        } else {
            commands.push(inline);
        }
    }

    return commands.filter((command) => command !== "" && !command.startsWith("#"));
}

/**
 * Work that master is deliberately not asked to do, named by the command that
 * does it.
 *
 * Every other check in this file compares one hand-written artifact against
 * another -- a constant against the pipeline, the pipeline against
 * `TESTING.md`, `TESTING.md` against itself. That lattice is strong against a
 * partial edit and worth nothing against a complete one, because an author who
 * edits every side leaves every side in agreement. Measured: un-gating
 * `BundleSize`, dropping its PR comment step and its static-site template so it
 * genuinely stops reading pull-request context, moving it from
 * `KNOWN_PR_CONTEXT_JOBS` to `KNOWN_MASTER_JOBS`, naming it in the post-merge
 * sentence, deleting its bullet from the excluded list and re-pointing the
 * anchor that bullet carried. **Eight edits, every artifact consistent, and
 * this file went 13 passed** -- with master now running the ~42-minute
 * all-scene build on every merge, duplicating
 * `azure-pipelines-bundle-manifest.yml` and quadrupling the ~11 minutes the
 * design promises.
 *
 * With the clause below: 1 failed, and it is that one, alone.
 * Without it:            13 passed.
 *
 * The deletion test was run at that end state rather than at the cheap arm,
 * which is the only place it says anything -- un-gate `BundleSize` and stop
 * there and four clauses fire, so removing this one still leaves the arm red
 * and proves nothing about it.
 *
 * So this is taken from the side that is not an assertion: what the job *runs*.
 * `pnpm build:bundle-scenes` is expensive because it builds every scene, and
 * `browserstack` is flaky because it is somebody else's cloud. No edit to this
 * file revokes either, which is the property the constants above lack.
 *
 * These two are also the reasons `TESTING.md` gives, so the floor and the
 * document fail together rather than the floor inventing a third rationale
 * nobody agreed to.
 */
const EXPENSIVE_WORK = [
    { command: "build:bundle-scenes", why: "builds every scene (~42 min) and master already gets it from azure-pipelines-bundle-manifest.yml" },
    { command: "browserstack", why: "runs on an external cloud that fails for reasons unrelated to the code" },
];

/**
 * The excluded work a job's commands name, if any.
 *
 * Split out so the matcher has one definition that both the real-pipeline check
 * and the specimens above it exercise. Spelling the `.toLowerCase().includes()`
 * twice -- once for the offenders and once for the reachability arm -- would
 * mean the specimens control one copy and the other drifts, which is the
 * two-lists failure {@link SHELL_STEP_KEYS} exists to prevent.
 */
function expensiveWorkIn(body: string): string[] {
    const commands = commandsIn(body);
    return EXPENSIVE_WORK.filter((work) => commands.some((command) => command.toLowerCase().includes(work.command))).map((work) => work.command);
}

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
            gated: ownCondition.some(acceptedAsGate),
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
    .filter((file) => isDualContext(file.text))
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
            isDualContext(publish.replace(/^pr:\s*none\s*$/m, "pr:\n  branches:\n    include:\n      - master")),
            "the same file with a pull-request trigger must enter the subject; if it does not, this exclusion is by name rather than by mechanism and a future dual-context publish pipeline goes unguarded"
        ).toBe(true);

        // The mirror, and it is the half that was missing. The counterfactual
        // above moves a file *into* the subject by giving it the pull-request
        // trigger it lacks, which exercises `canBuildPullRequests` and leaves
        // `canRunOnMaster` untouched. Measured: deleting `canRunOnMaster` from
        // the filter entirely left all thirteen clauses green, because every
        // pipeline in this repository that builds pull requests also builds
        // master -- the two conjuncts select the same files, so one of them was
        // decoration that nothing could see.
        //
        // The repository cannot supply the specimen: a pipeline that builds
        // pull requests and never builds master does not exist here, and adding
        // one to make a guard testable is inventing infrastructure. So the
        // specimen is the real file with its master trigger taken away, which
        // is the change somebody would actually make -- turning this pipeline
        // pull-request-only again is exactly the regression this PR exists to
        // prevent, and it has to leave the subject when it happens.
        const dual = readFileSync(join(repoRoot, "azure-pipelines.yml"), "utf8");

        expect(canRunOnMaster(dual), "azure-pipelines.yml must build master, or this PR's change has been reverted").toBe(true);

        const withoutMasterTrigger = dual.replace(/^trigger:[ \t]*$/m, "trigger: none");

        expect(withoutMasterTrigger, "the trigger declaration did not change, so the counterfactual below is measuring the unmodified file").not.toBe(dual);
        expect(
            isDualContext(withoutMasterTrigger),
            "azure-pipelines.yml stops building master and is still selected as a dual-context pipeline. The master half of the selection is then decoration: " +
                "every clause below would keep demanding master gates on a pipeline that no longer builds master."
        ).toBe(false);
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

        // The loop above iterates the constant, so emptying the constant runs it
        // zero times: `KNOWN_PR_CONTEXT_JOBS = []` was thirteen passed. Same
        // defect as its twin `KNOWN_MASTER_JOBS`, which was floored on the
        // pipeline several commits ago -- one was fixed and the other was never
        // asked the question, because the two look nothing alike at the call
        // site and identical in kind.
        //
        // The identity takes the other direction from the pipeline, which is the
        // side nobody is asserting: a job that starts reading pull-request
        // context and is not in the constant is now a failure too, where before
        // only the gating clause would have noticed and only if it were ungated.
        //
        // Residual, measured, because an identity between two sets is satisfied
        // by both being empty: emptying the constant *and* blinding
        // `PR_CONTEXT_MARKERS` leaves this assertion green (four other clauses
        // fire, this one is not among them). What floors that case is not here
        // -- it is the manufactured specimens for `readsPullRequestContext`
        // (`isUngatable`, the template-hop fixture, the comment-task-only body).
        // They are the only inputs in this file that do not come from the repo
        // tree, so they are the side no edit to the pipeline or to this constant
        // can reach. Deleting them as redundant re-opens this clause.
        expect(
            [...prContextJobs.map((job) => job.name)].sort(),
            `the jobs that actually read pull-request context and KNOWN_PR_CONTEXT_JOBS have diverged.\n` +
                `  detected in the pipeline: ${prContextJobs.map((job) => job.name).join(", ") || "(nobody)"}\n` +
                `  KNOWN_PR_CONTEXT_JOBS:    ${KNOWN_PR_CONTEXT_JOBS.join(", ") || "(nobody)"}\n` +
                `If a job genuinely stopped needing a pull request, remove it here in the same diff. If detection broke, fix detection -- do not edit this ` +
                `constant to agree with a detector that has gone blind, which is the cheapest repair and the one that removes the subject.`
        ).toEqual([...KNOWN_PR_CONTEXT_JOBS].sort());

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
            `a job-level condition is present on these but does not keep them off master, and they read pull-request context:\n  ${ineffective.join("\n  ")}\n` +
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
        //
        // Zero population is also why both halves of the predicate were
        // unfalsifiable -- deleting `readsPullRequestContext` from it left all
        // thirteen clauses green, because the filter runs over nothing either
        // way. So the predicate is named and exercised over specimens below,
        // which is the only way a conjunction guarding an empty set can be
        // controlled at all.
        const isUngatable = (file: { jobs: PipelineJob[]; text: string }) => file.jobs.length === 0 && readsPullRequestContext(file.text);
        const ungatable = dualContextPipelines.filter(isUngatable).map((file) => file.location);

        expect(
            ungatable,
            `these files read pull-request context but declare no job, so there is nowhere to put a master gate:\n  ${ungatable.join("\n  ")}\n` +
                `Do NOT add a condition here -- gate the job that includes the template, or move the step out of it.`
        ).toEqual([]);

        const prContextText = '          - job: X\n            steps:\n                - script: echo "$(System.PullRequest.PullRequestNumber)"\n';
        const cases = [
            { what: "no jobs and pull-request context: the case this clause exists for", jobs: [], text: prContextText, ungatable: true },
            { what: "no jobs and no pull-request context: an ordinary template", jobs: [], text: "steps:\n  - script: echo hi\n", ungatable: false },
            { what: "pull-request context inside a job, which the gating clause owns instead", jobs: jobsIn(prContextText), text: prContextText, ungatable: false },
        ];

        for (const one of cases) {
            expect(isUngatable(one), `${one.what}: isUngatable should be ${one.ungatable}`).toBe(one.ungatable);
        }
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
            {
                what: "a condition reading the pull-request number, which is the most explicit form the dependency takes",
                body: "          - job: Snapshot\n            condition: ne(variables['System.PullRequest.PullRequestNumber'], '')\n            steps:\n                - script: echo hi\n",
                marker: "variable in a condition",
            },
        ];

        // The other direction, and the one a tree full of explanatory comments
        // makes easy to get wrong: a job that only *mentions* the dependency
        // does not have it.
        // ...and the direction that costs more if it goes wrong. Stripping every
        // line that merely *contains* a `#` leaves this file green: measured, 15
        // passed. A job whose pull-request read shares a line with a trailing
        // comment would then be classified as safe for master, which is the
        // failure this whole file exists to prevent, arriving through the very
        // helper added to prevent its mirror image.
        expect(
            readsPullRequestContext(
                '          - job: Snapshot\n            steps:\n                - script: echo "$(System.PullRequest.PullRequestNumber)" # log which PR this is\n'
            ),
            "a job that reads the pull-request number on a line carrying a trailing comment is being classified as needing no pull request.\n" +
                "Comment stripping is meant to remove lines a pipeline never executes, not lines that merely mention themselves; over-stripping ungates a job that genuinely cannot run on master."
        ).toBe(true);

        expect(
            readsPullRequestContext(
                "          - job: Lint\n            steps:\n                # System.PullRequest.PullRequestNumber is unavailable on master\n                - script: pnpm lint\n"
            ),
            "a job whose only pull-request reference is a comment explaining that it has none is being classified as needing a pull request.\n" +
                "Nothing executes a comment. The clauses downstream would require it to be gated, and gating it is exactly how a deterministic job leaves post-merge validation."
        ).toBe(false);

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

    it("pins what counts as a master gate, in both directions", () => {
        // Everything in this file that decides whether master is safe reads
        // `job.gated`, and `job.gated` is two regexes. Those regexes were pinned
        // by nothing.
        //
        // Measured. Widen them to /Build\.SourceBranch/ and /refs\//, change
        // nothing else, and this file stays **14 passed** -- the widening lands
        // green. Then rewrite one job's condition to
        // `and(succeeded(), or(true, eq(variables['Build.SourceBranch'],
        // 'refs/heads/master')))`, which admits master, and it is **still 14
        // passed**: the job now counts as gated, so the pull-request clause
        // skips it and the cost floor above filters it out on `!job.gated`.
        // Two edits, one of them in this file alone, no constant and no
        // document touched, and `Bundle Size` runs on every merge.
        //
        // That same pipeline edit *without* the widening fires five clauses. So
        // the pipeline side was never the weak half: the predicate was, and
        // every check downstream inherited its blindness. Pinning names and
        // identities does not help, because the field that grants the exemption
        // is not a name.
        //
        // No oracle here -- there is no ADO expression evaluator to ask, unlike
        // the YAML boundary above. The two accepted spellings are the ones this
        // repository's own header comment and TESTING.md prescribe, and both
        // appear in the pipeline (9 and 1 occurrences); the rejected list is
        // authored, and it is the half that does the work.
        // The accepted side is not written here. The pipeline header prescribes
        // the gate spellings to contributors in indented `#     condition: ...`
        // blocks, and those prescriptions are what a new job gets written from,
        // so they are the artifact this predicate owes agreement to. Authoring
        // the list instead would let both sides drift together in one edit --
        // the capitulation shape from the clause below.
        const prescribed = dualContextPipelines.flatMap((file) =>
            file.text
                .split("\n")
                .filter((line) => /^#\s+condition:/.test(line))
                .map((line) => line.replace(/^#\s?/, ""))
        );
        expect(
            prescribed.length,
            `no pipeline header prescribes a gate condition any more, so this clause is comparing the predicate against an empty list and would agree with anything.\n` +
                `Either the guidance moved out of the '#     condition: ...' form this reads, or it was dropped -- and contributors now have nothing to copy.`
        ).toBeGreaterThan(0);

        const rejected = [
            "            condition: always()",
            "            condition: succeeded()",
            "            condition: eq(variables['Build.SourceBranch'], 'refs/heads/master')",
            "            condition: and(succeeded(), or(true, eq(variables['Build.SourceBranch'], 'refs/heads/master')))",
            "            condition: ne(variables['Build.SourceBranch'], 'refs/heads/develop')",
            "            condition: startsWith(variables['Build.SourceBranch'], 'refs/heads/')",
            "            condition: ne(variables['System.PullRequest.PullRequestNumber'], '')",
        ];

        const missed = prescribed.filter((line) => !acceptedAsGate(line));
        expect(
            missed,
            `these conditions do keep a job off master and this predicate does not recognise them:\n  ${missed.join("\n  ")}\n` +
                `A job written to follow this repository's own documentation would be reported as ungated, and the advice attached to that failure argues for loosening the gate.`
        ).toEqual([]);

        const admitted = rejected.filter((line) => acceptedAsGate(line));
        expect(
            admitted,
            `these conditions all let a job run on master and this predicate accepts them as gates:\n  ${admitted.join("\n  ")}\n` +
                `Every clause in this file trusts that answer, so widening it here quietly excuses the pipeline from all of them at once.`
        ).toEqual([]);

        // A "does any real condition still parse as a gate" floor stood here and
        // was deleted rather than kept. Measured: rewrite every real gate to
        // 'refs/heads/mainline' and six clauses fire, five of them not this one.
        // Nothing separates it -- widen the predicate and it passes, narrow it
        // and the set-identity clauses fire first -- so it was subsumption, not
        // a floor, and a conjunct no input can isolate is one nobody can trust.
        //
        // Deliberately *not* required per-form. `refs/pull/` is prescribed by
        // the header and used by no job, which the header says in as many words
        // ("No job uses that today"), and a per-form version of the floor above
        // is red on arrival for exactly that reason. The honest reading is that
        // a form earns its place by being prescribed, not by being used: the
        // second form exists so that the job the header tells you to write is
        // recognised the day it is written. Per-form liveness is supplied by the
        // prescription check instead, which does bind both.
        const unprescribed = GATE_FORMS.filter((form) => !prescribed.some((line) => form.test(line))).map((form) => form.source);
        expect(
            unprescribed,
            `these gate spellings are accepted by this predicate and prescribed by no pipeline header: ${unprescribed.join(", ")}.\n` +
                `A form nothing documents is a widening with no author to answer for it, and it is the cheapest place to admit master.`
        ).toEqual([]);

        const deadMarkers = PR_CONTEXT_MARKERS.filter((marker) => !dualContextPipelines.some((file) => file.jobs.some((job) => matchesAnyLine(marker, job.body)))).map(
            (marker) => marker.source
        );
        expect(
            deadMarkers,
            `these pull-request markers select no job at all: ${deadMarkers.join(", ")}.\n` +
                `A disjunction only needs one true disjunct, so a dead marker is covered for by its neighbour and the gap only appears when the neighbour stops matching too.`
        ).toEqual([]);
    });

    it("keeps master off the work it deliberately excluded", () => {
        // The terminal assertion for the *cost* direction, and the file went
        // without one for nine rounds because every arm anybody runs at a gate
        // pushes the other way -- gate too much, and master validates nothing.
        // The neighbours all catch that. Un-gate something expensive and they
        // catch it too, right up until the author finishes the job: the eight
        // edits in EXPENSIVE_WORK's comment leave every constant, the pipeline
        // and TESTING.md in agreement, and nothing above this line objects.
        //
        // Nothing above it can, because they all compare authored text to
        // authored text. This one compares the ungated jobs to the commands
        // they run.
        // Specimens first, because every branch of the matcher below is
        // unreached by the repository. All four real invocations are lowercase
        // and inline, so the case fold and the block-scalar body would both be
        // dead code that no arm can distinguish from working code -- the shape
        // this file has now hit four times. The pipeline cannot supply the
        // missing inputs, so they are written here.
        const detected = (body: string) => expensiveWorkIn(body);

        expect(detected("steps:\n  - script: pnpm build:bundle-scenes\n"), "an inline command naming excluded work is not detected").toEqual(["build:bundle-scenes"]);
        expect(detected("steps:\n  - script: pnpm BUILD:BUNDLE-SCENES\n"), "the match is case-sensitive, so a rename that only changes case walks past it").toEqual([
            "build:bundle-scenes",
        ]);
        expect(detected("steps:\n  - script: |\n      pnpm build:bundle-scenes\n"), "a command inside a block scalar is not read, so multi-line steps are invisible").toEqual([
            "build:bundle-scenes",
        ]);
        expect(detected("steps:\n  - script: |\n      # pnpm build:bundle-scenes\n      echo hi\n"), "a commented-out command counts as work the job does").toEqual([]);
        expect(
            detected('steps:\n  - script: |\n      echo hi\n    displayName: "pnpm build:bundle-scenes"\n'),
            "the block scalar swallowed its step's sibling keys, so a display name can trip this check"
        ).toEqual([]);
        expect(detected("steps:\n  - script: echo hi\n"), "a job doing none of this excluded work is reported anyway").toEqual([]);

        const offenders = dualContextPipelines.flatMap((file) =>
            file.jobs
                .filter((job) => !job.gated)
                .flatMap((job) =>
                    expensiveWorkIn(job.body).map((command) => {
                        const work = EXPENSIVE_WORK.find((candidate) => candidate.command === command);
                        return `${file.location}: ${job.name} runs \`${command}\` on master -- it ${work?.why ?? ""}`;
                    })
                )
        );

        expect(
            offenders,
            `a job that runs on every master push does work this design excluded from master:\n${offenders.join("\n")}\n` +
                `Post-merge validation is budgeted at roughly 11 minutes so that a merge is checked before the next one lands. ` +
                `If the budget is genuinely being renegotiated, that is a decision to argue for in TESTING.md and in the pull request, ` +
                `not something to arrive by deleting a condition.`
        ).toEqual([]);

        // The floor's own vacuity arm, and it is not decoration: the check
        // above passes trivially if these commands stop appearing anywhere. A
        // rename of the bundle script, or moving BrowserStack behind a variable,
        // leaves a marker naming work nobody does -- silent, green, and
        // measuring nothing. Asserted separately so it reports in its own words
        // rather than as an absence somewhere else.
        const unreachable = EXPENSIVE_WORK.map((work) => work.command).filter(
            (command) => !dualContextPipelines.some((file) => file.jobs.some((job) => expensiveWorkIn(job.body).includes(command)))
        );

        expect(
            unreachable,
            `these markers name work no job in the dual-context pipeline runs, so the check above is asking a question nothing can answer: ${unreachable.join(", ")}.\n` +
                `Re-point them at whatever replaced the command, or drop them -- a marker kept for a command that no longer exists is a gate that reports success because it never opened.`
        ).toEqual([]);
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
            {
                // The blank-line half of the block-end test, which nothing
                // reached. Measured: dropping `line.trim() !== ""` from that
                // findIndex left all thirteen clauses green, because every
                // blank line in the real pipelines happens to sit *after* the
                // branch list, where truncating early changes no answer. Move
                // one line up -- ordinary formatting, valid YAML -- and the
                // block is cut before `- master` is ever seen, so a pipeline
                // that plainly builds master reads as not building it and
                // silently leaves the subject.
                what: "dual-context: a blank line inside the trigger block, before the branch it names",
                text: "trigger:\n  branches:\n    include:\n\n      - master\n\npr:\n  branches:\n    include:\n      - master\n",
                master: true,
                pullRequest: true,
            },
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
        const templates = templateFilesOnDisk();
        expect(
            templates.length,
            `config/templates/ holds no YAML at all, so the loop below runs zero times and this clause agrees with any pipeline.\n` +
                `Either the templates moved -- and the two jobs whose gating claim arrives only through them are now unexamined -- or this listing is looking in the wrong place.`
        ).toBeGreaterThan(0);

        for (const path of templates) {
            expect(
                referenced,
                referenced.length === 0
                    ? `no dual-context job references any template at all, so this clause is checking an empty set and the readability floor below it cannot fail.\n` +
                          `The reference collector or the job splitter has stopped producing references. Fix that rather than editing KNOWN_TEMPLATE_REFERENCES -- the constant is not what broke, and shortening it here would hide the collector's failure permanently.`
                    : `templates are still being collected (${[...new Set(referenced)].join(", ")}), but no dual-context job references ${path} any more.\n` +
                          `If that include was deliberately removed, delete ${path} from config/templates/ as well -- this reads the directory, so an unreferenced template left on disk stays visible rather than being quietly dropped from a list.\n` +
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

    it("reads a subject that could actually run", () => {
        // Every other clause here asks what the pipeline *says*. This one asks
        // whether it is a pipeline at all, and it is the only clause a
        // corrupting edit cannot pass. Without it, a probe that mutates this
        // file into something ADO would reject gets twelve green clauses and
        // the appearance of a finding.
        const subjects = [
            ...dualContextPipelines.map((file) => ({ location: file.location, text: file.text })),
            ...readdirSync(join(repoRoot, "config", "templates"))
                .filter((name) => /\.ya?ml$/.test(name))
                .map((name) => ({ location: `config/templates/${name}`, text: readFileSync(join(repoRoot, "config", "templates", name), "utf8") })),
        ];

        expect(subjects.length, "no pipeline or template was read, so this clause is asking nothing of anything").toBeGreaterThan(0);
        // Reached by starving both sources at once: strip the master trigger so
        // no pipeline is dual-context, and leave config/templates present but
        // holding no YAML. Six other clauses also fire in that state, which is
        // why this one's contribution only shows at clause granularity --
        // removing it takes this clause from failing to passing while the file
        // stays red for unrelated reasons. A file-level red/green reading calls
        // that decoration; it is not.

        const broken = subjects.flatMap((subject) => structureProblems(subject.text).illegal.map((problem) => `${subject.location}: ${problem}`));

        expect(
            broken,
            `these files cannot parse as YAML, so Azure DevOps would reject them and every other clause here is reading a file that never runs:\n${broken.join("\n")}`
        ).toEqual([]);

        // Separate assertion because it is a separate remedy, and because the
        // message above would be a lie about it. A plain scalar legally
        // continues onto deeper lines, so this shape parses, ADO runs it, and
        // the deeper line is silently swallowed into the value above -- a
        // `script:` body that quietly grew a word. Nothing rejects it and
        // nothing shows it in review.
        const swallowed = subjects.flatMap((subject) => structureProblems(subject.text).folded.map((problem) => `${subject.location}: ${problem}`));

        expect(
            swallowed,
            `these lines are legal YAML and still almost certainly wrong -- each folds into the value on the line above instead of standing on its own:\n${swallowed.join("\n")}\n` +
                `If the continuation is deliberate, make it explicit with a block scalar (\`|\` or \`>\`). If it was meant to be its own key, it is under-indented by mistake.`
        ).toEqual([]);

        // A specimen per skipped form, because the two block-scalar indicators
        // are a disjunction and the tree exercises only one. Measured: deleting
        // the `>` half left every clause green -- no folded scalar exists in
        // any pipeline here, so that half was unfalsifiable, and the first
        // `script: >` anybody writes would be reported as malformed YAML. A
        // guard that fires on correct code gets deleted, which is the failure
        // mode that matters more than the miss.
        //
        // Every `expect` column below is the verdict of an actual YAML parser
        // (PyYAML) on that exact text, not my reading of the spec. The row that
        // made this necessary is the fourth: it used to assert `broken: true`,
        // and it is *accepted*. The fixture was pinning a false positive as
        // correct behaviour, so the predicate could never be found wrong by the
        // thing written to check it.
        // Every `rejected` below is the verdict of an actual YAML parser
        // (PyYAML) on that exact text, not my reading of the spec. Two earlier
        // versions of this table were the reason the predicate stayed wrong: a
        // row asserting `broken: true` for a shape the parser *accepts*, and
        // then a set of rows that were all corruptions. Specimens written only
        // for the illegal direction cannot find a predicate that is too strict,
        // and too strict is the direction that gets a guard deleted.
        //
        // Eighteen of the twenty-nine are accepted by the parser, and that ratio
        // is asserted below rather than left to drift. Every branch in
        // `valueShape` and `flowIsClosed` was silent under mutation until a row
        // here reached it: the comment-only skip, both quote-termination tests,
        // the flow balance scan, its quote handling, its comment break, its
        // escape skip, and the lookahead that stops a doubled apostrophe from
        // being read as a terminator. Eleven arms, all firing, and every one of
        // them was silent before its specimen existed -- the branches were
        // reachable and correctly asserted, they simply had no input.
        const scalars = [
            { what: "comment-only value + deeper mapping entry", text: "steps:\n  - script: # note\n      c: 1\n", rejected: false, folded: false },
            // The two rows that reach MAPPING_COLON's actual decision -- whether
            // a colon makes a key -- rather than only its outcome. Every other
            // illegal row here uses a clean `c: 1`, so loosening the rule to "a
            // colon anywhere" left the whole table green while making the guard
            // reject legal pipelines: script bodies are full of colons that are
            // not keys. Verdicts from PyYAML, which folds both of these into the
            // plain scalar ("x echo two:three"), not from what the rule predicts.
            { what: "plain value + deeper shell line whose colon has no space after it", text: "steps:\n  - script: x\n      echo two:three\n", rejected: false, folded: true },
            {
                what: "plain value + deeper URL, the colon a pipeline is likeliest to contain",
                text: "steps:\n  - script: x\n      http://example.com/y\n",
                rejected: false,
                folded: true,
            },
            { what: "comment-only value + deeper bare line", text: "steps:\n  - script: # note\n      more\n", rejected: false, folded: false },
            { what: "literal block whose body looks like a mapping", text: "steps:\n  - script: |\n      c: 1\n", rejected: false, folded: false },
            { what: "a strip-chomped block scalar", text: "steps:\n  - script: |-\n      echo one\n", rejected: false, folded: false },
            { what: "a folded strip-chomped block scalar", text: "steps:\n  - script: >-\n      echo one\n", rejected: false, folded: false },
            { what: "a block scalar with an explicit indent indicator", text: "steps:\n  - script: |2\n      echo one\n", rejected: false, folded: false },
            { what: "a blank line between a value and its sibling", text: 'steps:\n  - script: "x"\n    \n    name: y\n', rejected: false, folded: false },
            { what: "a comment line between a value and its sibling", text: 'steps:\n  - script: "x"\n      # c\n    name: y\n', rejected: false, folded: false },
            { what: "an anchored plain value with a deeper bare line", text: "steps:\n  - script: &a echo one\n      more\n", rejected: false, folded: true },
            { what: "a flow mapping value with a deeper bare line", text: "steps:\n  - script: {a: 1}\n      more\n", rejected: true, folded: false },
            { what: "a flow sequence value with a deeper bare line", text: "steps:\n  - script: [1, 2]\n      more\n", rejected: true, folded: false },
            { what: "a plain value that ends the file", text: "steps:\n  - script: echo one\n", rejected: false, folded: false },
            { what: "an unclosed flow mapping finished on the deeper line", text: "steps:\n  - script: {a: 1,\n      b: 2}\n", rejected: false, folded: false },
            { what: "an unclosed flow sequence finished on the deeper line", text: "steps:\n  - script: [1,\n      2]\n", rejected: false, folded: false },
            { what: "an unterminated double quote finished on the deeper line", text: 'steps:\n  - script: "x\n      y"\n', rejected: false, folded: false },
            { what: "an unterminated single quote finished on the deeper line", text: "steps:\n  - script: 'x\n      y'\n", rejected: false, folded: false },
            { what: "a brace inside a quoted value, not a flow collection", text: 'steps:\n  - script: "{a"\n      more\n', rejected: true, folded: false },
            { what: "a quoted value ending in an escaped quote", text: 'steps:\n  - script: "a\\""\n      more\n', rejected: true, folded: false },
            { what: "a quoted value with a deeper quoted line", text: 'steps:\n  - script: "x"\n      "y"\n', rejected: true, folded: false },
            { what: "a closed flow mapping whose brace is inside a quote", text: 'steps:\n  - script: {a: "}"}\n      more\n', rejected: true, folded: false },
            { what: "a closed flow sequence whose bracket is inside a quote", text: 'steps:\n  - script: [a, "]"]\n      more\n', rejected: true, folded: false },
            { what: "an unclosed flow mapping whose brace is inside a quote", text: 'steps:\n  - script: {a: "}",\n      b: 2}\n', rejected: false, folded: false },
            { what: "a closed flow collection whose trailing comment holds a brace", text: "steps:\n  - script: {a: 1} # note {\n      more\n", rejected: true, folded: false },
            { what: "a double quote closed by an escaped quote", text: 'steps:\n  - script: "a\\""\n      more\n', rejected: true, folded: false },
            { what: "a double quote ended by an escaped quote, so it continues", text: 'steps:\n  - script: "a\\"\n      b"\n', rejected: false, folded: false },
            { what: "a single quote holding a doubled apostrophe", text: "steps:\n  - script: 'it''s'\n      more\n", rejected: true, folded: false },
            { what: "a single quote with a doubled apostrophe, continuing", text: "steps:\n  - script: 'it''s\n      b'\n", rejected: false, folded: false },
            // A comment and a blank line between the key and the line nested
            // under it. PyYAML rejects both, and they are here because the
            // skip loops -- the predicate's, and the re-derivation of the
            // cited parent above -- had no input that ran their bodies. Every
            // other row puts the deeper line immediately after the key, so
            // both loops fell straight through and mutating them changed no
            // verdict any row could see.
            { what: "a comment line between the key and the line nested under it", text: 'steps:\n  - script: "a"\n  # note\n      b: 1\n', rejected: true, folded: false },
            { what: "a blank line between the key and the line nested under it", text: 'steps:\n  - script: "a"\n\n      b: 1\n', rejected: true, folded: false },
            { what: "a closed flow mapping holding an escaped quote", text: 'steps:\n  - script: {a: "x\\""}\n      more\n', rejected: true, folded: false },
            { what: "an unclosed flow mapping holding an escaped quote", text: 'steps:\n  - script: {a: "x\\"",\n      b: 2}\n', rejected: false, folded: false },
        ];

        // Two columns, and they are not the same kind of claim. `rejected` is
        // the parser's verdict, taken from PyYAML and not from anybody's
        // reading of the spec. `folded` is a design judgement: of the shapes
        // the parser *accepts*, which ones should this predicate report as a
        // silent fold rather than pass over in silence. No parser can settle
        // that -- an accepted file is accepted -- so the column restates, per
        // row, the rule the comment above states in prose: a fold is expected
        // exactly when a complete plain scalar is followed by a deeper line
        // that is not a mapping entry.
        //
        // It is pinned anyway, and the reason is worth the space. Before this
        // column existed the table asserted only the legal/illegal axis, so
        // deleting the `>` half of the block-scalar test changed nothing that
        // any row could see: `>-` stopped being a block scalar, became a plain
        // one, and got reported as a silent fold -- a guard firing on correct
        // YAML, which is the failure mode that gets a guard deleted rather
        // than fixed. The mutation was invisible because the verdict it
        // corrupted was never read.
        const disagreements = scalars.flatMap((scalar) => {
            const problems = structureProblems(scalar.text);
            const notes: string[] = [];
            if (problems.illegal.length > 0 !== scalar.rejected) {
                notes.push(`${scalar.what} -- the parser ${scalar.rejected ? "rejects" : "accepts"} it and this predicate says the opposite`);
            }
            if (problems.folded.length > 0 !== scalar.folded) {
                notes.push(`${scalar.what} -- this predicate ${problems.folded.length > 0 ? "reports" : "does not report"} a silent fold and the table says the opposite`);
            }
            return notes;
        });

        // Collected rather than asserted per row: when this was a loop of
        // `expect`s, the first failing shape threw and the remaining twelve
        // never ran, so a three-defect result reported as one.
        expect(disagreements, `structureProblems disagrees with a real YAML parser:\n${disagreements.join("\n")}`).toEqual([]);

        expect(
            scalars.filter((scalar) => !scalar.rejected).length,
            "every specimen here is a corruption, so nothing measures whether this predicate is too strict"
        ).toBeGreaterThan(scalars.filter((scalar) => scalar.rejected).length);

        // The fold verdict has one witness in this table, and one witness is
        // how the `>` deletion above stayed invisible for a round. Stated as a
        // floor so that a future edit which drops that row has to notice the
        // whole verdict is going unmeasured, rather than discovering it the
        // next time somebody mutates the branch it protects.
        expect(scalars.filter((scalar) => scalar.folded).length, "no specimen exercises the silent-fold verdict, so nothing here can tell it from silence").toBeGreaterThan(0);

        // Both columns above are one bit per row, and the bit is not what this
        // guard is for. It runs against an ~880-line pipeline and its entire
        // value is naming the line -- and nothing above reads a word of the
        // message it names it in. Measured, four arms, all four green before
        // this block existed: report `line ${next + 99}` instead of `next + 1`;
        // replace the message with a constant; report only the first corruption
        // and drop the rest; drop the quoted excerpt. A guard that says "something
        // is wrong somewhere" in an 880-line file is a guard nobody can act on,
        // and every column here would still have agreed with it.
        //
        // The expectations are derived from each subject rather than written per
        // row: a cited line has to exist in that subject, the deeper line has to
        // come after the line it is deeper than, and the excerpt has to be text
        // that subject actually contains. Thirty-one hand-written line numbers
        // would be thirty-one more authored constants, and the subject is right
        // there.
        const misreported = scalars.flatMap((scalar) => {
            const lines = scalar.text.split("\n");
            const problems = structureProblems(scalar.text);

            return [...problems.illegal, ...problems.folded].flatMap((problem) => {
                const cited = [...problem.matchAll(/line (\d+)/g)].map((match) => Number(match[1]));
                const notes: string[] = [];

                if (cited.length !== 2) {
                    notes.push(`${scalar.what} -- the report names ${cited.length} line numbers; it has to name the deeper line and the line it is deeper than`);
                    return notes;
                }

                const [deeper, parent] = [cited[0] ?? 0, cited[1] ?? 0];

                // There was an in-range check here and it is deliberately gone.
                // Measured at this end state: removing it while citing a line
                // outside the subject still fails, because a citation that
                // names a line the subject does not have cannot also quote that
                // line's text, and the two checks below catch it on that route.
                // No input separated it, so it was a conjunct that could only
                // ever agree. It becomes load-bearing again the moment the
                // message stops quoting the parent line -- then nothing else
                // reads the subject's length, and it has to come back.

                // Existence and ordering are not enough, and this is the arm
                // that proved it: dropping the `+ 1` from the second number
                // alone -- an off-by-one reporting a 0-based line, the single
                // likeliest way this message goes wrong -- left every check
                // above green. Both numbers were in range and still ordered.
                // So each number is bound to the line it claims: the parent is
                // re-derived here as the nearest preceding line that is neither
                // blank nor a comment, which is the line the predicate compared
                // the deeper one against, and the excerpt has to be that same
                // line's text. A citation that names a real line, in the right
                // order, quoting some other line, is a citation that sends the
                // reader to the wrong place in an ~880-line file.
                let expected = deeper - 2;
                while (expected >= 0 && (!(lines[expected] ?? "").trim() || (lines[expected] ?? "").trim().startsWith("#"))) expected--;

                if (parent !== expected + 1) {
                    notes.push(`${scalar.what} -- the report blames line ${parent} for line ${deeper}, but the line above it is ${expected + 1}`);
                }

                const excerpt = /\("(.*)"\), which already has a value/.exec(problem);
                if (!excerpt) {
                    notes.push(`${scalar.what} -- the report quotes no line at all, so it can only be acted on by re-reading the whole file`);
                } else if (excerpt[1] !== (lines[parent - 1] ?? "").trim().slice(0, 44)) {
                    notes.push(`${scalar.what} -- the report cites line ${parent} but quotes ${JSON.stringify(excerpt[1])}, which is not that line`);
                }

                return notes;
            });
        });
        expect(misreported, `structureProblems reports a problem nobody could act on:\n${misreported.join("\n")}`).toEqual([]);

        // Reporting stops at the first corruption unless something counts, and
        // the pipeline is the size where the second one matters most.
        const twice = structureProblems('steps:\n  - script: "a"\n      b: 1\n  - script: "c"\n      d: 2\n');
        expect(
            twice.illegal.length,
            `a subject carrying two independent corruptions reports ${twice.illegal.length} of them.\nFixing the one it names and re-running would then report a file that is still broken as clean.`
        ).toBe(2);
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
        // This floor looks like decoration under every cheap mutation and is
        // not. Gate all three jobs and it fires -- alongside two neighbours
        // firing for better reasons, so deleting it still leaves that arm red
        // and tells you nothing. Its actual case is the honest end state, where
        // every neighbour is legitimately satisfied: gate all three, record them
        // in COST_GATED_JOBS, document them as excluded, empty KNOWN_MASTER_JOBS
        // and reword the post-merge sentence to match. Six edits, each one
        // resolving a real failure, every artifact in agreement, master
        // validating nothing.
        //
        // With this line: 1 failed, and it is this one, alone.
        // Without it:     13 passed.
        //
        // So it is the terminal assertion of the file -- the only one that
        // survives full capitulation -- and no cheap arm can show that, because
        // a floor's contribution is invisible until its neighbours are quiet.

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
            `TESTING.md contradicts itself about ${alsoExcluded.join(", ")}: the post-merge sentence re-runs it and the excluded list says master stopped. Both cannot be true.\n` +
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
        const excluded = excludedJobLabels();

        // The identity that makes the grant readable in both directions. The old
        // binding only ever asked the document about names COST_GATED_JOBS
        // already held -- so while that constant is empty it asked nothing at
        // all, and the document could say anything. These two assertions are the
        // reverse direction: what the list claims must correspond to what the
        // pipeline does, whether or not any constant is interested.
        const gatedLabels = dualContextPipelines
            .flatMap((file) => file.jobs)
            .filter((job) => job.gated)
            .map((job) => displayNameOf(job))
            .filter((label): label is string => label !== undefined);

        expect(
            excluded.filter((label) => !gatedLabels.includes(label)).sort(),
            `TESTING.md lists these as deliberately excluded from master, but the pipeline does not gate them: ${excluded.filter((l) => !gatedLabels.includes(l)).join(", ")}.\n` +
                `Either the gate was removed and the list is now telling a reader that master skips something it actually runs, or the name is spelled differently from the ` +
                `job's displayName -- in which case add it to DOC_NAME_ALIASES with the reason, rather than leaving a grant this check cannot read.`
        ).toEqual([]);

        expect(
            gatedLabels.filter((label) => !excluded.includes(label)).sort(),
            `these jobs are gated off master but TESTING.md's excluded list does not name them: ${gatedLabels.filter((l) => !excluded.includes(l)).join(", ")}.\n` +
                `A reader deciding whether post-merge validation still covers something reads that list. A job missing from it is invisible there while being invisible on master too.`
        ).toEqual([]);

        // DOC_NAME_ALIASES is hand-maintained, and an alias is a grant: it lets a
        // string in the document stand for a job. Left unpinned, the cheapest way
        // to silence either identity above is to add an entry mapping whatever
        // the document happens to say onto whatever the pipeline happens to run.
        // So each entry has to earn its place -- the key must really appear in
        // the list, the value must really be a job, and the two must really
        // differ, or the alias is dead weight that only widens what is accepted.
        // These two sit above the hatch check below and will short-circuit it
        // for any job that is gated: delete a bullet for a gated job and this
        // fires first, leaving the hatch's own assertion unreached by the
        // obvious arm. The arm that isolates the hatch is a job recorded in
        // COST_GATED_JOBS that is *not* gated -- both identities are then
        // satisfied and only the hatch can see it.
        const allLabels = dualContextPipelines.flatMap((file) => file.jobs).map((job) => displayNameOf(job));
        for (const [docName, label] of Object.entries(DOC_NAME_ALIASES)) {
            expect(boldNamesIn(block), `DOC_NAME_ALIASES maps "${docName}", which TESTING.md's excluded section never mentions -- an alias for nothing`).toContain(docName);
            expect(allLabels, `DOC_NAME_ALIASES maps "${docName}" onto "${label}", which is not the displayName of any job in the pipeline`).toContain(label);
            expect(docName, `DOC_NAME_ALIASES maps "${docName}" onto itself, so it grants nothing and hides that the names already agree`).not.toBe(label);
        }

        // One definition, used by the real check and by the specimens below.
        // Written twice, the specimens would exercise a copy and the live
        // predicate would stay exactly as unmeasured as it was.
        const undocumentedFor = (names: string[]) =>
            names.filter((name) => {
                const label = displayNameOf(jobsByName.get(name));
                // The `label === undefined` half is a type guard, not a
                // behavioural branch: with it removed both arms return the same
                // answer for every input, so no runtime arm can separate them
                // and vitest reports thirteen passed. `tsc` rejects it outright
                // -- TS2345, string | undefined where string is required.
                //
                // Which is this PR's own argument, arriving inside its own
                // guard: the check that catches this is the typechecker, master
                // does not currently run one, and a clause whose only possible
                // control is `tsc` is exactly the kind of thing that rots
                // unnoticed on a branch nothing validates.
                return label === undefined || !excluded.includes(label);
            });

        const undocumented = undocumentedFor(COST_GATED_JOBS);

        expect(
            undocumented,
            `these jobs are recorded in COST_GATED_JOBS but nothing in TESTING.md says master stopped validating them: ${undocumented.join(", ")}.\n` +
                `Add each one's displayName, exactly as the pipeline spells it, to the "Deliberately excluded from master" list with the reason it is too slow or too flaky to run post-merge. ` +
                `A job can leave post-merge validation -- it just cannot leave quietly, and this constant on its own is quiet.`
        ).toEqual([]);

        // The predicate above runs zero times today, because COST_GATED_JOBS is
        // empty -- so both of its halves were unfalsifiable, and deleting
        // either one left all thirteen clauses green. An empty constant makes
        // the clause vacuously true, which is a fair state for the constant to
        // be in and *not* a fair state for the logic that reads it: the first
        // entry anybody adds is the moment this has to work, and that is the
        // worst moment to discover it never ran.
        //
        // So the halves are exercised over specimens instead. They are not
        // hypothetical entries -- they are the two ways an entry goes wrong: a
        // name that no job answers to, and a real job nobody documented.
        const documented = [...jobsByName.keys()].find((name) => block.includes(displayNameOf(jobsByName.get(name)) ?? "\u0000"));

        expect(documented, "no job in the pipeline is named in the excluded list, so neither specimen below can distinguish the halves").toBeDefined();

        expect(undocumentedFor(["NoSuchJob"]), "a COST_GATED_JOBS entry naming no job at all must be reported, not skipped as 'nothing to check'").toEqual(["NoSuchJob"]);
        expect(undocumentedFor(KNOWN_MASTER_JOBS), `a job master still runs is not in the excluded list, so recording it as cost-gated must be reported`).toEqual(
            KNOWN_MASTER_JOBS
        );
        expect(undocumentedFor([documented as string]), "a job whose displayName is in the excluded list is documented and must not be reported").toEqual([]);
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
