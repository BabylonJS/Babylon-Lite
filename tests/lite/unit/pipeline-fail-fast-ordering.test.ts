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
 * A line whose first non-space character is `#`.
 *
 * Stripped from every derivation here that asks what a step *runs*, because a
 * comment is the one thing in a pipeline guaranteed not to run. #531's
 * qualifier applies and is why this is a function rather than a rule about the
 * file format: "descriptive" is relative to the predicate. `condition:` is
 * commentary about what a step runs and substance about whether a job is
 * gated; a comment is commentary for both questions, which is what makes it
 * safe to strip globally here.
 *
 * Both directions were live before this existed, measured:
 *
 *   a comment naming `pnpm build:bundle-scenes` inside the checkout step
 *     -> 2 clauses fire on a completely legal pipeline. That is the direction
 *        that gets a guard deleted rather than obeyed, and a comment is exactly
 *        what someone adds when explaining why a step sits where it does --
 *        this pipeline's own header already names that command in prose.
 *   the scene build replaced by `./scripts/measure.sh`, the old command left
 *   behind in a `# was:` comment
 *     -> 10 passed. The `absent` cross-check was satisfied by the comment while
 *        the pipeline had stopped running the command entirely.
 *   the check script's 46 body lines commented out, a live `exit 1` kept
 *     -> 10 passed, including the clause written last round to require the
 *        check to check. Same defect one clause over, which is the argument for
 *        sweeping siblings rather than fixing the instance in front of you.
 *
 * Leading `#` only. A trailing comment sits on a line that does run, so the
 * line stays; the residual is that a name mentioned only after a `#` on a live
 * command line still counts as mentioned. Stripping those needs a shell parser
 * -- quoting, `$(...)`, `#` inside a string -- and a wrong one would fail in
 * the direction that gets the guard deleted.
 */
function isCommentLine(line: string): boolean {
    return /^\s*#/.test(line);
}

/**
 * `text` with its comment lines gone and nothing else touched.
 *
 * The projection for questions that still need the prose: which named step is
 * this, does this allowance predicate select it. `commandLines` below is the
 * projection for what a step runs, and drops the descriptive keys too. Two
 * projections rather than one because the exclusion belongs to the derivation
 * -- `displayName` is commentary when the question is "what does this run" and
 * substance when the question is "which step is this" -- while a comment is
 * commentary for every question here.
 */
function withoutComments(text: string): string {
    return text
        .split("\n")
        .filter((line) => !isCommentLine(line))
        .join("\n");
}

/**
 * A step's command lines, with the keys that merely describe it removed.
 *
 * Shared by both derivations below, deliberately. A step's `displayName` is
 * prose: "Enable pnpm via corepack" made the corepack step read as
 * package-manager work, which is how a `COSTLY_COMMANDS` entry re-pointed at
 * `corepack` kept passing the check meant to catch it. A rule about what a step
 * runs must not read the sentence describing it, and that applies to both
 * derivations or the second one re-introduces the bug the first one fixed.
 *
 * The sharing is what makes a single edit here narrow both, so both callers
 * floor their own output as non-empty; blinding this fires both floors.
 */
function commandLines(step: string): string[] {
    return withoutComments(step)
        .split("\n")
        .filter((line) => !/^\s*(?:-\s*)?(?:displayName|name|condition|continueOnError|timeoutInMinutes|task|target):/.test(line));
}

/**
 * What a step runs, as one string, for the pattern tests in COSTLY_COMMANDS.
 *
 * Worth its own name because adding the comment strip to `commandLines` was not
 * the fix. Measured: with `commandLines` stripping comments and the callers
 * unchanged, a comment naming `pnpm build:bundle-scenes` inside the checkout
 * step still fired two clauses, because `COSTLY_COMMANDS` patterns were tested
 * against the raw step in three separate places and `GATED_STEPS` in a fourth.
 * A projection is not applied until every reader uses it, and the readers here
 * do not all want the same one -- the `GATED_STEPS` check matches display names
 * and so takes `withoutComments`, not this.
 */
function commandText(step: string): string {
    return commandLines(step).join("\n");
}

/**
 * Steps that invoke a package manager, derived from the pipeline text.
 *
 * The wider of this file's two descriptions of expensive work. A step that runs
 * `pnpm`, `npm` or `npx` is fetching or building something; the three commands
 * the incident was about are all in here, and so is the next one, without
 * anybody naming it.
 *
 * It used to claim to be "the one description no edit to this file can narrow,
 * empty or re-point". That was wrong in the first of the three: this is a regex
 * in this file, and narrowing it to exactly the commands COSTLY_COMMANDS names
 * satisfied every floor written over its output while a new build step sat
 * permanently ahead of the check. `packageScriptWork` below is the second side,
 * and the cost clause cross-checks the two.
 *
 * It is a proxy, not a measurement -- `pnpm --version` would be caught and is
 * not expensive. That direction is the safe one: it can demand the check move
 * earlier, never later.
 */
function packageManagerWork(steps: string[]): string[] {
    return steps.filter((s) => commandLines(s).some((line) => /\b(?:pnpm|npm|npx)\s+[a-z@]/i.test(line)));
}

/**
 * Every script name `package.json` declares.
 *
 * A foreign artifact, and that is its whole value here. `package.json` is
 * written to make the repository work, not to satisfy this test; nobody edits
 * it to buy silence, and deleting an entry to hide a step from this file breaks
 * the step itself. It is the side of the comparison that is not an assertion.
 */
