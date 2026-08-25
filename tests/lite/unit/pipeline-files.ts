import { readFileSync, readdirSync, statSync } from "fs";
import { join, relative } from "path";

export const repoRoot = join(__dirname, "..", "..", "..");

/*
 * A note on how this module must be *measured*, which is not the same as how it
 * must be read.
 *
 * Every predicate here is shared: `pipeline-master-gating`,
 * `pipeline-piped-steps-set-pipefail` and `pipeline-pr-comment-steps-guarded`
 * all consume them, and a given predicate's specimens usually live in only one
 * of those files. `isYamlFile` is the worked example -- both directions are
 * pinned, and both pins are in `pipeline-piped-steps-set-pipefail`.
 *
 * The consequence is a trap for anyone verifying a change here by mutation.
 * Widening `isYamlFile` to accept every filename and then running only
 * `pipeline-master-gating` reports 16/16 green, because that file's clauses
 * never reach the specimen that owns the property. Run the whole `unit`
 * project against the same mutation and five assertions fail by name. The
 * mutation was always caught; the *measurement* was scoped to a file that does
 * not do the catching, and reported "nothing guards this" when the truth was
 * "nothing in this file guards this".
 *
 * So: a mutation of anything in this module is only meaningfully silent if it
 * is silent across every suite that imports it. A single-file verdict on shared
 * code is unsound in both directions -- it understates coverage, and it invites
 * a fix for a gap that does not exist, which then has to be pinned by a second
 * specimen duplicating the first.
 *
 * This is the same defect the module itself exists to prevent, one level up. A
 * scope reads complete because nothing compared it to reality; here the scope
 * is the set of tests the prober chose to run.
 */

/**
 * The directories the pipeline hygiene guards in this file's directory read --
 * `pipeline-piped-steps-set-pipefail` and `pipeline-pr-comment-steps-guarded`.
 *
 * Scoped to those two deliberately. #617 adds two further guards that walk
 * pipeline files with their own local root list, kept separate on purpose so
 * the two branches do not collide on this path; converging them onto this
 * module is a queued follow-up for after both land. Until that happens, "every
 * guard in the repo" would be a claim this module cannot support, and it would
 * become false at merge rather than at edit -- with no execution anywhere to
 * notice.
 *
 * This list lives in one place for the two it does cover. When each carried its
 * own copy, widening one and not the other would have left the second silently
 * narrow while still reporting success -- the same defect both guards exist to
 * prevent, one level up: a scope that reads complete because nothing compares
 * it to reality.
 *
 * `pipelineFilesInRepo()` below is the comparison to reality, and it is
 * asserted against this list so a new pipeline in a new directory fails by name
 * rather than quietly falling outside both guards.
 */
export const SCANNED_ROOTS: { dir: string; label: string; rootOnlyPattern: RegExp | null }[] = [
    // At the repository root, restrict to `azure-pipelines*.yml`: the root also
    // holds unrelated YAML (pnpm-lock.yaml chief among them) that is not a
    // pipeline and would only add noise.
    { dir: repoRoot, label: "", rootOnlyPattern: /^azure-pipelines.*\.ya?ml$/ },
    // `config/templates/` is included because those files are not
    // documentation -- the pipelines pull them in with `- template:`, so their
    // steps run as part of a pipeline and are subject to the same invariants.
    // They are unconditionally in scope; there is nothing else in that
    // directory.
    { dir: join(repoRoot, "config", "templates"), label: "config/templates", rootOnlyPattern: null },
    // GitHub Actions workflows run shell too. They were left out of the first
    // version of this list because "pipeline" was read as "Azure pipeline",
    // which is a convention of the files that happened to be in scope rather
    // than a property of the invariant. The pipefail invariant is a property of
    // bash, and it is live here: compat-sync-trigger.yml pipes `printf` into
    // `base64`, and Actions runs `run:` steps under `bash -e`, which sets
    // `errexit` but *not* `pipefail`. So a failure on the left of that pipe is
    // discarded exactly as it was in the seven Azure steps this PR fixes. The
    // step is correct today by the author's diligence, not by enforcement --
    // which is the state this file exists to convert into a guarantee.
    { dir: join(repoRoot, ".github", "workflows"), label: ".github/workflows", rootOnlyPattern: null },
];

