import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

const repoRoot = join(__dirname, "..", "..", "..");
const pipelineFile = "azure-pipelines-bundle-manifest.yml";

/**
 * The master bundle-size baseline pipeline measures 245 scenes before it
 * publishes anything, which is roughly half an hour of work. Its first master
 * run spent all of it and then failed at the publish step, because the deploy
 * configuration it needed was never going to resolve.
 *
 * The repair was a cheap configuration check placed ahead of the expensive
 * work. That ordering is the entire value of the repair, and it is an *absence*
 * claim -- "no expensive step runs before the configuration is known good" --
 * so every signal stays green when it is violated. Deleting the check outright
 * was measured against the full unit suite and reported 1998 passed.
 *
 * Reordering YAML steps also never reads as a regression in review, and the
 * failure it reintroduces is not a broken build but a slow one, which is the
 * failure mode least likely to be attributed to the change that caused it.
 */

/**
 * Anchors, deliberately by display name.
 *
 * These couple this guard to two strings in the pipeline. That is the intended
 * trade: the alternative is inferring which step is "expensive", which needs a
 * cost model rather than a predicate, and a guard that guesses at cost is one
 * that argues with its reader. The cardinality assertions below turn a rename
 * into a failure that names the constant to re-point, rather than a silent
 * match against nothing.
 */
const PREFLIGHT_STEP = "Check deploy configuration";
const PUBLISH_STEP = "Publish bundle-size baseline";

/**
 * The steps the check exists to stand in front of, named.
 *
 * This is deliberately a fixed list where the clause above is a universal, and
 * the pair is non-subsuming in both directions -- measured, not assumed. The
 * universal catches an expensive step this file has never heard of; it cannot
 * catch one smuggled past by widening CHECK_PREREQUISITES, because that edit
 * makes the universal true. This list catches exactly that, because it is not
 * expressed in terms of the allowance and no edit to the allowance reaches it.
 *
 * Naming the scene build a "prerequisite" and moving it ahead of the check was
 * measured: with only the universal, the guard reported 2 passed while the
 * pipeline spent half an hour before learning it could not publish.
 */
const GATED_STEPS = ["Build bundle scenes", PUBLISH_STEP];

/** Leading-whitespace width, used to compare YAML nesting levels. */
function indentOf(line: string): number {
    return line.length - line.trimStart().length;
}

/**
 * The `steps:` list of the pipeline, in order, each entry as its raw block.
 *
 * The repo has no YAML parser among its dependencies and its sibling pipeline
 * guards all read lines, so this does too. It was validated against a real
 * parse rather than assumed: both report 9 steps in the same order for this
 * file, checkout first.
 */
function pipelineSteps(): string[] {
    const lines = readFileSync(join(repoRoot, pipelineFile), "utf8").split("\n");
    const stepsAt = lines.findIndex((l) => /^\s*steps:\s*$/.test(l));
    expect(stepsAt, `${pipelineFile} declares no \`steps:\` block — re-point this guard rather than deleting it`).toBeGreaterThanOrEqual(0);

    const parentIndent = indentOf(lines[stepsAt] ?? "");
    const steps: string[] = [];
    let itemIndent: number | null = null;
    let current: string[] | null = null;

    for (const line of lines.slice(stepsAt + 1)) {
        const indent = indentOf(line);
        if (line.trim() && indent <= parentIndent) {
            break;
        }
        if (line.trim() && line.trimStart().startsWith("- ")) {
            itemIndent ??= indent;
            if (indent === itemIndent) {
                if (current) {
                    steps.push(current.join("\n"));
                }
                current = [line];
                continue;
            }
        }
        current?.push(line);
    }
    if (current) {
        steps.push(current.join("\n"));
    }

    // Without this the clauses below are satisfied by a file the parser failed
    // to read: "no expensive step precedes the check" is trivially true of an
    // empty list, and that is the same silence this guard exists to break.
    expect(steps.length, `parsed no steps out of ${pipelineFile} — the assertions below would be vacuous`).toBeGreaterThan(0);
    return steps;
}

