import { readFileSync, readdirSync, statSync } from "fs";
import { join, relative } from "path";

export const repoRoot = join(__dirname, "..", "..", "..");

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
            if (!/\.ya?ml$/.test(name)) {
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
 */
export const SHELL_STEP_KEY = /^(\s*)(?:-\s+)?(?:script|bash|run):(.*)$/i;

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
 */
function matchesAnyLine(pattern: RegExp, text: string): boolean {
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
 */
export function pipelineFilesInRepo(): string[] {
    const skip = new Set(["node_modules", ".git", "dist", "build", "coverage", ".vite", "lab"]);
    const found: string[] = [];

    const walk = (dir: string): void => {
        for (const entry of readdirSync(dir)) {
            if (skip.has(entry)) {
                continue;
            }
            const full = join(dir, entry);
            if (statSync(full).isDirectory()) {
                walk(full);
                continue;
            }
            if (!/\.ya?ml$/.test(entry)) {
                continue;
            }
            const text = readFileSync(full, "utf8");
            if (SUBJECT_PATTERNS.some((pattern) => matchesAnyLine(pattern, text))) {
                found.push(relative(repoRoot, full));
            }
        }
    };

    walk(repoRoot);
    return found.sort();
}