function packageScripts(): string[] {
    const parsed: unknown = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
    const scripts = (parsed as { scripts?: Record<string, unknown> }).scripts;
    return scripts ? Object.keys(scripts) : [];
}

/** `pnpm x`, `npm run x`, `npx x` -- the token a package manager is being asked to run. */
const PACKAGE_INVOCATION = /\b(?:pnpm|npm|npx)\s+(?:run\s+)?([A-Za-z0-9:_-]+)/g;

/**
 * Steps that run one of this repository's own package scripts.
 *
 * `packageManagerWork` above calls itself the description of "expensive" that no
 * edit to this file can narrow. That was false, and this exists because it was.
 * Measured, cumulatively: add a `pnpm build:bundle-demos` step ahead of the
 * check (2 clauses fire), take the repair its own failure message offers -- an
 * allowance entry, the pin, a TESTING.md bullet -- and the cost clause is the
 * single thing still standing, which is the design working. Then narrow
 * `packageManagerWork` from `pnpm <anything>` to the three commands
 * COSTLY_COMMANDS already names. **10 passed**, one edit, this file only, with a
 * demo build permanently ahead of the check.
 *
 * Neither existing floor saw it. `packageManagerWork(steps).length > 0` was
 * satisfied by the three surviving matches, and the `absent` cross-check asks
 * only that each *named* command is still derived -- so a narrowing that keeps
 * exactly the named ones passes both. Both floors are stated over the commands
 * this file has heard of, and the derivation's entire purpose is the one it has
 * not. A predicate every clause consumes sits between the assertions and the
 * artifact: floors written over its output cannot see it move.
 *
 * So this reads the second side from `package.json`. A step invoking a declared
 * script is doing this repository's own build work, whatever any regex in this
 * file has been narrowed to, and a new expensive step is overwhelmingly a new
 * `pnpm <script>`.
 *
 * The two share `commandLines` and nothing else, so a narrowing of either one is
 * visible to the other. They are not independent: blinding `commandLines` blinds
 * both, which is why both callers floor their own output as non-empty rather
 * than trusting the pair. And the disagreement is not immediate -- narrowing
 * `packageManagerWork` shows up here only once the pipeline runs a declared
 * script the narrowing misses, which is precisely the case the capitulation
 * needed and could not avoid.
 *
 * Residual, stated: a step expensive in neither vocabulary -- `./scripts/x.sh`,
 * a bare `curl` of something enormous -- is seen by neither, and is covered only
 * by the universal allowance clause, which has a documented hatch. Closing that
 * needs a cost model, which this file deliberately does not have.
 */
/**
 * The declared script names a step asks a package manager to run.
 *
 * Extracted from `packageScriptWork` so the tokens can be asserted rather than
 * only their count. Measured, and the reason this is a separate function:
 * dropping `:` from PACKAGE_INVOCATION's token class leaves
 * `pnpm build:bundle-scenes` matching the token `build` -- which `package.json`
 * also declares. The step is still returned, every floor over the derivation's
 * output is still satisfied, and the derivation is matching for the wrong
 * reason. A floor on what a derivation found cannot see why it found it.
 */
function invokedScripts(step: string): string[] {
    const declared = new Set(packageScripts());
    return commandLines(step)
        .flatMap((line) => [...line.matchAll(PACKAGE_INVOCATION)])
        .map(([, token]) => token)
        .filter((token): token is string => token !== undefined && declared.has(token));
}

function packageScriptWork(steps: string[]): string[] {
    return steps.filter((step) => invokedScripts(step).length > 0);
}

/**
 * Why a step would be reported as expensive, in the words the failure uses.
 *
 * Extracted so the table can assert the *reported* reason rather than recompute
 * it. Measured: a first attempt pinned `COSTLY_COMMANDS.filter(...)` inside the
 * specimen clause, which left the cost clause free to print any reason it liked
 * — the table agreed with the derivation while the message came from somewhere
 * else. Asserting a derivation is not asserting the report unless both read the
 * same function.
 */