/** The index of the single step carrying `displayName`, asserted to be unique. */
function stepIndex(steps: string[], displayName: string): number {
    const matches = steps.map((s, i) => (s.includes(displayName) ? i : -1)).filter((i) => i !== -1);
    expect(
        matches,
        `expected exactly one step named "${displayName}" in ${pipelineFile}. If it was renamed, re-point this guard's anchor rather than deleting the guard; if it was removed, the fail-fast ordering it protects is gone.`
    ).toHaveLength(1);

    const [index] = matches;
    if (index === undefined) {
        throw new Error(`no step named "${displayName}" in ${pipelineFile}`);
    }
    return index;
}

/** The `env:` keys a step block declares. */
function envKeys(step: string): string[] {
    const lines = step.split("\n");
    const envAt = lines.findIndex((l) => /^\s*env:\s*$/.test(l));
    if (envAt === -1) {
        return [];
    }
    const indent = indentOf(lines[envAt] ?? "");
    const keys: string[] = [];
    for (const line of lines.slice(envAt + 1)) {
        if (!line.trim()) {
            continue;
        }
        if (indentOf(line) <= indent) {
            break;
        }
        const key = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*:/.exec(line)?.[1];
        if (key) {
            keys.push(key);
        }
    }
    return keys;
}

/**
 * Steps the configuration check itself depends on, and which may therefore run
 * before it.
 *
 * This is the escape hatch, and it is a named constant rather than an inline
 * pattern because the alternative was measured and is worse. With the allowance
 * inlined, a step that legitimately precedes the check -- `UseNode@1` ahead of a
 * check that had grown to need Node -- produced a failure offering two repairs,
 * *both* of which break the check: move it below, or move the check above it.
 * The true third state, "this is a prerequisite", had no reachable repair, and a
 * guard whose advice cannot be followed gets deleted rather than obeyed.
 *
 * Widening this list is a real decision with a cost: anything named here runs
 * before the build knows it can publish, so it must be cheap. That sentence
 * used to be the whole bound, and prose is not a bound. Measured: a new
 * expensive step ahead of the check fires the universal clause below, whose
 * remedy offers this list -- and following that remedy exactly as written gave
 * 3 passed, with the step permanently ahead of the check and the named clause
 * unable to see it, because it has never heard of it. One edit from a repair to
 * a blind spot. The pin below is what makes widening cost two edits and a
 * stated reason instead.
 */
const CHECK_PREREQUISITES: { name: string; why: string; matches: (step: string) => boolean }[] = [
    {
        name: "checkout",
        why: "the repository has to be present before any step can run, and fetching it tells the build nothing about whether it can publish",
        matches: (s) => /^\s*-\s*checkout:/m.test(s),
    },
];

/**
 * The allowance, pinned.
 *
 * This is not a cost check -- nothing in the pipeline says how long a step takes
 * -- and it does not pretend to be one. It exists so that opening the escape
 * hatch cannot be done by following a failure message. A reader who widens
 * CHECK_PREREQUISITES to silence the universal clause lands here instead, with
 * the consequence spelled out, and has to decide rather than comply.
 */
const PINNED_PREREQUISITES = ["checkout"];

