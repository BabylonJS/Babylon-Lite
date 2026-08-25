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
 *
 * Being a fixed list, it empties. Measured: `GATED_STEPS = []` returned 10
 * passed -- every clause reading it iterates it, so an empty list asks nothing,
 * including the clause written to catch the case the universal cannot. Floored
 * where it is read.
 */
const GATED_STEPS = ["Build bundle scenes", PUBLISH_STEP];

/**
 * Commands that make a step expensive because of what they do, not because a
 * list says so.
 *
 * This is the floor under everything else here, and it exists because the rest
 * of the file can be honestly satisfied while the pipeline does exactly what
 * this PR was written to stop. Measured: move the check to just before the
 * publish step, add the seven steps that now precede it to the allowance,
 * update the pin, document all seven in TESTING.md, and drop the build from
 * `GATED_STEPS` because a step you have called a prerequisite is not one you
 * are still gating. Eight edits, each resolving a real failure, every artifact
 * agreeing with every other -- and every clause in this file green while the
 * pipeline spends half an hour before discovering it cannot publish.
 *
 * No clause had to be deleted to get there. That is the difference between a
 * guard with a weak floor and one with no terminal assertion at all, and it is
 * why this cannot be another hand-maintained list: the allowance, the pin,
 * `GATED_STEPS` and the documentation are all things a person writes, so a
 * capitulation can satisfy them by writing agreement everywhere. What a step
 * *runs* is not an assertion. Installing dependencies, downloading a browser
 * and building 245 scenes are expensive whatever any constant calls them, so
 * the check has to precede them for a reason no edit to this file can revoke.
 *
 * Deliberately narrow, and deliberately not the whole floor. These are the
 * commands whose cost is the reason the check exists, named so the failure can
 * say *why* a step is expensive. But a list of named commands is an enumeration,
 * and an enumeration goes vacuous: measured, `COSTLY_COMMANDS = []` returned
 * 10 passed, and re-pointing one entry from the 245-scene build to `corepack` --
 * a real step, so the reachability floor below is satisfied -- also returned
 * 10 passed, with the build no longer guarded by anything. Both are one edit in
 * this file.
 *
 * So the floor is not here. `packageManagerWork` derives the expensive set from
 * the pipeline instead, and this list only supplies the reason.
 */
const COSTLY_COMMANDS = [
    { pattern: /\bpnpm\s+install\b/, why: "installs the dependency tree" },
    { pattern: /playwright\s+install\b/, why: "downloads a browser" },
    { pattern: /\bbuild:bundle-scenes\b/, why: "measures every bundle scene" },
];

/**
 * Steps that invoke a package manager, derived from the pipeline text.
 *
 * The one description of "expensive" that no edit to this file can narrow,
 * empty or re-point. A step that runs `pnpm`, `npm` or `npx` is fetching or
 * building something; the three commands the incident was about are all in
 * here, and so is the next one, without anybody naming it.
 *
 * It is a proxy, not a measurement -- `pnpm --version` would be caught and is
 * not expensive. That direction is the safe one: it can demand the check move
 * earlier, never later.
 */
function packageManagerWork(steps: string[]): string[] {
    // Commands only. The first version tested the whole step, and a step's
    // `displayName` is prose: "Enable pnpm via corepack" made the corepack step
    // read as package-manager work, which is how a `COSTLY_COMMANDS` entry
    // re-pointed at `corepack` kept passing the check meant to catch it. A rule
    // about what a step runs must not read the sentence describing it.
    return steps.filter((s) =>
        s
            .split("\n")
            .filter((line) => !/^\s*(?:-\s*)?(?:displayName|name|condition|continueOnError|timeoutInMinutes|task|target):/.test(line))
            .some((line) => /\b(?:pnpm|npm|npx)\s+[a-z@]/i.test(line))
    );
}

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
/**
 * Whether a line's content opens a mapping entry — a key, then `:`, then a
 * space or end of line.
 *
 * The space is load-bearing: `echo two:three` and `http://x/y` contain colons
 * and are plain text to the parser, and both occur in script bodies. Relaxing
 * this to "a colon anywhere" makes the nesting rule reject legal pipelines;
 * there are specimens for both, taken from PyYAML.
 *
 * The `#` in the character class is unreachable from the sole call site, which
 * skips comment lines when choosing the following line, so no specimen exercises
 * it and none is manufactured to look as though one does. It stays because this
 * predicate is a general one — a comment is genuinely not a mapping entry — and
 * dropping it would quietly change the answer for any future caller that does
 * not filter first.
 */