function expensiveReasons(step: string): string[] {
    return COSTLY_COMMANDS.filter(({ pattern }) => pattern.test(commandText(step))).map(({ why }) => why);
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
function pipelineSteps(source?: string): string[] {
    const lines = (source ?? readFileSync(join(repoRoot, pipelineFile), "utf8")).split("\n");
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
        // `-(\s|$)` rather than `startsWith("- ")`: a bare dash is a legal empty
        // sequence entry, and the old form folded it into the step above. That
        // direction is pinned by a row. The looser `startsWith("-")` is NOT
        // separable by any legal input and is the stated residual — a line at
        // the item's own indent beginning with a dash but not a sequence entry
        // is not legal YAML, so nothing well-formed reaches the difference. The
        // flag-continuation row does not reach it either: a block-scalar body
        // line is always deeper than the item indent, so it falls through to the
        // accumulator before this decision is consulted.
        if (line.trim() && /^-(\s|$)/.test(line.trimStart())) {
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

/**
 * A step's `displayName` if it has one, so a message can name a step the guard
 * found rather than one a constant named.
 */
function stepLabel(step: string): string {
    const named = /displayName:\s*"?([^"\n]+?)"?\s*$/m.exec(step);
    return named?.[1]?.trim() ?? step.trim().split("\n")[0]?.trim() ?? "(unnamed step)";
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

/**
 * The shell body of a step's `script: |` block, with none of the YAML keys
 * around it.
 *
 * `env:` entries are excluded by construction and that is the entire point: an
 * `env:` block names variables, it does not check them, and a step that has been
 * hollowed out keeps its `env:` block because that is the part that looks like
 * configuration rather than like work. Measured — replacing this pipeline's
 * check script with a single `echo`, one edit, left this file 10/10 green while
 * reproducing the incident it exists to prevent.
 *
 * The two sides of the terminator are measured separately and only one of them
 * is load-bearing here. The key side must count the `- ` of `- script: |` as
 * structure, or the block runs on and swallows `displayName` and the whole
 * `env:` block underneath it — the exact text whose absence is what makes the
 * caller's check mean anything, and the caller floors it. The line side uses the
 * raw indent because inside a block scalar a leading `- ` is literal text rather
 * than a sequence marker; no step in this pipeline has a body line beginning
 * with `- ` at the key's column, so no input here separates that choice from the
 * other one. Recorded rather than defended with a contrived arm.
 *
 * Literal `|` only, not `[|>]`. No step here uses a folded `script: >` and a
 * branch no input reaches is a branch nobody has checked; the caller floors the
 * empty return instead, which gives an accurate message on the day someone
 * writes one rather than a misleading one about variables going unmentioned.
 *
 * Comment lines are stripped, so what this returns is what the shell runs.
 * Measured before it did: commenting out this check's 46 body lines and leaving
 * a live `exit 1` behind returned 10 passed, with every variable name still
 * "mentioned" and the check checking nothing. The block is still terminated on
 * the raw lines, because a YAML comment sitting at the key's column really does
 * end the block.
 */
function shellBodyOf(step: string): string {
    const lines = step.split("\n");
    const at = lines.findIndex((l) => /^\s*(?:-\s*)?script:\s*\|/.test(l));
    if (at === -1) {
        return "";
    }
    const keyColumn = contentColumn(lines[at] ?? "");
    const body: string[] = [];
    for (const line of lines.slice(at + 1)) {
        if (line.trim() && indentOf(line) <= keyColumn) {
            break;
        }
        if (!isCommentLine(line)) {
            body.push(line);
        }
    }
    return body.join("\n");
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
 * The file that reads the published baseline.
 *
 * This is deliberately not a test artifact and not a document. It is the code
 * PR builds and local developers actually run, and its default URL is the only
 * statement in the tree of where the baseline is expected to be found. Every
 * other clause in this file has the pipeline on both sides of its comparison,
 * which is why a publish step that publishes nothing satisfied all of them.
 */
const readerFile = "scripts/bundle-scenes-core.ts";

/** The `value:` of a pipeline-level variable, by name. */
function pipelineVariable(name: string, source: string): string | undefined {
    const pattern = new RegExp(`^[ \\t]*-[ \\t]*name:[ \\t]*${name}[ \\t]*\\r?\\n[ \\t]*value:[ \\t]*(.+)$`, "m");
    return pattern.exec(source)?.[1]?.trim();
}

/**
 * Resolve `$(name)` macros against the pipeline's own `variables:` block.
 *
 * An unresolved macro is left standing rather than replaced with an empty
 * string, so the caller can tell "this variable is not declared here" from
 * "this variable is declared as empty". The first is a typo; the second is a
 * decision.
 */
function resolveMacros(text: string, source: string): string {
    return text.replace(/\$\(([A-Za-z_][A-Za-z0-9_.]*)\)/g, (whole, name: string) => pipelineVariable(name, source) ?? whole);
}

interface PublishedBaseline {
    /** Storage path the upload targets, with pipeline macros resolved. */
    deployPath: string;
    /** Archive the upload sends, by basename. */
    uploaded: string;
    /** Archive the script builds, by basename. */
    built: string;
    /** Files placed inside that archive. */
    members: string[];
}

/** Where the publish step actually puts the baseline, read out of what it runs. */
function publishedBaseline(step: string, source: string): PublishedBaseline {
    const script = shellBodyOf(step);
    // The archive token stops at `)` as well as at whitespace. The zip runs
    // inside a `( cd … && zip … )` subshell, so with no files listed the token
    // would otherwise be `baseline.zip)` -- which compares unequal to the
    // uploaded name and reports a mismatched-archive failure for what is
    // really an empty archive. Measured: the paren only reaches the token when
    // the member list is empty, so the corpus hid it.
    const zipped = /\bzip\s+((?:-\S+\s+)*)([^\s)]+)([^\n)]*)/.exec(script);
    const basename = (p: string): string => p.split("/").pop() ?? "";

    return {
        deployPath: resolveMacros(/-F\s+"path=([^"]*)"/.exec(script)?.[1] ?? "", source),
        uploaded: basename(/-F\s+"zip=@([^"]*)"/.exec(script)?.[1] ?? ""),
        built: basename(zipped?.[2] ?? ""),
        members: (zipped?.[3] ?? "").split(/\s+/).filter(Boolean),
    };
}

/** The path component of the URL the reader fetches the baseline from. */
function readerManifestPath(): string {
    const text = readFileSync(join(repoRoot, readerFile), "utf8");
    const url = /DEFAULT_MASTER_MANIFEST_URL\s*=\s*"([^"]+)"/.exec(text)?.[1];
    if (!url) {
        return "";
    }
    try {
        return new URL(url).pathname;
    } catch {
        return "";
    }
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

