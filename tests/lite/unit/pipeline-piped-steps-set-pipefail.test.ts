import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "fs";
import { join } from "path";

const repoRoot = join(__dirname, "..", "..", "..");

interface ShellScript {
    location: string;
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
    const files = readdirSync(repoRoot).filter((f) => /^azure-pipelines.*\.ya?ml$/.test(f));

    // Guard the guard. If this glob ever stops matching -- a rename, a move
    // into a subdirectory -- an empty set makes every assertion below
    // vacuously true, and this file becomes exactly the kind of check it
    // exists to prevent: one that runs, reports success, and tested nothing.
    expect(files.length, "no azure-pipelines*.yml files found").toBeGreaterThan(0);

    const scripts: ShellScript[] = [];
    for (const file of files) {
        const lines = readFileSync(join(repoRoot, file), "utf8").split("\n");
        for (let i = 0; i < lines.length; i++) {
            const key = /^(\s*)(?:-\s+)?(?:script|bash):(.*)$/.exec(lines[i] ?? "");
            if (!key) {
                continue;
            }
            const indent = (key[1] ?? "").length;
            const rest = (key[2] ?? "").trim();

            // Single-line form. It cannot be split across lines, so whatever
            // follows the key is the whole script.
            if (rest && !/^[|>][-+]?$/.test(rest)) {
                scripts.push({ location: `${file}:${i + 1}`, body: rest.replace(/^["']|["']$/g, ""), kind: "inline" });
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
            scripts.push({ location: `${file}:${i + 1}`, body: body.join("\n"), kind: "block" });
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
    return scripts;
}

/**
 * True when the script's exit status can be decided by a pipeline rather than
 * by its last command. `||` is excluded because it is a boolean operator, not
 * a pipe, and comment lines are excluded so prose *about* pipes -- of which
 * this repo now has a fair amount -- does not count as one.
 */
function containsPipe(script: string): boolean {
    return script.split("\n").some((line) => {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) {
            return false;
        }
        return trimmed.replace(/\|\|/g, "").includes("|");
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
    it("sets pipefail in every script containing a pipe", () => {
        const piped = shellScripts().filter((script) => containsPipe(script.body));

        // Third vacuity guard: the repo has piped scripts today. Zero here
        // means `containsPipe` stopped matching, not that the problem went
        // away.
        expect(piped.length, "no piped scripts detected -- pipe detection is broken").toBeGreaterThan(0);

        const unguarded = piped.filter((script) => !/^\s*set\s+-\S*o\S*\s+pipefail\s*$|^\s*set\s+-o\s+pipefail\s*$/m.test(script.body)).map((script) => script.location);

        expect(
            unguarded,
            `these scripts pipe a command but never 'set -euo pipefail', so a failure on the left of the pipe is silently discarded:\n  ${unguarded.join("\n  ")}\n`
        ).toEqual([]);
    });
});