/**
 * Every pipeline YAML file inside {@link SCANNED_ROOTS}, each tagged with the
 * repo-relative path a guard should report on failure and the root it came
 * from, so a guard can assert per-root coverage rather than a single total.
 */
export function pipelineYamlFiles(): { path: string; location: string; root: string }[] {
    const files: { path: string; location: string; root: string }[] = [];
    for (const { dir, label, rootOnlyPattern } of SCANNED_ROOTS) {
        for (const name of readdirSync(dir)) {
            if (!isYamlFile(name)) {
                continue;
            }
            if (rootOnlyPattern && !rootOnlyPattern.test(name)) {
                continue;
            }
            files.push({ path: join(dir, name), location: label ? `${label}/${name}` : name, root: label || "<repo root>" });
        }
    }
    return files;
}

/**
 * The key that introduces a shell script in a CI step, in either dialect:
 * Azure's `- script:` / `- bash:` list items and GitHub's `run:`, which sits
 * un-dashed on the line after `- name:`.
 *
 * Exported so the collector and the closure check share one definition of the
 * subject. When they had two, the collector read `run:` steps while discovery
 * keyed on file *shape*, and the two sets silently diverged -- see
 * {@link pipelineFilesInRepo}. Capture groups are indent and remainder; the
 * regex has no `g` flag, so it holds no state and is safe to share.
 *
 * Matched case-insensitively. This selects the same ten files either way today,
 * so it changes nothing now and is deliberately inert -- but the cost of the
 * two possible futures is wildly asymmetric. If a pipeline ever writes
 * `Script:` and the runner accepts it, a case-sensitive selector misses the
 * file entirely and every guard downstream reports success on a file it never
 * opened. If the runner rejects it, that file is already broken and matching it
 * costs nothing. There is no version of this where the narrower spelling wins,
 * and the failure it prevents is the silent one.
 *
 * Anything reconstructing this regex must carry {@link SHELL_STEP_KEY.flags}
 * through. Building `new RegExp(source, "m")` drops the `i` and quietly
 * restores the case-sensitive behaviour at one call site while the exported
 * constant still looks correct.
 *
 * Built from {@link SHELL_STEP_KEYS} rather than spelling the keys again,
 * because this file previously asked "is this a shell step key" in two places
 * with two different answers -- three keys here, five in the strip's helper.
 * That was safe only by accident: the helper's list was the larger one, so the
 * strip never blanked a body the collector wanted. Reversed by one edit -- a
 * key added here and not there -- and the strip blanks a real script body,
 * every pipe inside it disappears, and the suite stays green. One list, so the
 * two cannot disagree, and a property test below asserts they never do.
 */
export const SHELL_STEP_KEYS = ["script", "bash", "run"] as const;

export const SHELL_STEP_KEY = new RegExp(`^(\\s*)(?:-\\s+)?(?:${SHELL_STEP_KEYS.join("|")}):(.*)$`, "i");

/**
 * The task that posts a comment on a pull request.
 *
 * Exported for the same reason as {@link SHELL_STEP_KEY}: the guard that reads
 * these and the closure check that certifies its scope must agree on what the
 * subject *is*, and the only way to guarantee that is to have one definition.
 * Case-insensitive on the same asymmetry argument -- inert today, and the cost
 * of being wrong is a file nobody opens rather than a file that fails loudly.
 */
export const GITHUB_COMMENT_TASK = /^(\s*)-\s+task:\s*GitHubComment@0\s*$/i;

