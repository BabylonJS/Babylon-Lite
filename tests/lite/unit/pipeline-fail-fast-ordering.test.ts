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
 * The column a line's content starts at, counting `- ` sequence markers as
 * structure rather than as content.
 *
 * This distinction is the whole difficulty. In
 *
 *     - name: NODE_VERSION
 *       value: "20"
 *
 * the two keys are siblings, and measuring from the first non-space character
 * says the second is nested under the first. Measuring the dash as structure
 * puts them in the same column, which is what the parser does.
 */
function contentColumn(line: string): number {
    const m = /^(\s*)((?:-\s+)*)/.exec(line);
    return (m?.[1]?.length ?? 0) + (m?.[2]?.length ?? 0);
}

/** True for `key:` or `key: value` — a mapping entry rather than bare text. */
function isMappingEntry(content: string): boolean {
    return /^[^#\s][^:]*:(\s|$)/.test(content);
}

/**
 * Lines that open a nesting level the parser will refuse: a key whose scalar
 * value is already complete, followed by something indented under it.
 *
 * Every other clause in this file reads the pipeline as text, so a corruption
 * that leaves the step boundaries intact is invisible to all of them — the bad
 * line is simply absorbed into the surrounding step's body and the step list
 * comes back unchanged. Measured: inserting one over-indented key inside a step
 * leaves this file's six clauses green on a document PyYAML refuses to load.
 * The parse floors do not help; they catch a file that yielded *nothing*, and
 * this one yields exactly what it did before.
 *
 * The repo has no YAML parser to depend on and adding one to be checked against
 * would be a heavier commitment than the check earns, so this is deliberately
 * not a validator. It decides one class, and the boundaries come from a real
 * parser rather than from what looked right:
 *
 *     b: "x"  +  deeper `c: 1`   rejected      b: x  +  deeper `c: 1`   rejected
 *     b: "x"  +  deeper `more`   rejected      b: x  +  deeper `more`   ACCEPTED
 *     b: |    +  deeper `more`   accepted      b:    +  deeper `c: 1`   ACCEPTED
 *
 * A plain scalar may legally continue onto a deeper line; a quoted one may not,
 * and neither may take a mapping entry. An empty value and a block scalar both
 * open a level on purpose. Flagging only what the parser flags is the point —
 * a hand-rolled well-formedness rule that merely agrees with its author is the
 * thing this exists to catch.
 */
function malformedNestingIn(text: string): string[] {
    const lines = text.split("\n");
    const bad: string[] = [];

    for (const [i, line] of lines.entries()) {
        const content = line.slice(contentColumn(line));
        if (content.startsWith("#")) {
            continue;
        }
        const entry = /^([^:]+):(?:\s+(.*))?$/.exec(content);
        const value = entry?.[2]?.trim() ?? "";
        if (!value || value.startsWith("#") || /^[|>]/.test(value)) {
            continue;
        }

        const next = lines.slice(i + 1).find((l) => {
            const c = l.slice(contentColumn(l));
            return c.trim() !== "" && !c.startsWith("#");
        });
        // `next === undefined` is unreachable at runtime -- a key with a scalar
        // value that ends the file falls out on the column comparison instead,
        // and the specimen for that is in the table. It is kept because the
        // compiler requires it: removing it needs an `as string` to build, and
        // a conjunct with no separating input is a type obligation rather than
        // a branch. Pinned by tsc, stated here, not faked with a contrived arm.
        if (next === undefined || contentColumn(next) <= contentColumn(line)) {
            continue;
        }
        const quoted = /^["']/.test(value);
        if (quoted || isMappingEntry(next.slice(contentColumn(next)))) {
            bad.push(`line ${i + 1}: \`${line.trim()}\` is followed by the more-indented \`${next.trim()}\``);
        }
    }
    return bad;
}

/**
 * Shapes this predicate has to agree with the parser about, in both directions.
 *
 * Every verdict here was taken from PyYAML rather than from what looked right,
 * and the legal ones matter more than the illegal ones: they are the only thing
 * standing between this and a rule that flags valid pipelines. A mechanical
 * conjunct sweep found three of them missing — with no specimen for a
 * comment-only value, a block scalar holding `key: value` text, or a
 * whitespace-only line, the corresponding tests could each be deleted with
 * nothing failing, because no input reached them.
 */
const NESTING_SPECIMENS: Array<{ label: string; yaml: string; illegal: boolean }> = [
    { label: "quoted value, then a deeper mapping entry", yaml: 'a:\n  b: "x"\n    c: 1\n', illegal: true },
    { label: "plain value, then a deeper mapping entry", yaml: "a:\n  b: x\n    c: 1\n", illegal: true },
    { label: "quoted value, then a deeper bare word", yaml: 'a:\n  b: "x"\n    more\n', illegal: true },
    { label: "sequence entry, then an over-indented sibling", yaml: "a:\n  - name: N\n      value: V\n", illegal: true },
    { label: "quoted value, a comment, then a deeper entry", yaml: 'a:\n  b: "x"\n  # note\n    c: 1\n', illegal: true },

    { label: "plain value continued on a deeper line", yaml: "a:\n  b: x\n    more\n", illegal: false },
    { label: "block scalar holding deeper text", yaml: "a:\n  b: |\n    more\n", illegal: false },
    { label: "block scalar holding `key: value` text", yaml: "a:\n  b: |\n    c: 1\n", illegal: false },
    { label: "empty value opening a nested mapping", yaml: "a:\n  b:\n    c: 1\n", illegal: false },
    { label: "comment-only value opening a mapping", yaml: "a:\n  b: # note\n    c: 1\n", illegal: false },
    { label: "sequence entry and its sibling key", yaml: "a:\n  - name: N\n    value: V\n", illegal: false },
    { label: "a whitespace-only line before a sibling", yaml: 'a:\n  b: "x"\n    \n  c: 1\n', illegal: false },
    { label: "a scalar key as the final line", yaml: 'a:\n  b: "x"\n', illegal: false },
];

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

/** Heading of the TESTING.md section the allowance is bound to. */
const ALLOWANCE_HEADING = "### Fail-Fast Ordering in the Bundle-Manifest Pipeline";

/**
 * The allowance section's body, bounded by the next heading.
 *
 * Every caller depends on this slice being the right region, and nothing a
 * caller asserts can tell that it is not -- they all ask whether some string is
 * present, and a slice that has grown contains strictly more strings. The
 * region is floored once, by its own clause, rather than by each reader.
 */
function allowanceSection(): string {
    const doc = readFileSync(join(repoRoot, "TESTING.md"), "utf8");
    const start = doc.indexOf(ALLOWANCE_HEADING);
    const end = doc.indexOf("\n### ", start + ALLOWANCE_HEADING.length);

    return start < 0 || end < 0 ? "" : doc.slice(start + ALLOWANCE_HEADING.length, end);
}

describe("the baseline pipeline validates its deploy configuration before doing expensive work", () => {
    it("agrees with a real parser about what is nested and what is merely indented", () => {
        const wrong = NESTING_SPECIMENS.filter(({ yaml, illegal }) => malformedNestingIn(yaml).length > 0 !== illegal).map(
            ({ label, illegal }) => `${illegal ? "missed" : "wrongly flagged"}: ${label}`
        );

        expect(
            wrong,
            `the nesting rule disagrees with the parser on:\n  ${wrong.join("\n  ")}\n\n` +
                `The legal specimens are the load-bearing half — without them this rule can be tightened into one that rejects valid pipelines and nothing here would notice.`
        ).toEqual([]);

        // A rule that only ever refuses is trivially "safe" and useless, so pin
        // that both verdicts are actually reachable from this table.
        expect(NESTING_SPECIMENS.some(({ illegal }) => illegal)).toBe(true);
        expect(NESTING_SPECIMENS.some(({ illegal }) => !illegal)).toBe(true);
    });

    it("reads a pipeline the parser would accept, not merely one that splits into steps", () => {
        const text = readFileSync(join(repoRoot, pipelineFile), "utf8");
        const bad = malformedNestingIn(text);

        expect(
            bad,
            `${pipelineFile} nests a line under a key that already holds a scalar, so Azure DevOps will refuse to queue it:\n  ${bad.join("\n  ")}\n\n` +
                `Every other clause here reads this file as text and would pass anyway — the bad line is absorbed into a step body and the step list comes back unchanged. Fix the indentation; do not relax this to make a probe green.`
        ).toEqual([]);
    });

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

    it("can locate a bounded allowance section in TESTING.md", () => {
        // Split from the binding below, which used to be one test carrying five
        // assertions. Two questions -- *can this check see its subject* and *is
        // the allowance justified* -- and a control could only ever name the
        // test, never which of them had answered.
        //
        // Everything here is about the region, because the region was the
        // defect. The binding located the section with indexOf and a split on
        // the next heading, and every assertion it made was a `contains`: each
        // one gets *easier* as the slice grows. Measured -- change the following
        // heading from `###` to `####`, an edit about a different section, and
        // the slice runs to end of file; a prerequisite named `PERF_FRAMES` was
        // then "documented" by the variable list two sections further down.
        // Five passed.
        //
        // A presence floor is monotone in the wrong direction: it can see the
        // region become empty and never see it become wrong.
        const doc = readFileSync(join(repoRoot, "TESTING.md"), "utf8");
        const occurrences = doc.split(ALLOWANCE_HEADING).length - 1;

        expect(
            occurrences,
            `TESTING.md contains ${occurrences} copies of "${ALLOWANCE_HEADING}". The binding below reads the first, so a second one makes which text is authoritative depend on document order.`
        ).toBe(1);

        const start = doc.indexOf(ALLOWANCE_HEADING);
        const end = doc.indexOf("\n### ", start + ALLOWANCE_HEADING.length);

        expect(
            end,
            `"${ALLOWANCE_HEADING}" is not followed by another \`###\` heading, so its section is bounded only by the end of the file and absorbs everything after it. That makes the binding below satisfiable by text with nothing to do with the allowance. Restore the following heading rather than relaxing this.`
        ).toBeGreaterThan(start);

        const body = doc.slice(start + ALLOWANCE_HEADING.length, end);

        // The upper bound, and it is a property rather than a length: a section
        // that has swallowed its neighbour contains that neighbour's heading. It
        // tightens exactly as the region widens, which is what the `contains`
        // assertions below cannot do.
        expect(
            body.match(/^#{1,6} /m) ?? [],
            `the allowance section contains a further markdown heading, so the slice has grown past the section it names and the checks below are reading someone else's text.`
        ).toEqual([]);

        // Was `length > 200`. Two things wrong with it, and the second is why
        // it is gone rather than tuned. Nothing entailed 200 -- the section is
        // 1417 characters, so the bar was whatever looked generous when it was
        // written. And it caught nothing its neighbour missed: emptying the body
        // fires the binding below as well, because the prerequisite stops being
        // named. A number that is neither derived nor load-bearing.
        //
        // What it was standing in for is that the section has substance, and
        // that is checkable per entry instead of in aggregate. See the reason
        // assertion in the binding below, which fires on the case a length floor
        // is blind to: an entry added to an already-long section with no reason
        // attached to it.
        expect(body.trim(), `"${ALLOWANCE_HEADING}" is present but empty, so the binding below would pass on an absent list`).not.toBe("");
        expect(body, `"${ALLOWANCE_HEADING}" no longer names the check it is about, so it is documenting something else`).toContain(PREFLIGHT_STEP);
    });

    it("documents the allowance in a file the constant cannot edit", () => {
        // The pin above makes widening CHECK_PREREQUISITES cost three edits --
        // but all three are in this file, so one diff in one artifact carries
        // the whole decision. The mechanical test for whether a binding binds is
        // "can one edit reach both sides", and constant-plus-its-own-comment
        // fails it: the reason travels with the change that needs justifying.
        //
        // TESTING.md cannot be edited by editing this constant, which is the
        // entire point. Widening the allowance has to land in prose, in the same
        // review, next to the paragraph explaining why the check exists.
        //
        // Claimed more than that once, and the archaeology withdrew it: on
        // origin/master TESTING.md says nothing about ordering or cost, and the
        // pipeline has no "Check deploy configuration" step at all. Both sides
        // of this binding were written in this PR, and `bd71f2a7` touched both
        // in one commit. So one *edit* cannot reach both sides, but one *commit*
        // can. What this buys is that the justification lands on a surface
        // contributors read for CI behaviour -- not that the second artifact is
        // independent testimony, which it is not.
        //
        // What does hold, and it is structural rather than a property of the
        // wording: this constant is an *allowance*, not an enumeration. It
        // exempts steps from a rule stated over the pipeline, so emptying both
        // sides of the correspondence cannot make it vacuous the way emptying
        // two enumerated lists would -- the complement is real, and the
        // universal clause reads it off the YAML. Measured, both sides emptied:
        // the universal fires because `checkout` is no longer permitted, and
        // the parse floor fires because the list is gone. Taken to its end, the
        // chain has to delete `checkout` from the pipeline as well, and then
        // dies at the parse floor with no repair that is not visibly false.
        //
        // A deliberately low bar: it asks that the step be named there, not that
        // the reason be good. It cannot judge cost -- nothing here can -- it
        // just refuses to let the exemption be granted silently in a file only
        // this test reads. The clause above is what keeps this one honest.
        const body = allowanceSection();

        // Parsed as a list rather than searched as a substring. `includes` is
        // satisfied by the name appearing anywhere in the section -- including
        // in the prose that says the step runs *after* the check, which is the
        // opposite claim.
        const listed = [...body.matchAll(/^- `([^`]+)`/gm)].map(([, name]) => name ?? "");

        expect(
            listed.length,
            `no \`- \\\`name\\\`\` bullets parsed out of ${ALLOWANCE_HEADING}, so both directions below compare against an empty list and agree with anything`
        ).toBeGreaterThan(0);

        const undocumented = CHECK_PREREQUISITES.filter(({ name }) => !listed.includes(name)).map(({ name }) => name);

        expect(
            undocumented,
            `steps allowed to run before "${PREFLIGHT_STEP}" that TESTING.md does not mention under ${ALLOWANCE_HEADING}. Add them there, with the reason, in this same change -- the allowance is meant to be readable by someone reviewing the pipeline rather than this test.`
        ).toEqual([]);

        // Naming an entry is not documenting it. A section long enough to look
        // substantial can gain one more bullet that is just a name, and both
        // the assertion above and any floor on the section's total length pass
        // -- the section did not get shorter.
        //
        // The bar is the name's own length, so it is derived from the entry
        // rather than chosen, and a longer name cannot buy a lower one. Stated
        // as a residual: this measures that a reason was written, never that it
        // is a good one. That judgement is the reviewer's, which is the whole
        // reason the allowance was pushed into prose in the first place.
        const unreasoned = CHECK_PREREQUISITES.filter(({ name }) => {
            const bullet = body.split("\n").find((l) => l.includes(name)) ?? "";
            return bullet.replace(name, "").replace(/[^A-Za-z]+/g, "").length < name.replace(/[^A-Za-z]+/g, "").length;
        }).map(({ name }) => name);

        expect(
            unreasoned,
            `TESTING.md names these steps under ${ALLOWANCE_HEADING} but gives no reason beside them. The list is the part a reviewer reads to decide whether the exemption is justified; a bare name moves the decision back into the constant this section exists to take it out of.`
        ).toEqual([]);

        // The other direction, which had no voice at all. This clause iterated
        // the constant and asked the document about each entry, so the document
        // was only ever consulted about names the constant already had -- a
        // check derived from the thing it is meant to pin.
        //
        // Measured: add `Install dependencies` to the list in TESTING.md and
        // touch no code, and six tests pass. The document then tells a reviewer
        // that installing dependencies ahead of the check is permitted, in the
        // same section whose prose says dependency installation runs after it,
        // and the guard grants no such thing. The reviewer-facing half of this
        // binding was handing out exemptions nothing read.
        const ungranted = listed.filter((name) => !CHECK_PREREQUISITES.some((entry) => entry.name === name));

        expect(
            ungranted,
            `TESTING.md lists these steps under ${ALLOWANCE_HEADING} as permitted to run before "${PREFLIGHT_STEP}", but the ordering check does not permit them. The document is the half a reviewer reads, so a name here is an exemption whether or not the constant agrees. Either add them to CHECK_PREREQUISITES in this file, with a reason, or take them out of the list.`
        ).toEqual([]);

        // A step cannot be both the work the check stands in front of and a
        // thing permitted to run before it. Independent of the region checks:
        // this one fails on a section that is the right size and says the wrong
        // thing.
        const contradicted = GATED_STEPS.filter((name) => body.includes(name));

        expect(
            contradicted,
            `the allowance section names work that "${PREFLIGHT_STEP}" exists to stand in front of. A step cannot be both gated and permitted ahead of the gate; one of the two claims is wrong.`
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