/**
 * How the guard must read a step, one row per decision inside the projections.
 *
 * Why this exists: a mechanical sweep of the *predicates* (not the constants)
 * mutated sixteen decisions in this file one at a time. Thirteen were silent.
 * The three that fired were all inside `isMappingEntry`/`valueShape` — the only
 * predicate in the file that already had a specimen table. Everything else was
 * floored solely by "the guard still passes on the one real pipeline", which is
 * a single input, and a single input cannot separate a predicate from a looser
 * or tighter one that agrees with it on that input.
 *
 * The sharpest one, and the reason the table starts with comments: loosening
 * `isCommentLine` from `/^\s*#/` to `/#/` — strip any line *containing* a hash —
 * left 10 passed. A live command with a trailing comment then vanishes from
 * `commandLines`, so `pnpm build:bundle-scenes # measures the bundles` is a step
 * the cost clause cannot see. That helper was added one commit ago to kill a
 * false positive, and it acquired a false-negative mode in the dangerous
 * direction: when a predicate is written to suppress an over-report, every
 * specimen you think of covers the over-reporting direction.
 *
 * No oracle. Unlike NESTING_SPECIMENS, whose verdicts come from PyYAML, these
 * are design judgements about what this repository's pipelines mean, so the
 * rows are the specification rather than a record of one. Both directions are
 * required per decision: a row where the guard must see the command and a row
 * where it must not.
 */
type StepReading = {
    label: string;
    step: string;
    /** Exactly the lines `commandLines` must return, trimmed. */
    runs: string[];
    /** Substrings `withoutComments` must keep, because the name checks read them. */
    prose: string[];
    packageManager: boolean;
    scripts: string[];
    /**
     * The `why` strings COSTLY_COMMANDS must produce for this step. Measured
     * before it existed: replacing the cost clause's message with a fixed reason
     * passed every arm, so a step could be reported as expensive for another
     * entry's reason — the entry that matched was never read, only the count.
     */
    costly: string[];
    /** What `stepLabel` must call this step. Nothing else in the file reads it. */
    label_: string;
    shellBody?: string[];
    env?: string[];
};

const STEP_READINGS: StepReading[] = [
    {
        label: "a plain script step with a display name",
        step: '                - script: pnpm build:bundle-scenes\n                  displayName: "Build bundle scenes"',
        runs: ["- script: pnpm build:bundle-scenes"],
        prose: ["Build bundle scenes"],
        packageManager: true,
        scripts: ["build:bundle-scenes"],
        costly: ["measures every bundle scene"],
        label_: "Build bundle scenes",
    },
    {
        // The P1 row. Loosen isCommentLine to /#/ and this command disappears.
        label: "a live command carrying a trailing comment",
        step: "                - script: pnpm install --frozen-lockfile # the lockfile is pinned",
        runs: ["- script: pnpm install --frozen-lockfile # the lockfile is pinned"],
        prose: ["pnpm install"],
        packageManager: true,
        scripts: [],
        costly: ["installs the dependency tree"],
        label_: "- script: pnpm install --frozen-lockfile # the lockfile is pinned",
    },
    {
        // The P2 row. Tighten isCommentLine to /^#/ and this comment survives as
        // a command, which is the false positive the helper was added to kill.
        label: "an indented whole-line comment naming a command",
        step: "                - checkout: self\n                  # pnpm install --frozen-lockfile\n                  # was: pnpm build:bundle-scenes",
        runs: ["- checkout: self"],
        prose: ["checkout: self"],
        packageManager: false,
        scripts: [],
        costly: [],
        label_: "- checkout: self",
    },
    {
        // Pins the other end of the same decision: "strip only *indented*
        // comments" fails here, so neither `/^#/` nor `/^\s+#/` survives.
        label: "a whole-line comment at column zero",
        step: "                - checkout: self\n# pnpm build:bundle-scenes",
        runs: ["- checkout: self"],
        prose: ["checkout: self"],
        packageManager: false,
        scripts: [],
        costly: [],
        label_: "- checkout: self",
    },
    {
        label: "a display name that names a package manager",
        step: '                - task: UseNode@1\n                  displayName: "Enable pnpm via corepack"',
        runs: [],
        prose: ["Enable pnpm via corepack"],
        packageManager: false,
        scripts: [],
        costly: [],
        label_: "Enable pnpm via corepack",
    },
    {
        label: "a condition that names a package manager",
        step: "                - script: echo ready\n                  condition: eq(variables['pnpm install'], 'yes')",
        runs: ["- script: echo ready"],
        prose: ["pnpm install"],
        packageManager: false,
        scripts: [],
        costly: [],
        label_: "- script: echo ready",
    },
    {
        // The P8 row: drop `(?:run\s+)?` and the token becomes `run`.
        label: "a script invoked through `pnpm run`",
        step: "                - script: pnpm run build:bundle-scenes",
        runs: ["- script: pnpm run build:bundle-scenes"],
        prose: ["build:bundle-scenes"],
        packageManager: true,
        scripts: ["build:bundle-scenes"],
        costly: ["measures every bundle scene"],
        label_: "- script: pnpm run build:bundle-scenes",
    },
    {
        // The P6 row: drop the `\b` and `cpnpm` reads as `pnpm`.
        label: "a word that merely ends in a package manager's name",
        step: "                - script: echo cpnpm install",
        runs: ["- script: echo cpnpm install"],
        prose: ["cpnpm"],
        packageManager: false,
        scripts: [],
        costly: [],
        label_: "- script: echo cpnpm install",
    },
    {
        // The P7 row: drop the argument and a bare mention counts as work.
        label: "a package manager named with no command after it",
        step: "                - script: echo pnpm",
        runs: ["- script: echo pnpm"],
        prose: ["pnpm"],
        packageManager: false,
        scripts: [],
        costly: [],
        label_: "- script: echo pnpm",
    },
    {
        label: "a block scalar body with a comment in it",
        step:
            "                - script: |\n" +
            "                    pnpm exec playwright install --with-deps\n" +
            "                    # echo skipped\n" +
            "                    echo done\n" +
            '                  displayName: "Install Playwright browsers"\n' +
            "                  env:\n" +
            "                    PLAYWRIGHT_TOKEN: $(TOKEN)",
        runs: ["- script: |", "pnpm exec playwright install --with-deps", "echo done", "env:", "PLAYWRIGHT_TOKEN: $(TOKEN)"],
        prose: ["Install Playwright browsers"],
        packageManager: true,
        scripts: [],
        costly: ["downloads a browser"],
        label_: "Install Playwright browsers",
        shellBody: ["pnpm exec playwright install --with-deps", "echo done"],
        env: ["PLAYWRIGHT_TOKEN"],
    },
    {
        // The P14 row. A multi-line plain scalar is legal YAML and is not a
        // block scalar; a `script:` test without the `|` reads its continuation
        // line as shell the step runs.
        label: "an inline script continued on the next line",
        step: '                - script: pnpm exec playwright\n                    install --with-deps\n                  displayName: "Install Playwright browsers"',
        runs: ["- script: pnpm exec playwright", "install --with-deps"],
        prose: ["Install Playwright browsers"],
        packageManager: true,
        scripts: [],
        costly: ["downloads a browser"],
        label_: "Install Playwright browsers",
        shellBody: [],
    },
    {
        // The P16 row: `env` inside a command is not an `env:` block.
        label: "a command that mentions env, above a real env block",
        step: '                - script: echo "env: production"\n                  env:\n                    TOKEN: $(TOKEN)',
        runs: ['- script: echo "env: production"', "env:", "TOKEN: $(TOKEN)"],
        prose: ["env: production"],
        packageManager: false,
        scripts: [],
        costly: [],
        label_: '- script: echo "env: production"',
        env: ["TOKEN"],
    },
];