/**
 * True when the tree walk should descend into a directory.
 *
 * Extracted and pinned because it is the one input to discovery that no
 * assertion downstream can check. The discovered-file count, the per-root
 * floors and the coverage comparison are all *computed after* this decision, so
 * a walk that quietly stops entering a directory produces a smaller inventory
 * and a set of diagnostics in perfect agreement with it. Same property as
 * {@link SHELL_STEP_KEY}, and it arrived the same way: the list was inherited
 * wholesale while fixing something else and never questioned.
 *
 * `tests` is the entry that matters and it fixes a live misfire. A YAML fixture
 * under `tests/` is *test data*, not CI configuration, and a fixture holding a
 * deliberately unguarded step is correct code doing its job. Before this, such
 * a file was discovered, reported as outside SCANNED_ROOTS, and the remediation
 * string told the reader to add its directory to the roots -- at which point
 * the pipefail guard would scan test fixtures and fail on the very step the
 * fixture exists to hold. A false positive whose own advice deepens it,
 * printed in the string that only ever renders to someone already confused.
 *
 * Measured rather than predicted, since a skip list is a *silent* exclusion and
 * therefore the most expensive kind to get wrong: across all tracked YAML in
 * the repo, no file matched by {@link SUBJECT_PATTERNS} sits under any skipped
 * directory, and `tests/` holds no tracked YAML at all. The narrowing excludes
 * nothing that exists.
 */
export function isWalkableDir(name: string): boolean {
    return !["node_modules", ".git", "dist", "build", "coverage", ".vite", "lab", "tests"].includes(name);
}

/**
 * Blank the bodies of multi-line scalars belonging to keys that are not shell
 * steps, preserving line count so reported line numbers stay true.
 *
 * This is the *provenance* problem rather than a scope problem, and no choice
 * of file set reaches it. {@link SHELL_STEP_KEY} is anchored after leading
 * whitespace, which is correct -- a step is indented under `steps:`. But a line
 * inside a multi-line scalar is indented too, so an example step quoted in
 * prose is byte-identical to the thing it describes.
 *
 * Two shapes, settled by different things, which is why the fix needs both and
 * why neither alone would have looked incomplete:
 *
 *     description: |                    <- settled by SYNTAX: a block scalar
 *         run: npx tsc | sed 's/x/y/'      body is data in every dialect.
 *
 *     description: 'Example step:       <- settled by the KEY: an open quoted
 *         run: npx tsc | sed s/x/y/'       scalar folds into one string, and
 *                                          only the key says it is prose.
 *
 * Both verified by injection into `.github/workflows/compat-sync-trigger.yml`
 * -- a file the guard *must* read, so there is no root list that excludes it.
 * The guard collected the prose line and demanded `set -euo pipefail` of a
 * sentence. The second was confirmed against a real YAML parser first, which
 * folds it into a single scalar string: the `run:` is prose by the grammar, not
 * merely by intent. The false positive is aimed squarely at whoever documents
 * the thing being guarded.
 *
 * Fixed above both questions rather than inside either, for the same reason
 * here-doc bodies are: prose is prose for the collector *and* for discovery,
 * and two readers learning separately about what counts as configuration is
 * exactly how they drift. Applied at both sites that read raw file text.
 *
 * A single-line `description: run: x | y` needs nothing: the key regex is
 * anchored to the start of the line and sees `description`, not `run` -- pinned
 * rather than assumed.
 *
 * Failure direction is deliberate throughout. An opener this does not recognise
 * is left alone, and a dedent always ends a body -- so an unterminated quote
 * stops at the next key rather than blanking the rest of the file. Every
 * unrecognised shape costs a false positive that names a line, never a silent
 * miss.
 */
/**
 * True when a fragment closes a quoted scalar opened with `quote`.
 *
 * Naive containment is wrong in the direction that matters, and both spellings
 * are ordinary English rather than exotica. YAML escapes a single quote by
 * doubling it, so `description: 'it''s an example:` *stays open* -- but a
 * `.includes("'")` reads the escape as the terminator, decides the scalar
 * closed on its first line, and hands the continuation to the guard as
 * configuration. Verified by injection: a `run:` on the next line was collected
 * from `.github/workflows/compat-sync-trigger.yml:55`, with a real parser
 * confirming first that the whole thing folds into one scalar containing a
 * plain apostrophe. Double quotes have the same hole spelled `\"`.
 *
 * Used for the opening line *and* for each body line, because the identical
 * mistake at the body scan ends the region early and produces the same misread
 * one line further down.
 */
function closesQuotedScalar(text: string, quote: string): boolean {
    for (let i = 0; i < text.length; i++) {
        const char = text[i];
        if (quote === '"' && char === "\\") {
            i++;
            continue;
        }
        if (char !== quote) {
            continue;
        }
        if (quote === "'" && text[i + 1] === "'") {
            i++;
            continue;
        }
        return true;
    }
    return false;
}

