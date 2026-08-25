import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { pipelineFilesInRepo, pipelineYamlFiles, SCANNED_ROOTS, SHELL_STEP_KEY } from "./pipeline-files";

interface ShellScript {
    location: string;
    root: string;
    body: string;
    kind: "block" | "inline";
}

/**
 * Every shell script across every Azure pipeline -- both `script: |` block
 * scalars and single-line `script: cmd` values -- located by `file:line` so a
 * failure points straight at it.
 *
 * Both forms are collected on purpose. An earlier version of this file read
 * only block scalars, which meant it silently ignored 68 single-line steps
 * while claiming to cover "every inline pipeline script". It ran, it could
 * fail, it tested a real property -- on two thirds of its stated subject.
 * Verified at the time by injecting `- script: tsc --noEmit | sed s/x/y/`:
 * the check passed. A guard aimed at the wrong subject is as quiet as one
 * that cannot fail, and neither the file glob nor the block-count assertion
 * could see it, because block scalars were plentiful and present.
 *
 * Deliberately line-based rather than YAML-parsed: `yaml` is not a direct
 * dependency of this package, and pulling one in for a hygiene test would
 * touch the lockfile.
 */
function shellScripts(): ShellScript[] {
    const files = pipelineYamlFiles();

    // Guard the guard. If this glob ever stops matching -- a rename, a move
    // into a subdirectory -- an empty set makes every assertion below
    // vacuously true, and this file becomes exactly the kind of check it
    // exists to prevent: one that runs, reports success, and tested nothing.
    expect(files.length, "no azure-pipelines*.yml files found").toBeGreaterThan(0);

    const scripts: ShellScript[] = [];
    for (const { path, location: file, root } of files) {
        const lines = readFileSync(path, "utf8").split("\n");
        for (let i = 0; i < lines.length; i++) {
            // `run` is the GitHub Actions spelling of the same thing. Verified
            // that no Azure file in this repo uses the key, so accepting it
            // here cannot misfire on them.
            //
            // Shared with the closure check rather than spelled twice: when the
            // two had separate notions of "carries a shell step", discovery
            // missed a whole class of file the collector would happily have
            // read. Widening one and not the other is the same split-scope
            // defect this file has now hit at the root level, the predicate
            // level, and here.
            const key = SHELL_STEP_KEY.exec(lines[i] ?? "");
            if (!key) {
                continue;
            }
            const indent = (key[1] ?? "").length;
            const rest = (key[2] ?? "").trim();

            // Single-line form. It cannot be split across lines, so whatever
            // follows the key is the whole script.
            if (rest && !/^[|>][-+]?$/.test(rest)) {
                scripts.push({ location: `${file}:${i + 1}`, root, body: rest.replace(/^["']|["']$/g, ""), kind: "inline" });
                continue;
            }
            if (!rest) {
                continue;
            }

            // Block scalar: consume everything indented deeper than the key.
            const body: string[] = [];
            let j = i + 1;
            for (; j < lines.length; j++) {
                const line = lines[j] ?? "";
                if (line.trim() === "") {
                    body.push(line);
                    continue;
                }
                if (line.search(/\S/) <= indent) {
                    break;
                }
                body.push(line);
            }
            scripts.push({ location: `${file}:${i + 1}`, root, body: body.join("\n"), kind: "block" });
            i = j - 1;
        }
    }

    // One vacuity guard per collector, not one for the function. The single
    // -line reader is the collector that was missing entirely last time, so
    // it gets its own floor: if either form stops being recognised, that
    // assertion fails loudly instead of the check quietly narrowing its
    // subject. Both counts are well above these floors today (block ~40,
    // inline ~68), so they trip on breakage rather than on normal churn.
    expect(scripts.filter((s) => s.kind === "block").length, "suspiciously few block-scalar scripts parsed").toBeGreaterThan(20);
    expect(scripts.filter((s) => s.kind === "inline").length, "suspiciously few single-line scripts parsed").toBeGreaterThan(20);

    // And a floor per *root*, which the two above cannot substitute for. The
    // repository root supplies scripts by the dozen, so a total-count floor
    // stays comfortably satisfied while an entire directory contributes
    // nothing -- non-vacuous and narrower than its stated subject at the same
    // time. That is precisely how `config/templates/` and `.github/workflows/`
    // each went unread while every existing assertion reported success.
    for (const { label } of SCANNED_ROOTS) {
        const root = label || "<repo root>";
        expect(
            scripts.filter((s) => s.root === root).length,
            `no shell scripts parsed from ${root} -- it is listed in SCANNED_ROOTS but contributed nothing, so the invariant is unenforced there`
        ).toBeGreaterThan(0);
    }
    return scripts;
}

/**
 * True when a script turns on `pipefail`, in any of the spellings that
 * actually do so.
 *
 * The predicate this replaced required the option bundle to sit immediately
 * after `set` and the line to end at `pipefail`, which accepted exactly the
 * shape this repo happens to use -- `set -euo pipefail` -- and rejected four
 * correct alternatives: `set -e -o pipefail`, `set -o pipefail -o errexit`,
 * `set -o errexit -o pipefail` and a trailing semicolon. Every fixture written
 * for it was a variation on the one specimen in the tree, so the fixture table
 * could not reveal that; it was found by generating the shapes a shell author
 * might plausibly write instead of the shape already present.
 *
 * That direction is the expensive one. A guard that flags correct code is one
 * somebody deletes rather than debugs, and this guard protects an invariant
 * whose violation is invisible in review.
 *
 * `set +o pipefail` is rejected on purpose: `+` *disables* an option, so a
 * naive "the line mentions pipefail" rule would read an explicit disabling as
 * a guard -- inverting the check exactly where it matters.
 */
export function enablesPipefail(script: string): boolean {
    return script.split("\n").some((line) => {
        // Strip a trailing comment before matching, so `set -euo pipefail # why`
        // is recognised while a commented-out or merely described `set` line is
        // not.
        const code = (line.split("#")[0] ?? "").trim();
        if (!/^set\s/.test(code) || !/\bpipefail\b/.test(code)) {
            return false;
        }
        return !/\+[a-zA-Z]*o?\s*pipefail\b|\+o\s+pipefail\b/.test(code);
    });
}

/**
 * Remove quoted spans from a shell line, so only characters the shell would
 * read as operators remain.
 *
 * This exists because `|` is a pipe operator *outside* quotes and an ordinary
 * character inside them. `grep -E "foo|bar"`, `sed -E 's/(a|b)/x/'` and
 * `awk -F'|'` all contain a `|` that the shell never interprets, and all three
 * are ordinary CI scripting rather than exotic constructions.
 *
 * Backslash escapes are consumed except inside single quotes, where the shell
 * treats a backslash literally.
 */
function stripQuotedSpans(line: string): string {
    let out = "";
    let quote: '"' | "'" | null = null;

    for (let index = 0; index < line.length; index++) {
        const char = line[index];

        if (char === "\\" && quote !== "'") {
            index++;
            continue;
        }
        if (quote) {
            if (char === quote) {
                quote = null;
            }
            continue;
        }
        if (char === '"' || char === "'") {
            quote = char;
            continue;
        }
        out += char;
    }

    return out;
}

/**
 * True when the script's exit status can be decided by a pipeline rather than
 * by its last command.
 *
 * Three things are excluded, and the reason each is excluded differs:
 *
 * - Comment lines, so prose *about* pipes -- of which this repo now has a fair
 *   amount -- does not count as one.
 * - `||`, because it is a boolean operator rather than a pipe.
 * - Quoted spans, because a `|` inside quotes is data, not an operator.
 *
 * The third arrived late and is the reason this is no longer a substring test.
 * The original asked whether the line *contained the character* `|`, which is
 * not the same question and answered it wrongly for six of ten shapes probed:
 * `grep -E "foo|bar"`, `sed -E 's/(a|b)/x/'`, `awk -F'|'`, `echo "a|b"`, a
 * progress bar in a message, and a `case` alternation were all reported as
 * pipes. Every one is correct shell containing no pipeline at all.
 *
 * That direction is the expensive one. A guard that demands `set -euo pipefail`
 * from a script that does not pipe is a false alarm on correct code, and the
 * author who hits it -- with an error message naming their file and asserting
 * something plainly untrue about it -- reasonably concludes the guard is broken
 * and weakens or deletes it. The invariant then dies protecting nothing, and
 * the loss is silent. None of those six shapes is in the tree today, so this
 * cost exactly nothing until the day someone wrote one, which is the whole
 * shape of the risk.
 *
 * Residual, stated rather than papered over: a `case` alternation (`a|b)`) is
 * an unquoted `|` that is not a pipe, so it is still over-flagged. Recognising
 * it needs real grammar rather than lexing, and `case` does not currently
 * appear in any pipeline step. Unlike the six above, over-flagging it merely
 * demands a harmless `set -euo pipefail`, so the failure is legible rather than
 * absurd -- but it is a false positive and belongs on this list.
 */
function containsPipe(script: string): boolean {
    return script.split("\n").some((line) => {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) {
            return false;
        }
        return stripQuotedSpans(trimmed).replace(/\|\|/g, "").includes("|");
    });
}

describe("piped pipeline steps enable pipefail", () => {
    // This is the guard for the defect that let a broken master survive weeks
    // of green builds.
    //
    // The seven type-check steps pipe `tsc` through `sed` to rewrite its
    // output into `##vso[task.logissue]` annotations. A shell pipeline exits
    // with the status of its *last* command, `sed` succeeds on malformed input
    // as readily as on clean input, and `task.logissue` only annotates a build
    // -- it never fails one. So `tsc` could exit 2, every type error would be
    // faithfully printed and annotated in the log, and the step would still
    // report success. Verified directly: bare `tsc` exits 2, the same command
    // piped through `sed` exits 0, and with `pipefail` set it exits 2 again.
    //
    // That is worse than having no type-check at all, because the job is
    // visibly present and visibly green. It manufactures precisely the
    // confidence that stops anyone looking, which is why a semantic conflict
    // between two independently-green PRs (#597 removed a field from
    // `PbrComposerDeps`, #601 added test call sites still passing it) sat
    // undetected on master.
    //
    // Fixing those seven steps by hand corrected the instances but not the
    // invariant: nothing stopped an eighth piped step arriving without the
    // guard. This test is that invariant. It is deliberately over-inclusive --
    // it flags any piped script, including ones where a left-hand failure is
    // harmless -- because adding `pipefail` to a script that did not need it
    // costs nothing, while missing one that did costs a silently disabled gate.
    //
    // Known false positive, stated rather than discovered later. GitHub Actions
    // picks the shell two different ways: a bare `run:` gets `bash -e {0}` --
    // errexit but *not* pipefail, which is why the invariant is live there at
    // all -- while a step declaring `shell: bash` explicitly gets
    // `bash --noprofile --norc -eo pipefail {0}`, where pipefail is already on.
    // This guard reads neither, so it would demand a redundant `set -euo
    // pipefail` from the second kind and tell its author their pipeline failure
    // is silently discarded, which would not be true.
    //
    // Not fixed, because reading a step's sibling `shell:` key needs structure
    // this line-based collector does not have, and inventing that parser is a
    // larger risk than the misfire. Recorded because the repo has no such step
    // today: the premise that made widening to Actions worthwhile is that
    // `compat-sync-trigger.yml` uses a bare `run:`, which was checked rather
    // than assumed -- and it is the kind of premise that stops holding when
    // someone adds one word to a file this test does not appear to concern.
    it("sets pipefail in every script containing a pipe", () => {
        const piped = shellScripts().filter((script) => containsPipe(script.body));

        // Third vacuity guard: the repo has piped scripts today. Zero here
        // means `containsPipe` stopped matching, not that the problem went
        // away.
        expect(piped.length, "no piped scripts detected -- pipe detection is broken").toBeGreaterThan(0);

        // Anchored to a `set` command at the start of a line so a *comment*
        // mentioning `set -euo pipefail` -- of which this repo has several,
        // including in this very file -- cannot satisfy the check. Verified:
        // replacing a real guard with prose about it still fails.
        //
        // See `enablesPipefail` for why this is no longer a single regex
        // anchored to one option spelling. Both directions are pinned by the
        // fixture table below.
        const unguarded = piped.filter((script) => !enablesPipefail(script.body)).map((script) => script.location);

        expect(
            unguarded,
            `these scripts pipe a command but never 'set -euo pipefail', so a failure on the left of the pipe is silently discarded:\n  ${unguarded.join("\n  ")}\n`
        ).toEqual([]);
    });
});

describe("the hygiene guards cover every pipeline in the repo", () => {
    /**
     * The check that would have caught both collector-scope bugs found while
     * writing these guards, without anyone having to notice.
     *
     * Twice now a guard here has run, passed, and covered less than the subject
     * it claimed: once reading only block scalars while 68 single-line steps
     * went unexamined, once reading only the repo root while two
     * `config/templates/` files -- included by azure-pipelines.yml at four call
     * sites, both containing a `curl` with an Authorization header -- sat
     * outside the glob. Neither was visible from inside the guard: a collector
     * cannot report a subject it never gathered, and every floor it does have
     * reads normal while the uncovered region happens to be clean.
     *
     * A hardcoded root list is a copy with no closure check. This is the
     * closure check -- discover the real subject independently, then assert the
     * configured scope still covers it. A new pipeline in a new directory fails
     * here by name, instead of the guards quietly narrowing.
     */
    it("scans every YAML file that declares pipeline steps", () => {
        const discovered = pipelineFilesInRepo();

        console.log(`pipeline files discovered: ${discovered.length}`);
        for (const file of discovered) {
            console.log(`  ${file}`);
        }

        // Guard the discovery itself. If the walk or the predicate breaks, an
        // empty set makes the coverage assertion below vacuously true -- the
        // exact defect this test exists to make impossible.
        expect(discovered.length, "no pipeline YAML discovered -- the walk or the step predicate is broken").toBeGreaterThanOrEqual(10);

        // Compare full repo-relative paths, never basenames. A basename match
        // would treat `some-dir/azure-pipelines.yml` as covered because the
        // root file of that name is scanned -- a false negative that hides
        // exactly the case this test exists to catch.
        //
        // The covered set is the files the roots *contain*, not the files that
        // happened to yield a shell script. Those were the same set while
        // discovery keyed on shell steps, and stopped being the same the moment
        // it also matched comment tasks: a scanned file holding only a
        // `GitHubComment@0` task yields no script, so deriving coverage from
        // `shellScripts()` would report a fully covered file as uncovered. That
        // is the same category error as the one this commit fixes, inverted --
        // proving a file was *read by one guard* is not proving it is *in
        // scope*, and here it would have produced a false alarm rather than a
        // silent miss.
        const scanned = new Set(pipelineYamlFiles().map((file) => file.location));
        const unscanned = discovered.filter((file) => !scanned.has(file));

        expect(
            unscanned,
            `these files hold something a guard in this directory reads -- a shell step or a GitHubComment@0 task -- ` +
                `but sit outside SCANNED_ROOTS, so every guard built on it silently ignores them. ` +
                `Add the directory to SCANNED_ROOTS in tests/lite/unit/pipeline-files.ts -- one list, shared, so no guard is left behind:\n  ${unscanned.join("\n  ")}\n`
        ).toEqual([]);
    });
});

describe("enablesPipefail recognises pipefail however it is spelled", () => {
    // Both directions, pinned on the same input shape.
    //
    // These fixtures are deliberately *not* variations on the string this repo
    // uses. Every earlier fixture here was, which is why they all passed while
    // four correct spellings were being rejected: a table generated from the
    // one specimen in the tree certifies the predicate against itself. The
    // accept list is what a shell author might plausibly write instead; the
    // reject list is what merely resembles a guard.
    it.each([
        ["set -euo pipefail", true],
        ["set -eo pipefail", true],
        ["set -euxo pipefail", true],
        ["set -o pipefail", true],
        ["set -euo pipefail  # fail the step if tsc fails", true],
        ["set -e -o pipefail", true],
        ["set -o pipefail -o errexit", true],
        ["set -o errexit -o pipefail", true],
        ["set -euo pipefail;", true],
        ["  set -euo pipefail", true],
        // `+o` *disables* the option. A "line mentions pipefail" rule reads
        // this as a guard and inverts the check at the only point it matters.
        ["set +o pipefail", false],
        // Prose about the guard is not the guard. This is the failure this
        // file was written to prevent, so it is pinned rather than assumed.
        ["# set -euo pipefail", false],
        ["# we deliberately do not set -euo pipefail here", false],
        ["echo set -euo pipefail", false],
        ["unset -o pipefail", false],
        ["set -euo errexit", false],
        ["", false],
    ])("%j -> %s", (line, expected) => {
        expect(enablesPipefail(line)).toBe(expected);
    });

    it("finds the guard anywhere in a multi-line script", () => {
        expect(enablesPipefail("#!/usr/bin/env bash\nset -euo pipefail\ntsc --noEmit | sed s/x/y/")).toBe(true);
        expect(enablesPipefail("#!/usr/bin/env bash\ntsc --noEmit | sed s/x/y/")).toBe(false);
    });
});

describe("containsPipe distinguishes a pipe from the character", () => {
    // This table exists because it did not, and its absence was invisible for
    // the same reason absences usually are: its partner had one.
    //
    // `enablesPipefail` had seventeen fixtures pinning both directions, sitting
    // directly above a predicate with none. The guard needs *both* to be right
    // -- one decides which scripts are subject to the rule, the other decides
    // whether they satisfy it -- and having thoroughly pinned the second, the
    // file read as well-tested. That is the same split-scope defect already
    // found and fixed here at the root-list level, recurring one layer down at
    // the predicate level, and I fixed it in the first place without checking
    // whether it had siblings.
    //
    // The accept list is what a real pipeline looks like; the reject list is
    // correct shell that merely contains the character. The reject direction is
    // the one that was broken, and the one no fixture would have caught,
    // because a false positive here fires on code nobody has written yet.
    it.each([
        // Real pipelines: exit status can be decided by a non-final command.
        ['tsc --noEmit | sed "s/^/##vso/"', true],
        ["pnpm build | tee build.log", true],
        ["cat manifest.json | jq .scenes", true],
        ["set -euo pipefail\ntsc --noEmit | sed s/x/y/", true],
        // A quoted separator does not hide a real pipe later on the line.
        ["awk -F'|' '{print $1}' data | head -1", true],
        // `|&` pipes stderr too, and is still a pipeline.
        ["pnpm build |& tee build.log", true],

        // Not pipelines. Every one of these was flagged before the quote-aware
        // rewrite, and every one is ordinary CI scripting rather than an
        // exotic construction.
        ['grep -E "foo|bar" report.txt', false],
        ["sed -E 's/(a|b)/x/' input.txt", false],
        ["awk -F'|' '{print $1}' data.csv", false],
        ['echo "a|b"', false],
        ['echo "progress |"', false],
        // A boolean operator, excluded since the first version.
        ["[ -f dist/index.js ] || exit 1", false],
        // Prose about pipes is not a pipe -- this file is full of it.
        ["# tsc --noEmit | sed rewrites errors into annotations", false],
        ["", false],
    ])("%j -> %s", (script, expected) => {
        expect(containsPipe(script)).toBe(expected);
    });

    // The residual, pinned as-is rather than left to be rediscovered. If
    // someone teaches the predicate real grammar, this flips and the fixture
    // should flip with it -- deliberately, not silently.
    it("still over-flags a case alternation, which needs grammar rather than lexing", () => {
        expect(containsPipe('case "$1" in a|b) echo hi ;; esac')).toBe(true);
    });
});

describe("SHELL_STEP_KEY selects the steps every guard is shown", () => {
    // The selector had no fixtures until now, which is the same omission twice
    // over: `enablesPipefail` and `containsPipe` are both thoroughly pinned,
    // and both are downstream of this. A predicate that decides *what the
    // guards are shown* is strictly more load-bearing than one deciding what
    // they conclude, and it was the only one with no tests -- because it is
    // exercised indirectly by every other assertion here, which makes it look
    // covered.
    //
    // Worth stating plainly: no count in this file can detect a defect here.
    // The floors, the per-root totals and the discovered-files number are all
    // *computed by* this regex, so a selector that silently skips a file
    // produces a smaller inventory and a set of diagnostics that agree with it
    // perfectly.
    it.each([
        // Azure list items.
        ["- script: echo hi", true],
        ["  - bash: |", true],
        ["    - script: |", true],
        // GitHub Actions puts `run:` un-dashed after `- name:`.
        ["      run: |", true],
        ["        run: tsc --noEmit | sed s/x/y/", true],
        // Capitalised. Inert today -- nothing in the repo spells it this way --
        // and matched because missing a real one is silent while matching a
        // broken one is harmless.
        ["- Script: echo hi", true],

        // A task is not a shell script; it has no script body to guard.
        ["- task: PublishBuildArtifacts@1", false],
        // `runs-on:` was the old discovery marker and must not read as a step:
        // it would attribute a job-level key to a script that does not exist.
        ["  runs-on: ubuntu-latest", false],
        // The word, not the key.
        ["  displayName: run the type check", false],
        ["echo run: hi", false],
        // Prose about a step is not a step -- this file is full of it.
        ["# run: echo hi", false],
        ["", false],
    ])("%j -> %s", (line, expected) => {
        expect(SHELL_STEP_KEY.test(line)).toBe(expected);
    });

    it("captures the indent, which the block-scalar reader depends on", () => {
        const match = SHELL_STEP_KEY.exec("      run: |");
        expect(match?.[1]).toBe("      ");
        expect(match?.[2]?.trim()).toBe("|");
    });
});