/**
 * Steps blocks whose parse is the assertion, for the one reader that takes a
 * file rather than a step. The P15 row: splitting on `-` instead of `- ` cuts a
 * step in half at a flag continuation, and no step in the real pipeline has one.
 */
const STEP_SPLITS: { label: string; yaml: string; count: number }[] = [
    {
        label: "a flag continuation line does not start a new step",
        yaml: "            steps:\n                - script: |\n                    pnpm install\n                    --frozen-lockfile\n                - checkout: self",
        count: 2,
    },
    {
        label: "sibling keys stay with their step",
        yaml: '            steps:\n                - script: pnpm install\n                  displayName: "Install"\n                - checkout: self',
        count: 2,
    },
    {
        // Separates `- ` from `-(\s|$)`. A bare dash is a legal empty sequence
        // entry, and `startsWith("- ")` folds it into the step above. Found by
        // asking what legal YAML could separate the two, after the flag-
        // continuation row turned out not to: a body line starting with a dash
        // is never at the item's own indent, so it never reached the decision.
        label: "a bare dash is its own (empty) step",
        yaml: "            steps:\n                - script: pnpm install\n                -\n                - checkout: self",
        count: 3,
    },
];

/**
 * Content that is and is not a mapping entry, asserted directly.
 *
 * NESTING_SPECIMENS drives this predicate through `malformedNestingIn`, which
 * skips comment lines and works on content with the indent already removed. So
 * the `[^#\s]` at the start of the key was unreachable through that table: the
 * caller guarantees both characters away. Measured — deleting it left every row
 * passing. That is the "dead by the caller's guarantee" case, and the answer
 * here is not to record it, because this predicate is going into a shared module
 * where the guarantee will not travel with it. Pinned directly instead.
 */
const MAPPING_ENTRY_READINGS: { content: string; isEntry: boolean; why: string }[] = [
    { content: "displayName: Build", isEntry: true, why: "a key with a value" },
    { content: "env:", isEntry: true, why: "a key with an empty value" },
    { content: "# displayName: Build", isEntry: false, why: "a comment is not a key, whatever it contains" },
    { content: " displayName: Build", isEntry: false, why: "a key cannot start with whitespace once the indent is gone" },
    { content: "echo two:three", isEntry: false, why: "a colon inside shell is not a key separator" },
    { content: "- script: pnpm install", isEntry: true, why: "a sequence entry carrying a key" },
];