export function stripNonShellMultilineScalars(text: string): string {
    const lines = text.split("\n");
    const out: string[] = [];
    let bodyIndent: number | null = null;
    let closingQuote: string | null = null;

    for (const line of lines) {
        if (bodyIndent !== null) {
            const indent = line.length - line.trimStart().length;
            // A dedent ends the body in both cases. This is the safety
            // property for quoted scalars: an unterminated quote can never
            // blank the rest of the file, it stops at the next key.
            if (line.trim() === "" || indent > bodyIndent) {
                out.push("");
                if (closingQuote !== null && closesQuotedScalar(line, closingQuote)) {
                    bodyIndent = null;
                    closingQuote = null;
                }
                continue;
            }
            bodyIndent = null;
            closingQuote = null;
        }

        out.push(line);

        const block = /^(\s*)(?:-\s+)?([A-Za-z0-9_.-]+):\s*[|>][-+0-9]*\s*$/.exec(line);
        if (block && !isShellKey(block[2])) {
            bodyIndent = (block[1] ?? "").length;
            continue;
        }

        // A quoted scalar left open at end of line continues on the following
        // lines, and YAML folds them into one string -- so a `run:` sitting
        // there is prose, exactly as if it were in a block scalar.
        const quoted = /^(\s*)(?:-\s+)?([A-Za-z0-9_.-]+):\s*(['"])(.*)$/.exec(line);
        if (quoted && !isShellKey(quoted[2]) && !closesQuotedScalar(quoted[4] ?? "", quoted[3] ?? "")) {
            bodyIndent = (quoted[1] ?? "").length;
            closingQuote = quoted[3] ?? null;
        }
    }

    return out.join("\n");
}

/**
 * True when a filename is a YAML file.
 *
 * Spelled once because it was previously spelled twice -- once for the scanned
 * roots and once for the closure walk. Identical then, and the two are the
 * enumeration and the check that certifies the enumeration is complete: if
 * they ever drifted, the walk would decline to consider a file the collector
 * reads, or claim one it never could, and either way the disagreement is
 * between two things whose whole purpose is to be compared.
 */
export function isYamlFile(name: string): boolean {
    return /\.ya?ml$/i.test(name);
}

/**
 * True when a mapping key introduces a shell step this guard reads.
 *
 * Derived from {@link SHELL_STEP_KEYS}, the same list the collector's regex is
 * built from. `powershell`/`pwsh` are deliberately absent: `pipefail` is a
 * bash option and means nothing there, so a PowerShell body is not shell code
 * *for this guard's purposes*. Measured -- the repo contains no such step
 * today, so the narrowing is inert.
 */
export function isShellKey(key: string | undefined): boolean {
    return (SHELL_STEP_KEYS as readonly string[]).includes((key ?? "").toLowerCase());
}

/**
 * Every pattern any guard in this directory reads, and therefore the definition
 * of "a file the guards must be able to see".
 *
 * A new guard reading something new belongs here. That is not tidiness: while
 * this was a single shell-step pattern, the closure check silently certified
 * scope for the `GitHubComment@0` guard, whose subject needs no shell step --
 * so a file holding only an unguarded comment task was invisible to the guard
 * *and* to the check that exists to prove nothing is invisible.
 */
export const SUBJECT_PATTERNS = [SHELL_STEP_KEY, GITHUB_COMMENT_TASK];

/**
 * True when any single line of `text` matches `pattern`.
 *
 * Rebuilds the pattern with `m` while carrying its existing flags through.
 * Spelled once because the obvious inline form -- `new RegExp(p.source, "m")`
 * -- silently drops the `i`, restoring case-sensitive matching at one call site
 * while the exported constant still reads as case-insensitive.
 *
 * Exported because the failure it prevents is not hypothetical and not local:
 * `pipeline-master-gating.test.ts` matched `GITHUB_COMMENT_TASK` with a bare
 * `.test(body)`, and since the constant is anchored `^...$` with no `m`, it
 * could not match any body longer than that single line. The marker was dead
 * for the whole of that file's life. Any consumer of an anchored pattern from
 * here needs this, so it travels with them.
 */
export function matchesAnyLine(pattern: RegExp, text: string): boolean {
    return new RegExp(pattern.source, `${pattern.flags.replace("m", "")}m`).test(text);
}

/**
 * Every YAML file in the repository carrying a shell step, found by walking the
 * tree rather than by trusting a path convention.
 *
 * Keyed on {@link SHELL_STEP_KEY} -- the guard's actual subject -- rather than
 * on what a CI file looks like. That distinction is the whole point and it was
 * learned the expensive way, twice.
 *
 * The first version matched Azure list items only, and returned 9 files while a
 * tenth sat in `.github/workflows/`: Actions steps lead with `- name:` and put
 * `run:` on a following line with no dash, so a list-item pattern cannot see
 * them. The fix at the time was to add `runs-on:` as a second marker, which
 * restored the count and left the real defect in place -- the predicate still
 * described *shapes of file* rather than *files containing the thing being
 * guarded*.
 *
 * The difference is not theoretical. A composite action
 * (`.github/actions/*&#47;action.yml`) carries `run:` steps, has no `runs-on:`
 * and no Azure list items, and so matched neither marker. Verified by
 * injection: a composite action with an unguarded `tsc --noEmit | sed ...` step
 * left discovery reporting 10 files and the whole suite green. An entire class
 * of file could hold the exact defect this module exists to catch and be
 * invisible to both the collector and the check that certifies the collector's
 * scope.
 *
 * The previous comment defended the narrow predicate on the grounds that
 * matching a bare `script:` or `run:` "would pull in unrelated YAML and turn
 * the closure check into one that misfires on valid files." That was a
 * prediction, and it was never measured. Measured now: across every tracked
 * YAML file in the repo, this predicate selects exactly the ten CI files and
 * nothing else -- `pnpm-lock.yaml`, `config/browserstack.yml` and the issue
 * template are all rejected, as are the remaining tracked YAML files. The fear
 * was reasonable and simply false here, and it cost a real hole to hold onto.
 *
 * If a future non-CI file does trip it, the failure is legible -- the closure
 * check names the file and someone adjusts the scope. That is strictly better
 * than the alternative it replaced, where the miss is silent and the guard
 * reports success.
 *
 * The predicate is the *union of what the guards actually read*, not a single
 * notion of "CI file". That distinction is the second half of the same lesson.
 * Keyed on shell steps alone, this function certified scope for the
 * `GitHubComment@0` guard too -- whose subject needs no shell step at all.
 * Verified by injection: a file containing nothing but an unguarded comment
 * task left discovery reporting 10 and all 50 tests green, while the failure
 * message claimed to speak for "every guard built on it".
 *
 * A closure check that examines part of its subject and reports on all of it is
 * worse than none, because it converts an unknown gap into a believed-closed
 * one. So every clause predicate belongs in {@link SUBJECT_PATTERNS}, and
 * adding a guard that reads something new means adding its pattern here -- the
 * check and the thing it certifies are then the same code and cannot drift by
 * category.
 *
 * `root` exists for one reason: every in-scope file in this repo is `.yml`, so
 * narrowing the walk's extension test is inert against real files and no
 * assertion over the real tree can detect it. A caller-supplied fixture tree is
 * the only subject that can tell whether this function still asks
 * {@link isYamlFile} or has quietly inlined something narrower. Production
 * callers pass nothing and get the repo.
 */
export function pipelineFilesInRepo(root: string = repoRoot): string[] {
    const found: string[] = [];

    const walk = (dir: string): void => {
        for (const entry of readdirSync(dir)) {
            const full = join(dir, entry);
            if (statSync(full).isDirectory()) {
                if (isWalkableDir(entry)) {
                    walk(full);
                }
                continue;
            }
            if (!isYamlFile(entry)) {
                continue;
            }
            const text = stripNonShellMultilineScalars(readFileSync(full, "utf8"));
            if (SUBJECT_PATTERNS.some((pattern) => matchesAnyLine(pattern, text))) {
                found.push(relative(root, full));
            }
        }
    };

    walk(root);
    return found.sort();
}