function isMappingEntry(content: string): boolean {
    return /^[^#\s][^:]*:(\s|$)/.test(content);
}

/**
 * How much of a value lives on its own line, which is what decides whether a
 * deeper line under it is legal.
 *
 * The first version of this asked only `/^["']/` — "does the value start with a
 * quote" — and treated every such value as complete. A quote that *opens* on a
 * line and closes on a later one is a legal multi-line scalar, and the same goes
 * for `[`/`{` flow collections, so that rule reported five legal documents as
 * corrupt. All five were measured against PyYAML, not reasoned about:
 *
 *     b: "x  +  deeper `more"`        ACCEPTED, was flagged
 *     b: 'it''s  +  deeper `fine'`    ACCEPTED, was flagged
 *     b: {c: 1,  +  deeper `d: 2}`    ACCEPTED, was flagged
 *     b: [one,  +  deeper `c: 1]`     ACCEPTED, was flagged
 *     b: "http://x  +  deeper `/y"`   ACCEPTED, was flagged
 *
 * That is the direction worth guarding: a rule that misses a corruption gets
 * fixed, a rule that rejects a valid pipeline gets deleted. The scanner walks
 * the characters rather than matching a closing quote with a regex, because the
 * escapes are the whole difficulty — `''` inside a single-quoted scalar and `\"`
 * inside a double-quoted one are both content, and a regex looking for the next
 * quote reads the first half of a doubled apostrophe as the terminator.
 */
type ValueShape = "block" | "continuable" | "self-contained" | "plain";

function valueShape(value: string): ValueShape {
    if (/^[|>]/.test(value)) {
        return "block";
    }
    const opener = value[0];
    if (opener !== '"' && opener !== "'" && opener !== "[" && opener !== "{") {
        return "plain";
    }

    let quote: '"' | "'" | null = null;
    let depth = 0;
    for (let i = 0; i < value.length; i++) {
        const ch = value[i];
        if (quote === "'") {
            // No `''` case here on purpose. A doubled apostrophe is an escaped
            // one inside a single-quoted scalar, and the obvious handling — skip
            // the pair — was written first and then measured: it cannot change
            // an answer. Each apostrophe toggles this flag, so a pair toggles it
            // twice, and the only state this function reads is the flag's value
            // at end of line. A mutation arm removing the skip left all 31
            // specimens green, and a differential run over 400k generated values
            // found zero disagreements between the two versions.
            //
            // It would start to matter the moment this returns *where* the
            // scalar closed rather than whether it did, because the two versions
            // differ on the zero characters between the pair. Anyone making that
            // change has to put the pair back, and needs a specimen that can see
            // the difference — which is why this is a note and not a deletion in
            // silence.
            if (ch === "'") {
                quote = null;
            }
        } else if (quote === '"') {
            if (ch === "\\") {
                i++;
            } else if (ch === '"') {
                quote = null;
            }
        } else if (ch === '"' || ch === "'") {
            quote = ch;
        } else if (ch === "[" || ch === "{") {
            depth++;
        } else if (ch === "]" || ch === "}") {
            depth--;
        }
    }
    return quote !== null || depth > 0 ? "continuable" : "self-contained";
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
 * A plain scalar may legally continue onto a deeper line but may not take a
 * mapping entry; a value that is already closed — a terminated quote, a balanced
 * flow collection — may take neither. An empty value, a block scalar and a value
 * still open at end of line all own the lines under them on purpose. Flagging
 * only what the parser flags is the point —
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
        if (!value || value.startsWith("#")) {
            continue;
        }
        const shape = valueShape(value);
        if (shape === "block" || shape === "continuable") {
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
        if (shape === "self-contained" || isMappingEntry(next.slice(contentColumn(next)))) {
            bad.push(`line ${i + 1}: \`${line.trim()}\` is followed by the more-indented \`${next.trim()}\``);
        }
    }
    return bad;
}

/**
 * Shapes this predicate has to agree with the parser about, in both directions.
 *
 * Two columns, and they are not the same kind of claim. `parser` is PyYAML's
 * answer for that exact string, re-derived rather than recalled whenever the
 * table changes. `flags` is this rule's obligation: the 1-based lines its
 * failure must name. A specimen whose expected value is the author's reading is
 * the author's belief wearing the costume of a test, so the first column comes
 * from the oracle; the second cannot, because which line to blame for a
 * corruption is a design judgement no parser settles.
 *
 * The columns are bound by one rule, asserted below: `flags` may be non-empty
 * only where the parser rejects. The table is allowed to be incomplete in the
 * other direction — a row the parser rejects for a reason outside this rule's
 * one class carries an empty `flags` and says so — but it may never demand that
 * legal YAML be flagged.
 *
 * `flags` naming lines rather than a boolean is deliberate, and was measured:
 * with a `broken: boolean` column, reporting `line ${i + 99}`, replacing the
 * whole message with `something is wrong somewhere`, and reporting only the
 * first corruption in a document all left this file 10/10 green. The message is
 * the entire value of this guard on a 400-line pipeline, and a boolean column
 * cannot read it.
 *
 * The legal rows matter more than the illegal ones: they are the only thing
 * standing between this and a rule that flags valid pipelines. Five of them were
 * added after the rule was caught doing exactly that.
 */
const NESTING_SPECIMENS: Array<{ label: string; yaml: string; parser: "accepts" | "rejects"; flags: number[] }> = [
    { label: "quoted value, then a deeper mapping entry", yaml: 'a:\n  b: "x"\n    c: 1\n', parser: "rejects", flags: [2] },
    { label: "plain value, then a deeper mapping entry", yaml: "a:\n  b: x\n    c: 1\n", parser: "rejects", flags: [2] },
    { label: "quoted value, then a deeper bare word", yaml: 'a:\n  b: "x"\n    more\n', parser: "rejects", flags: [2] },
    { label: "sequence entry, then an over-indented sibling", yaml: "a:\n  - name: N\n      value: V\n", parser: "rejects", flags: [2] },
    { label: "quoted value, a comment, then a deeper entry", yaml: 'a:\n  b: "x"\n  # note\n    c: 1\n', parser: "rejects", flags: [2] },

    { label: "plain value continued on a deeper line", yaml: "a:\n  b: x\n    more\n", parser: "accepts", flags: [] },
    { label: "block scalar holding deeper text", yaml: "a:\n  b: |\n    more\n", parser: "accepts", flags: [] },
    { label: "block scalar holding `key: value` text", yaml: "a:\n  b: |\n    c: 1\n", parser: "accepts", flags: [] },
    { label: "empty value opening a nested mapping", yaml: "a:\n  b:\n    c: 1\n", parser: "accepts", flags: [] },
    { label: "comment-only value opening a mapping", yaml: "a:\n  b: # note\n    c: 1\n", parser: "accepts", flags: [] },
    { label: "sequence entry and its sibling key", yaml: "a:\n  - name: N\n    value: V\n", parser: "accepts", flags: [] },
    { label: "a whitespace-only line before a sibling", yaml: 'a:\n  b: "x"\n    \n  c: 1\n', parser: "accepts", flags: [] },
    { label: "a scalar key as the final line", yaml: 'a:\n  b: "x"\n', parser: "accepts", flags: [] },

    // Command-shaped deeper lines. Every illegal row above uses a clean `c: 1`,
    // so nothing here reached the part of `isMappingEntry` that decides *what
    // counts as a key* -- and script bodies are where over-indentation actually
    // happens in this pipeline. Measured: relaxing that predicate to "a colon
    // anywhere" left all thirteen rows above green while the last two of these
    // became false positives on legal YAML.
    { label: "deeper line is a command containing `key: value`", yaml: "a:\n  b: echo one\n    echo two: three\n", parser: "rejects", flags: [2] },
    { label: "deeper line is a command ending in a colon", yaml: "a:\n  b: echo one\n    echo two:\n", parser: "rejects", flags: [2] },
    { label: "deeper line has a colon with no space after it", yaml: "a:\n  b: echo one\n    echo two:three\n", parser: "accepts", flags: [] },
    { label: "deeper line is a URL", yaml: "a:\n  b: echo one\n    http://x/y\n", parser: "accepts", flags: [] },
    { label: "deeper line is a sequence dash", yaml: "a:\n  b: echo one\n    - x\n", parser: "accepts", flags: [] },

    // Values that are still open at end of line. These are the five the rule was
    // measured getting wrong, plus the flow-sequence case it happened to get
    // right for the wrong reason -- `two]` has no colon, so the old rule was
    // silent by accident rather than by design.
    { label: "double-quoted scalar closed on the deeper line", yaml: 'a:\n  b: "x\n    more"\n', parser: "accepts", flags: [] },
    { label: "single-quoted scalar with a doubled apostrophe, closed on the deeper line", yaml: "a:\n  b: 'it''s\n    fine'\n", parser: "accepts", flags: [] },
    { label: "flow mapping spanning two lines", yaml: "a:\n  b: {c: 1,\n    d: 2}\n", parser: "accepts", flags: [] },
    { label: "flow sequence spanning two lines", yaml: "a:\n  b: [one,\n    two]\n", parser: "accepts", flags: [] },
    { label: "flow sequence whose deeper line is a mapping pair", yaml: "a:\n  b: [one,\n    c: 1]\n", parser: "accepts", flags: [] },
    { label: "quoted URL continued on the deeper line", yaml: 'a:\n  b: "http://x\n    /y"\n', parser: "accepts", flags: [] },
    { label: "folded block scalar holding `key: value` text", yaml: "a:\n  b: >\n    c: 1\n", parser: "accepts", flags: [] },

    // ...and the same values once they are closed, which is what makes the
    // distinction load-bearing rather than a blanket exemption for anything
    // holding a quote or a bracket.
    { label: "closed flow sequence, then a deeper bare word", yaml: "a:\n  b: [x]\n    more\n", parser: "rejects", flags: [2] },
    { label: "closed flow mapping, then a deeper mapping entry", yaml: "a:\n  b: {x: 1}\n    c: 1\n", parser: "rejects", flags: [2] },
    { label: "closed single-quoted scalar with a doubled apostrophe, then a deeper entry", yaml: "a:\n  b: 'it''s'\n    c: 1\n", parser: "rejects", flags: [2] },
    { label: "closed double-quoted scalar with an escaped quote, then a deeper entry", yaml: 'a:\n  b: "a\\"b"\n    c: 1\n', parser: "rejects", flags: [2] },

    // Two corruptions in one document. The only row where `flags` has a second
    // entry, and the only thing standing between this and a rule that reports
    // the first problem and stops.
    { label: "two corruptions in one document", yaml: 'a:\n  b: "x"\n    c: 1\n  d: "y"\n    e: 2\n', parser: "rejects", flags: [2, 4] },

    // Declared out of scope: the parser refuses this, and this rule is silent.
    // It decides one class -- a complete value with something nested under it --
    // and an unterminated scalar is a different defect. Recorded rather than
    // quietly omitted, so the gap is visible to whoever widens the rule next.
    { label: "unterminated quote running to end of file", yaml: 'a:\n  b: "x\n    more\n', parser: "rejects", flags: [] },
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
    it("grants the allowance to the steps it names and to nothing else", () => {
        // The name is not what exempts a step -- `matches` is. Everything else
        // binding this allowance compares names: the pin, the TESTING.md bullets,
        // the contradiction check below. All of them are satisfied by an entry
        // called `checkout` whose predicate quietly selects half the pipeline.
        //
        // Measured, at the committed parent: widen this one predicate to
        // /pnpm|checkout:/ and touch nothing else -- no doc edit, no new name,
        // no reordering -- and the file returns 9 passed. Every gated step is
        // then exempt from the universal clause, and the widening PR shows a
        // reviewer a green run. The damage surfaces only when someone later
        // moves work ahead of the check, and only for the three commands the
        // cost floor knows by name (verified: that state fails here, by name).
        // So the exploit was bounded and the widening was not visible at all.
        //
        // This clause asks what the predicate actually selects out of the real
        // steps, which is the one side of the allowance nobody writes.
        const steps = pipelineSteps();

        const problems = CHECK_PREREQUISITES.flatMap(({ name, matches }) => {
            const selected = steps.filter((s) => matches(s));

            // A predicate matching nothing exempts nothing, so every clause
            // about it passes forever while the entry sits here looking live.
            if (selected.length === 0) {
                return [`\`${name}\` matches no step in ${pipelineFile}, so the entry is dead and the name pins nothing`];
            }

            return selected.flatMap((step) => {
                const label =
                    /displayName:\s*(.+)/
                        .exec(step)?.[1]
                        ?.trim()
                        .replace(/^["']|["']$/g, "") ??
                    step.split("\n")[0]?.trim() ??
                    "?";
                const gated = GATED_STEPS.filter((g) => step.includes(g)).map(
                    () => `\`${name}\` exempts "${label}", which is work "${PREFLIGHT_STEP}" exists to stand in front of`
                );
                const costly = COSTLY_COMMANDS.filter(({ pattern }) => pattern.test(step)).map(
                    ({ why }) => `\`${name}\` exempts "${label}", which ${why} — the allowance is for cheap steps`
                );
                return [...gated, ...costly];
            });
        });

        expect(
            problems,
            `${problems.join("\n  ")}\n\n` +
                `A step is exempted by the predicate, not by the name beside it, so widening a predicate opens the hatch without touching any name this file or TESTING.md pins. Narrow it to the step it is named for.`
        ).toEqual([]);
    });

    it("keeps the check ahead of every step whose cost is the reason it exists", () => {
        const steps = pipelineSteps();
        const preflight = stepIndex(steps, PREFLIGHT_STEP);

        const expensive = steps.slice(0, preflight).flatMap((step) => {
            const named = COSTLY_COMMANDS.filter(({ pattern }) => pattern.test(step)).map(({ why }) => `a step that ${why} runs before "${PREFLIGHT_STEP}"`);

            // The named list supplies the reason; the derived set supplies the
            // floor. A step that invokes a package manager is doing the kind of
            // work this check exists to precede whether or not anyone has named
            // its command here -- and emptying or re-pointing COSTLY_COMMANDS,
            // both of which returned 10 passed before this line existed, cannot
            // take it out of the set.
            if (named.length > 0) return named;
            return packageManagerWork([step]).map(() => `a step invoking a package manager runs before "${PREFLIGHT_STEP}"`);
        });

        expect(
            expensive,
            `${expensive.join("\n  ")}\n\n` +
                `This cannot be resolved by widening the allowance, and that is the point — the allowance, the pin, GATED_STEPS and TESTING.md are all written by hand, so a capitulation can satisfy them all by writing agreement everywhere. What a step runs is not an assertion. Move the check back above this work.`
        ).toEqual([]);

        // Floored on the derived set, not on the named list. `absent` below asks
        // whether the *reasons* still describe the pipeline; this asks whether
        // the clause has any subject at all, and it is the assertion that
        // survives COSTLY_COMMANDS being emptied.
        expect(
            packageManagerWork(steps).length,
            `no step in ${pipelineFile} invokes a package manager, so this clause has nothing to order and passes whatever the pipeline does. Either the file stopped building anything, or the derivation stopped matching it.`
        ).toBeGreaterThan(0);

        // A rule that names nothing present in the pipeline floors nothing, so
        // pin that these commands are real: every one of them must appear
        // somewhere in the file, or this clause has quietly stopped applying.
        //
        // Not sufficient on its own, which is what the sweep found: re-pointing
        // `build:bundle-scenes` to `corepack` satisfies this -- corepack is a
        // real step -- while the 245-scene build loses its named guard. The
        // derived set is what keeps that case caught; this keeps the messages
        // honest.
        const absent = COSTLY_COMMANDS.filter(({ pattern }) => !steps.some((s) => pattern.test(s) && packageManagerWork([s]).length > 0));
        expect(
            absent.map(({ why }) => `no step ${why}`),
            `${pipelineFile} no longer runs commands this clause was written about, so it now floors nothing. Re-point it at what the pipeline actually does rather than deleting it.`
        ).toEqual([]);

        // The reasons are what the failure above says out loud, so an empty list
        // leaves the floor standing but the message mute. Cheap to state, and it
        // makes emptying the list a decision rather than a silent one.
        expect(
            COSTLY_COMMANDS.length,
            `COSTLY_COMMANDS is empty. The derived rule above still orders the pipeline, but no failure here can say why a step is expensive.`
        ).toBeGreaterThan(0);
    });

    it("names the lines a real parser would refuse, and none it would accept", () => {
        // The table may not ask for legal YAML to be flagged. This is a claim
        // about the specimens themselves rather than about the rule's output:
        // a fixture is the last thing that can certify a false positive, and it
        // does so silently, because every arm run against it agrees with it.
        const unsound = NESTING_SPECIMENS.filter(({ parser, flags }) => parser === "accepts" && flags.length > 0).map(({ label }) => label);
        expect(
            unsound,
            `these rows ask the nesting rule to flag documents the parser accepts:\n  ${unsound.join("\n  ")}\n\n` +
                `Re-derive the \`parser\` column from PyYAML before changing \`flags\` — a rule that rejects a valid pipeline gets deleted, not fixed.`
        ).toEqual([]);

        const disagreements: string[] = [];
        for (const { label, yaml, parser, flags } of NESTING_SPECIMENS) {
            const messages = malformedNestingIn(yaml);
            const at = messages.map((m) => Number(/^line (\d+):/.exec(m)?.[1] ?? -1));

            if (at.join(",") !== flags.join(",")) {
                const said = messages.length === 0 ? "says nothing" : `names lines [${at.join(", ")}]`;
                disagreements.push(`${parser === "accepts" ? "wrongly flagged" : "misreported"}: ${label} — the rule ${said}, expected [${flags.join(", ")}]`);
                continue;
            }
            // Reaching the right line number is not the same as saying so. The
            // failure has to quote the offending line, or the number is the only
            // thing a reader gets and it is unverifiable at the point of use.
            for (const n of flags) {
                const source = yaml.split("\n")[n - 1]?.trim() ?? "";
                if (!messages.some((m) => m.includes(source))) {
                    disagreements.push(`${label} — nothing in the failure quotes line ${n} (\`${source}\`)`);
                }
            }
        }

        expect(
            disagreements,
            `the nesting rule disagrees with the parser on:\n  ${disagreements.join("\n  ")}\n\n` +
                `The legal specimens are the load-bearing half — without them this rule can be tightened into one that rejects valid pipelines and nothing here would notice.`
        ).toEqual([]);

        // A rule that only ever refuses is trivially "safe" and useless, and one
        // that only ever accepts is inert, so pin that both are reachable from
        // this table — and that more than one line can be named at once, which
        // is what stops the rule from reporting the first problem and stopping.
        expect(NESTING_SPECIMENS.some(({ flags }) => flags.length > 0)).toBe(true);
        expect(NESTING_SPECIMENS.some(({ parser }) => parser === "accepts")).toBe(true);
        expect(NESTING_SPECIMENS.some(({ flags }) => flags.length > 1)).toBe(true);
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

        // Floor: this clause iterates GATED_STEPS, so an empty list checks
        // nothing while every other clause stays green -- measured, 10 passed.
        // The publish step is what the check protects by definition, and
        // PUBLISH_STEP is resolved against the pipeline by stepIndex, so
        // requiring it here cannot be satisfied by naming something imaginary.
        expect(
            GATED_STEPS,
            `GATED_STEPS no longer names the step this check exists to protect, so the one clause the allowance cannot silence has nothing left to check.`
        ).toContain(PUBLISH_STEP);

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
        // The bullet, taken from the parse rather than found by substring. This
        // used to be `body.split("\n").find((l) => l.includes(name))`, which
        // returns the *first* line mentioning the name -- and prose in this
        // section mentions these steps by name too. Measured: put a sentence
        // above the list that mentions `checkout`, reduce the bullet to a bare
        // `- \`checkout\``, and the reason check reads the prose line, finds
        // plenty of words, and passes. 9 passed with an undocumented entry.
        //
        // Same defect as the `listed` parse two assertions up, left in place
        // because I fixed the direction I was thinking about and not the
        // lookup feeding it.
        // The continuation is indented lines only. A first attempt took every
        // following line that did not start with `-` or `#`, which swallowed the
        // blank line and the paragraph *after* the list -- the bare-bullet arm
        // stayed green and I nearly filed the fix as working. A bullet body ends
        // at the first unindented line; anything looser reads the section's prose
        // as the entry's reason, which is the defect being fixed.
        const bulletBodies = new Map([...body.matchAll(/^- `([^`]+)`([^\n]*(?:\n[ \t]+\S[^\n]*)*)/gm)].map(([, name, rest]) => [name ?? "", rest ?? ""]));

        const unreasoned = CHECK_PREREQUISITES.filter(({ name }) => {
            const reason = bulletBodies.get(name) ?? "";
            return reason.replace(/[^A-Za-z]+/g, "").length < name.replace(/[^A-Za-z]+/g, "").length;
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
        // thing permitted to run before it.
        //
        // Residual, stated because the comment here used to claim more: this is
        // a lexical coincidence detector, not a reading of the section. It
        // compares ADO display names against prose that does not use them --
        // TESTING.md calls this work "the expensive work", "measures 245
        // scenes", "the publish step". Measured: a sentence granting the gated
        // build a place ahead of the check, written in the document's own
        // vocabulary, is 9 passed; the same sentence using the literal string
        // "Build bundle scenes" fires this assertion. So it catches the copy of
        // the name and misses the meaning, and the two artifacts' name spaces
        // are exactly why.
        //
        // Kept, because a bullet is where a real exemption goes and a bullet
        // does carry the literal name. The clause that does not depend on
        // anyone's vocabulary is the allowance-grant clause above, which asks
        // what the predicate selects out of the pipeline.
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