describe("the baseline pipeline validates its deploy configuration before doing expensive work", () => {
    it("reads a step the way the pipeline means it, in both directions per decision", () => {
        const problems: string[] = [];
        for (const row of STEP_READINGS) {
            const runs = commandLines(row.step)
                .map((l) => l.trim())
                .filter((l) => l !== "");
            if (runs.join("\u0000") !== row.runs.join("\u0000")) {
                problems.push(`"${row.label}": the guard reads [${runs.join(" | ")}] as what the step runs, not [${row.runs.join(" | ")}]`);
            }
            const kept = withoutComments(row.step);
            for (const phrase of row.prose) {
                if (!kept.includes(phrase)) {
                    problems.push(`"${row.label}": "${phrase}" was dropped, and the name checks read it`);
                }
            }
            if (packageManagerWork([row.step]).length > 0 !== row.packageManager) {
                problems.push(`"${row.label}": counts as package-manager work: ${!row.packageManager}, and the cost clause acts on that`);
            }
            const scripts = invokedScripts(row.step);
            if (scripts.join(",") !== row.scripts.join(",")) {
                problems.push(`"${row.label}": reads the declared scripts as [${scripts.join(" | ")}], not [${row.scripts.join(" | ")}]`);
            }
            const costly = expensiveReasons(row.step);
            if (costly.join(",") !== row.costly.join(",")) {
                problems.push(`"${row.label}": would be reported as expensive because it [${costly.join(" | ")}], not [${row.costly.join(" | ")}]`);
            }
            if (stepLabel(row.step) !== row.label_) {
                problems.push(`"${row.label}": a failure would call this step "${stepLabel(row.step)}", not "${row.label_}"`);
            }
            if (row.shellBody) {
                const body = shellBodyOf(row.step)
                    .split("\n")
                    .map((l) => l.trim())
                    .filter((l) => l !== "");
                if (body.join("\u0000") !== row.shellBody.join("\u0000")) {
                    problems.push(`"${row.label}": reads the shell body as [${body.join(" | ")}], not [${row.shellBody.join(" | ")}]`);
                }
            }
            if (row.env && envKeys(row.step).join(",") !== row.env.join(",")) {
                problems.push(`"${row.label}": reads the env keys as [${envKeys(row.step).join(" | ")}], not [${row.env.join(" | ")}]`);
            }
        }
        for (const row of STEP_SPLITS) {
            const found = pipelineSteps(row.yaml).length;
            if (found !== row.count) {
                problems.push(`"${row.label}": split into ${found} steps, not ${row.count}`);
            }
        }
        for (const row of MAPPING_ENTRY_READINGS) {
            if (isMappingEntry(row.content) !== row.isEntry) {
                problems.push(`"${row.content}" reads as ${isMappingEntry(row.content) ? "a mapping entry" : "not a mapping entry"} — ${row.why}`);
            }
        }

        // Both directions have to be present, or the table drifts into being a
        // list of things the guard already does. The sweep that produced these
        // rows found the *negative* direction missing in every predicate here.
        //
        // Residuals from the axis sweep, stated: replacing a failure's connective
        // prose while keeping its numbers and quoted lines is silent, in this
        // clause and in the nesting one. That is deliberate — pinning wording
        // makes the table a spelling test, and the parts a reader must be able to
        // act on are the line, the excerpt, the step's name and the reason, all
        // of which are asserted. The checks that carry those are silent when
        // dropped alone and only the paired arm shows they are load-bearing: they
        // are unattacked, not dead.
        expect(STEP_READINGS.filter((r) => r.packageManager).length, "the positive direction is missing: no row expects a step to count as package-manager work").toBeGreaterThan(
            0
        );
        expect(
            STEP_READINGS.filter((r) => !r.packageManager).length,
            "the negative direction is missing: no row expects a step to be ignored by the package-manager rule"
        ).toBeGreaterThan(0);
        expect(STEP_READINGS.filter((r) => r.runs.length > 0).length, "no row asserts the guard sees a command").toBeGreaterThan(0);
        expect(STEP_READINGS.filter((r) => r.scripts.length > 0).length, "no row pins a declared script name").toBeGreaterThan(0);
        // Every COSTLY_COMMANDS entry needs a row that reports its reason, or a
        // pair of entries can swap `why` strings and no row notices.
        for (const { why } of COSTLY_COMMANDS) {
            expect(STEP_READINGS.filter((r) => r.costly.includes(why)).length, `no row expects a step reported as expensive because it ${why}`).toBeGreaterThan(0);
        }
        expect(
            STEP_READINGS.filter((r) => r.costly.length === 0).length,
            "the cheap direction is missing: no row expects a step with no reason to be reported as expensive"
        ).toBeGreaterThan(0);
        expect(problems, `the projections read a step differently than the pipeline means it:\n  ${problems.join("\n  ")}`).toEqual([]);
    });

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
            // `matches` is given the raw step, not a projection. Residual,
            // stated and measured rather than hardened away: a comment cannot
            // satisfy the one predicate here, because it anchors at the start of
            // a line and a comment line starts with `#`. A predicate written
            // loosely enough to match inside a comment would be reported by this
            // very clause as selecting a step it should not, which is the
            // behaviour wanted. No input separates stripping from not stripping,
            // so nothing is stripped.
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
                const gated = GATED_STEPS.filter((g) => withoutComments(step).includes(g)).map(
                    () => `\`${name}\` exempts "${label}", which is work "${PREFLIGHT_STEP}" exists to stand in front of`
                );
                const costly = expensiveReasons(step).map((why) => `\`${name}\` exempts "${label}", which ${why} — the allowance is for cheap steps`);
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
            const named = expensiveReasons(step).map((why) => `a step that ${why} runs before "${PREFLIGHT_STEP}"`);

            // The named list supplies the reason; the derived set supplies the
            // floor. A step that invokes a package manager is doing the kind of
            // work this check exists to precede whether or not anyone has named
            // its command here -- and emptying or re-pointing COSTLY_COMMANDS,
            // both of which returned 10 passed before this line existed, cannot
            // take it out of the set.
            //
            // `packageScriptWork` deliberately has no branch here. It would only
            // ever be reached for a step `packageManagerWork` missed, and every
            // such step is already reported by the cross-check below -- measured,
            // not assumed: with that branch present and the cross-check removed,
            // and with the branch removed and the cross-check present, the same
            // capitulation fails on the same clause either way. A branch whose
            // reachable inputs are a subset of another assertion's is a branch
            // nobody is checking, so the position it would have reported is
            // folded into the cross-check's message instead.
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

        // The two derivations, cross-checked, and this is the assertion that
        // makes the pair worth having. `packageScriptWork` reads its vocabulary
        // from `package.json`, so taking a step out of it means deleting the
        // script the step runs -- it is the side of the comparison that is not
        // an assertion, and the one no edit here can narrow.
        //
        // What it does not do, measured rather than claimed: narrowing
        // `packageManagerWork` on today's pipeline is silent here, because the
        // narrowing that hid the capitulation kept `build:bundle-scenes` and
        // that is the only declared script this pipeline runs. So this is not a
        // report of the narrowing itself; it is a report of the narrowing having
        // a witness. Its separating input -- the one place it fires and nothing
        // else does -- is a step running an unnamed package script positioned
        // *after* the check: `expensive` slices at the check and never sees it,
        // `absent` only asks about the three commands COSTLY_COMMANDS names.
        const unseen = packageScriptWork(steps).filter((s) => packageManagerWork([s]).length === 0);
        expect(
            unseen.map(
                (s) =>
                    `"${stepLabel(s)}" runs a script package.json declares, but packageManagerWork does not see it${steps.indexOf(s) < preflight ? ` — and it runs BEFORE "${PREFLIGHT_STEP}"` : ""}`
            ),
            `the two descriptions of expensive work disagree. packageManagerWork is meant to be the wider of the two -- a step running one of this repository's own scripts is package-manager work by construction -- so this means it has been narrowed. That edit was measured: restricting it to the commands COSTLY_COMMANDS already names left this file 10/10 green with a demo build permanently ahead of the check.`
        ).toEqual([]);

        // Vacuity floor for the side that reads package.json. If that read goes
        // blind -- file moved, `scripts` renamed, the invocation pattern no
        // longer matching how the pipeline spells a command -- the cross-check
        // above compares an empty set against anything and always passes.
        expect(
            packageScriptWork(steps).length,
            `no step in ${pipelineFile} was found to run a script declared in package.json, so the cross-check above has nothing to compare. The pipeline runs \`pnpm build:bundle-scenes\`, so this is far more likely to be the derivation going blind than the pipeline having stopped building.`
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
        const absent = COSTLY_COMMANDS.filter(({ pattern }) => !steps.some((s) => pattern.test(commandText(s)) && packageManagerWork([s]).length > 0));
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
            //
            // Both halves of the sentence, and both derived from the subject
            // rather than written per row. Measured: quoting the wrong FOLLOWING
            // line passed every row, because only the flagged line was read —
            // the message would name a real problem and point at the wrong
            // partner. Deriving costs nothing and adds no constant, since the
            // rule's own definition of "the next line that matters" is what the
            // reader needs to see confirmed.
            for (const n of flags) {
                const lines = yaml.split("\n");
                const source = lines[n - 1]?.trim() ?? "";
                const message = messages.find((m) => m.startsWith(`line ${n}:`)) ?? "";
                if (!message.includes(source)) {
                    disagreements.push(`${label} — nothing in the failure quotes line ${n} (\`${source}\`)`);
                }
                const following =
                    lines
                        .slice(n)
                        .find((l) => {
                            const c = l.slice(contentColumn(l));
                            return c.trim() !== "" && !c.startsWith("#");
                        })
                        ?.trim() ?? "";
                if (following !== "" && !message.includes(following)) {
                    disagreements.push(`${label} — the failure for line ${n} does not name the line it is followed by (\`${following}\`)`);
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

        // Being first is not the same as checking. Every arm this file has ever
        // run pushes the check later or the expensive work earlier, because that
        // is the direction it was written to defend; nothing tested the check
        // standing exactly where it belongs and validating nothing.
        //
        // Measured, and it is worse than a capitulation: replacing this step's
        // script with a single `echo` is ONE edit, needs no other artifact to
        // agree, and left this file 10/10 green while the pipeline reproduced
        // the original incident — thirty minutes of scene measurement, then a
        // publish failing on a variable that never resolved. Nothing else in the
        // tree describes what this script does, so there was no second side to
        // contradict it. The `env:` block above is not evidence of a check; it
        // is what a check leaves behind when someone deletes the checking.
        const script = shellBodyOf(steps[stepIndex(steps, PREFLIGHT_STEP)] ?? "");

        // Floor the derived region from both ends. An empty body makes every
        // variable read as unmentioned, and a body that ran past its block would
        // swallow the `env:` declarations underneath it and make the check below
        // vacuous in the other direction -- it would find every name, in the very
        // lines whose presence proves nothing.
        expect(
            script.trim(),
            `found no \`script: |\` body in "${PREFLIGHT_STEP}" — if it became a task or a folded block, re-point \`shellBodyOf\` rather than letting this clause read an empty string`
        ).not.toBe("");
        expect(
            script,
            `\`shellBodyOf\` ran past the end of the script block and pulled in the step's \`env:\` declarations, which would satisfy the check below with the wrong lines`
        ).not.toMatch(/^\s*env:\s*$/m);

        const unread = needed.filter((k) => !script.includes(k));

        expect(
            unread,
            `"${PREFLIGHT_STEP}" declares these variables in its \`env:\` block but never mentions them in its script, so nothing establishes that they resolved: ${unread.join(", ")}. Listing a variable is not checking it — the failure this step exists to prevent is a name that arrives empty and is not noticed until "${PUBLISH_STEP}" uses it.`
        ).toEqual([]);

        // ...and the script has to be able to fail. The names check is satisfied
        // by a script that merely logs each variable, which is the next
        // simplification down and the one that looks most like diagnostics while
        // being none.
        expect(
            /\bexit\s+[1-9]/.test(script),
            `"${PREFLIGHT_STEP}" has no failing exit, so it cannot stop the build no matter what it finds. If the failure path is expressed some other way — \`set -e\` and a command that returns non-zero — re-point this assertion at that, but do not remove it: a check that cannot fail is the thirty-minute build this pipeline has already shipped once.`
        ).toBe(true);

        // Residual, stated rather than implied. Every variable the publish step
        // reads today is required, so "checked" and "required" coincide and this
        // clause is exactly right. The first optional publish variable separates
        // them, and at that point the subset assertion is too strong: following
        // its advice would turn an optional variable into one whose absence
        // fails the build. There is no exemption mechanism here because there is
        // nothing to exempt; this comment is what the author of that variable
        // needs, and it is cheaper than machinery for a case that may not come.
    });

    it("publishes the baseline to the path the reader fetches it from", () => {
        // The clause that supplies this file's missing side.
        //
        // Measured, and it is the whole thesis of this PR capitulating: replace
        // the publish step's script with a single `echo` and every other clause
        // here stays green. So does drifting `baselineDeployPath`, dropping the
        // `-F path=` field, renaming the file inside the archive, and uploading
        // an empty zip. Six edits, six passes, and the pipeline reproduces the
        // incident this branch exists to fix — thirty minutes of measurement
        // followed by no baseline at the other end.
        //
        // Every one of those was invisible for the same reason: the pipeline was
        // on both sides of every comparison. `env:` blocks, step order, gate
        // conditions and the allowance are all statements the same file makes
        // about itself, so an edit that changes the file changes both sides at
        // once and nothing is left to disagree.
        //
        // `scripts/bundle-scenes-core.ts` is the side that is not this pipeline
        // and not a document. Both files already carry a comment telling the
        // reader to keep them in sync with each other, and until now that was
        // the entire enforcement mechanism. A drift on either side is a silent
        // 404 for every PR delta report, which is the state master is in right
        // now.
        const source = readFileSync(join(repoRoot, pipelineFile), "utf8");
        const steps = pipelineSteps(source);
        const published = publishedBaseline(steps[stepIndex(steps, PUBLISH_STEP)] ?? "", source);
        const readerPath = readerManifestPath();

        // Floor every extraction -- but not for the reason this comment first
        // gave, and the measurement is worth keeping because it corrects it.
        //
        // These floors are NOT what makes a blinded extraction fail. Measured
        // by deleting each one and blinding the extraction it guards: the
        // binding below fires anyway, every time, because an empty or malformed
        // extraction cannot contain the reader's path either. On the detection
        // axis all four are subsumed.
        //
        // They are kept because they are the sole detectors on a different
        // axis. With the reader floor deleted and `DEFAULT_MASTER_MANIFEST_URL`
        // renamed, the binding fires and says the pipeline "publishes
        // /lite/bundle-baseline/manifest.json" while the reader "fetches ``" --
        // which reads as a pipeline defect and sends the reader to this YAML,
        // when what actually changed is a constant in a TypeScript file that
        // this clause merely failed to find. The floor names the file and the
        // function to re-point. A subsumed conjunct can still be the only thing
        // that attributes the failure correctly, and attribution is what a
        // failing CI check is for.
        expect(
            published.deployPath,
            `no \`-F "path=..."\` field in "${PUBLISH_STEP}" — nothing says where the baseline is being uploaded to, so the comparison against ${readerFile} below has nothing to compare. If the upload moved to a task or a different transport, re-point \`publishedBaseline\` at it rather than letting this read an empty string.`
        ).not.toBe("");
        expect(
            published.deployPath,
            `the upload path in "${PUBLISH_STEP}" still contains an unresolved \`$(...)\` macro after substitution against the pipeline's own \`variables:\` block: "${published.deployPath}". A macro naming a variable that is not declared here resolves to nothing at runtime and publishes the baseline to the wrong place.`
        ).not.toMatch(/\$\(/);
        expect(
            published.members.length,
            `parsed no files out of the \`zip\` command in "${PUBLISH_STEP}" — the archive's contents are what the reader ends up fetching by name, so an empty list makes the comparison below vacuous`
        ).toBeGreaterThan(0);
        expect(
            readerPath,
            `could not read \`DEFAULT_MASTER_MANIFEST_URL\` as a URL from ${readerFile}. That constant is the only statement in the tree of where the baseline is expected to be, and this clause is the only thing binding it to the pipeline that writes it — if it was renamed or restructured, re-point \`readerManifestPath\`, because without it this file has the pipeline on both sides of every comparison it makes.`
        ).not.toBe("");

        // The archive that gets uploaded has to be the archive that was built.
        // Uploading some other path is how a publish step succeeds, reports
        // success, and leaves the baseline exactly as stale as it was.
        expect(
            published.uploaded,
            `"${PUBLISH_STEP}" builds the archive \`${published.built}\` but uploads \`${published.uploaded}\`. The upload will succeed and publish the wrong bytes; a baseline that is never refreshed is indistinguishable from one that is, until a PR reports a delta against a manifest from weeks ago.`
        ).toBe(published.built);

        // The binding itself. The reader fetches one specific path; the pipeline
        // writes a set of files under one specific prefix. The first has to be
        // in the second.
        const publishedPaths = published.members.map((member) => `/${published.deployPath}/${member}`);

        expect(
            publishedPaths,
            `${readerFile} fetches the baseline from \`${readerPath}\`, but "${PUBLISH_STEP}" publishes ${publishedPaths.map((p) => `\`${p}\``).join(", ")}. These two are the write and the read of the same file and there is no mechanism keeping them together except this assertion — both files carry a comment saying "must stay in sync with" the other, and a comment has never stopped an edit. Change both, or change neither.`
        ).toContain(readerPath);
    });
});