describe("the baseline pipeline validates its deploy configuration before doing expensive work", () => {
    it("runs nothing but the check's own prerequisites before the deploy configuration check", () => {
        // Stated as a universal over the preceding steps rather than as a list
        // of the steps known to be expensive today. A named list would have to
        // grow every time the pipeline does, and would be silent in exactly the
        // case worth catching: a new expensive step inserted ahead of the check.
        //
        // The partition is over the input -- a preceding step either is one of
        // the check's prerequisites or it is work the check exists to gate --
        // rather than over what this guard happens to recognise. An acceptance
        // set the guard defines drifts as the pipeline grows spellings; a
        // property of the input does not.
        const steps = pipelineSteps();
        const preflight = stepIndex(steps, PREFLIGHT_STEP);

        const before = steps.slice(0, preflight).filter((s) => !CHECK_PREREQUISITES.some(({ matches }) => matches(s)));
        expect(
            before,
            `steps run before "${PREFLIGHT_STEP}" in ${pipelineFile} that are not among its prerequisites (${CHECK_PREREQUISITES.map(({ name }) => name).join(", ")}). This pipeline measures 245 scenes, so anything ahead of the configuration check is time spent before the build knows it can publish. Two repairs, and which one applies depends on the step: if it is work the check exists to gate, move it below the check — this is the right answer for anything that builds, installs, or measures. If the check genuinely depends on it, add it to CHECK_PREREQUISITES and to PINNED_PREREQUISITES, with a stated reason. Note what the second repair costs: a step listed there is no longer watched by this clause, so choosing it for expensive work buys silence rather than safety.`
        ).toEqual([]);
    });

    it("keeps the check ahead of the work it gates, by name", () => {
        // Independent of CHECK_PREREQUISITES on purpose. The clause above is
        // stated in terms of the allowance, so widening the allowance satisfies
        // it -- that is what an escape hatch does. This clause never consults
        // the allowance, so no edit to it can buy silence here.
        //
        // The cost bound the allowance's comment describes ("only if it is
        // cheap") is not derivable from this file: nothing in the YAML says how
        // long a step takes. So rather than infer cost, this names the steps
        // whose cost is the reason the check exists, and requires the check to
        // precede them. Residual, stated: a step expensive in a way this list
        // has not learned is covered only by the universal above.
        const steps = pipelineSteps();
        const preflight = stepIndex(steps, PREFLIGHT_STEP);

        const ahead = GATED_STEPS.filter((name) => stepIndex(steps, name) < preflight);
        expect(
            ahead,
            `these steps run before "${PREFLIGHT_STEP}" in ${pipelineFile}. They are the work the check exists to stand in front of, so running them first restores the failure this ordering removed: half an hour of measurement before the build learns it cannot publish. Move the check back above them. Adding them to CHECK_PREREQUISITES does not resolve this — it is what this clause is here to refuse.`
        ).toEqual([]);
    });

    it("keeps the prerequisite allowance pinned, so widening it is a decision rather than a repair", () => {
        // Deliberately a fixed list, which every other clause in this file
        // avoids being. The reasoning that rejects fixed lists elsewhere is
        // that the subject grows legitimately; this list is not the subject,
        // it is the exemption from it, and an exemption that grows quietly is
        // the whole defect. Here the fixed shape is the point.
        //
        // Residual, stated: this does not detect cost and cannot. A reader who
        // updates both lists and writes a reason has widened the hatch, and
        // that is allowed -- the aim is that they did it on purpose, having
        // read what it costs, rather than by doing what a failure told them to.
        expect(
            CHECK_PREREQUISITES.map(({ name }) => name),
            `the set of steps allowed to run before "${PREFLIGHT_STEP}" changed. If you are widening it to resolve a failure from the clause above, read that clause's second repair first: a step listed here stops being watched, so this is the right edit only for something genuinely cheap that the check depends on. If it is, update PINNED_PREREQUISITES to match and say why in the entry.`
        ).toEqual(PINNED_PREREQUISITES);

        expect(
            CHECK_PREREQUISITES.filter(({ why }) => why.trim().length === 0).map(({ name }) => name),
            `prerequisites with no stated reason. The reason is the only record of why a step is allowed to run before the build knows it can publish, and it is what the next reader needs to judge whether it still holds.`
        ).toEqual([]);
    });

    it("documents the allowance in a file the constant cannot edit", () => {
        // The pin above makes widening cost three edits -- but all three are in
        // this file, so one diff in one artifact carries the whole decision.
        // The mechanical test for whether a binding binds is "can one edit
        // reach both sides", and constant-plus-its-own-comment fails it: the
        // reason travels with the change that needs justifying.
        //
        // TESTING.md cannot be edited by editing this constant, which is the
        // entire point. Widening the allowance now has to land in prose, in the
        // same review, next to the paragraph explaining why the check exists.
        //
        // A deliberately low bar: it asks that the step be named there, not
        // that the reason be good. It cannot judge cost -- nothing here can --
        // it just refuses to let the exemption be granted silently in a file
        // only this test reads.
        const doc = readFileSync(join(repoRoot, "TESTING.md"), "utf8");
        const heading = "### Fail-Fast Ordering in the Bundle-Manifest Pipeline";
        const start = doc.indexOf(heading);

        expect(
            start,
            `${heading} is missing from TESTING.md. It is the second half of the prerequisite allowance: without it, widening CHECK_PREREQUISITES becomes a one-file decision again and this clause silently stops asking anything.`
        ).toBeGreaterThanOrEqual(0);

        const body = doc.slice(start + heading.length).split("\n### ")[0] ?? "";

        // Floors the section itself, not just its presence. A heading left in
        // place over an emptied body would satisfy every check below by
        // containing nothing to disagree with.
        expect(body.trim().length, `${heading} is present but empty, so the checks below would pass on an absent list`).toBeGreaterThan(200);
        expect(body, `${heading} no longer names the check it is about, so it is documenting something else`).toContain(PREFLIGHT_STEP);

        const undocumented = CHECK_PREREQUISITES.filter(({ name }) => !body.includes(name)).map(({ name }) => name);

        expect(
            undocumented,
            `steps allowed to run before "${PREFLIGHT_STEP}" that TESTING.md does not mention under ${heading}. Add them there, with the reason, in this same change — the allowance is meant to be readable by someone who is reviewing the pipeline rather than this test.`
        ).toEqual([]);
    });

    it("checks every deploy variable the publish step will read", () => {
        // Derived from the publish step rather than listed here, so a variable
        // added to the publish path later cannot arrive unchecked. The original
        // failure was exactly this shape: the publish step read a variable name
        // that nothing had established would resolve, and the build found out
        // after the expensive part.
        const steps = pipelineSteps();
        const checked = envKeys(steps[stepIndex(steps, PREFLIGHT_STEP)] ?? "");
        const needed = envKeys(steps[stepIndex(steps, PUBLISH_STEP)] ?? "");

        // Floor both sides. A step whose `env:` block stops parsing yields an
        // empty list, and "every needed variable is checked" is satisfied by
        // needing nothing -- the vacuous pass this file is here to prevent.
        expect(needed.length, `parsed no \`env:\` keys from "${PUBLISH_STEP}" — the subset assertion below would be vacuous`).toBeGreaterThan(0);
        expect(checked.length, `parsed no \`env:\` keys from "${PREFLIGHT_STEP}" — it would be checking nothing`).toBeGreaterThan(0);

        expect(
            needed.filter((k) => !checked.includes(k)),
            `variables read by "${PUBLISH_STEP}" that "${PREFLIGHT_STEP}" does not check in ${pipelineFile}. Add them to the check's \`env:\` block and to the names it validates, so a missing one fails in seconds rather than after the scenes are measured. If one of them is genuinely optional, wiring it into the check would make it required — say so where the check validates its names, and give this guard a reason to stop demanding it, rather than deleting the guard.`
        ).toEqual([]);

        // Residual, stated rather than implied. Every variable the publish step
        // reads today is required, so "checked" and "required" coincide and this
        // clause is exactly right. The first optional publish variable separates
        // them, and at that point the subset assertion is too strong: following
        // its advice would turn an optional variable into one whose absence
        // fails the build. There is no exemption mechanism here because there is
        // nothing to exempt; this comment is what the author of that variable
        // needs, and it is cheaper than machinery for a case that may not come.
    });
});
