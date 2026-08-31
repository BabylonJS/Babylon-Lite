import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { spawnSync } from "child_process";
import { afterEach, describe, expect, it } from "vitest";

/**
 * The two places where CI turns untrusted *content* into pipeline *instructions*
 * if nothing stops it.
 *
 * An Azure Pipelines agent reads every line a step prints and executes it if it
 * begins with `##vso[`. That makes any script which interpolates test output,
 * artifact metadata or a comment body into its own output a command channel into
 * the job it runs in — `##vso[task.setvariable]` rewrites a variable for every
 * later step, and `##vso[task.prependpath]` puts an attacker-chosen directory
 * ahead of `npm` on PATH.
 *
 * Both scripts here read files written by repository-authored code, which in PR
 * CI is the code under review:
 *
 *   * `report-test-results.ts` reads a JUnit file. A test *title* is copied into
 *     a `task.logissue`, and a JUnit `name="…"` attribute can contain a raw
 *     newline, so a title of "ok\n##vso[task.setvariable …]" used to be executed
 *     rather than reported. Verified against the pre-fix script: the injected
 *     line appears in its output.
 *   * `strip-logging-commands.sh` exists solely to load such a body into a
 *     variable in the job that holds the GitHub connection, and had no test.
 *
 * Neither is a substitute for the job boundaries in
 * `pr-pipeline-credential-isolation.test.ts` — they are what keeps a *credential*
 * out of reach. This file is about the residue: content still crosses, and it
 * must arrive as text.
 */

const repoRoot = resolve(__dirname, "../../..");
const tsxPath = resolve(repoRoot, "node_modules/tsx/dist/cli.mjs");
const tempDirs: string[] = [];

function createTempDir(): string {
    const directory = mkdtempSync(join(tmpdir(), "ci-log-injection-"));
    tempDirs.push(directory);
    return directory;
}

afterEach(() => {
    for (const directory of tempDirs.splice(0)) {
        rmSync(directory, { recursive: true, force: true });
    }
});

/** Every logging command the agent would actually obey in this output. */
function obeyedCommands(output: string): string[] {
    return output
        .split("\n")
        .map((line) => line.trimStart())
        .filter((line) => line.startsWith("##vso["))
        .map((line) => line.slice("##vso[".length).split("]")[0] ?? "");
}

describe("report-test-results.ts reports test output rather than executing it", () => {
    const junit = (name: string, failureBody: string): string =>
        [
            '<?xml version="1.0" encoding="UTF-8"?>',
            "<testsuites>",
            '  <testsuite name="s" tests="1" failures="1" errors="0" skipped="0">',
            `    <testcase name="${name}" classname="c">`,
            `      <failure message="m">${failureBody}</failure>`,
            "    </testcase>",
            "  </testsuite>",
            "</testsuites>",
        ].join("\n");

    function run(xml: string): string {
        const directory = createTempDir();
        const file = join(directory, "junit.xml");
        writeFileSync(file, xml);
        const result = spawnSync(process.execPath, [tsxPath, resolve(repoRoot, "scripts/report-test-results.ts"), file], {
            cwd: repoRoot,
            encoding: "utf8",
        });
        expect(result.error, "could not run scripts/report-test-results.ts").toBeUndefined();
        return result.stdout;
    }

    it("emits only the logging commands it composes itself", () => {
        const output = run(junit("passes\n##vso[task.setvariable variable=ArtifactsSafe]true", "detail\n##vso[task.prependpath]/opt/evil"));

        // The set is asserted, not just the absence of the injected names: a
        // command this script never intends to issue is a finding whatever it
        // is called.
        for (const command of obeyedCommands(output)) {
            expect(command, `report-test-results.ts emitted an unexpected logging command: ${command}`).toMatch(/^task\.(logissue type=(error|warning)|complete result=\S+)$/);
        }
    });

    it("still reports the test, so the fix is not silence", () => {
        // The cheapest way to pass the clause above is to print nothing. The
        // annotation has to survive — defanged, but present and readable.
        const output = run(junit("a failing test\n##vso[task.setvariable variable=X]y", "expected 1, received 2"));

        expect(output, "the failure annotation disappeared").toMatch(/##vso\[task\.logissue type=error\]/);
        expect(output).toContain("a failing test");
        expect(output).toContain("expected 1, received 2");
        expect(output, "the neutralised introducer should still be readable in the annotation").toContain("##vso(task.setvariable");
    });

    it("keeps an injected command on the reporting line rather than starting a new one", () => {
        // Two properties, and both are needed. Collapsing the newline is what
        // makes the payload unreachable (the agent only reads a command at the
        // start of a line); defanging `##vso[` is what makes it visible as an
        // attempt rather than as plausible test output.
        const output = run(junit("t\n##vso[task.setvariable variable=NPM_TOKEN]x", "b"));
        const lines = output.split("\n").filter((line) => line.includes("task.setvariable"));

        expect(lines.length, "the injected text vanished; this clause is asserting nothing").toBeGreaterThan(0);
        for (const line of lines) {
            expect(line.trimStart().startsWith("##vso[task.setvariable"), `an injected setvariable started its own line: ${line}`).toBe(false);
        }
    });
});

describe("strip-logging-commands.sh loads a comment body as text", () => {
    function run(body: string): { stdout: string; status: number | null } {
        const directory = createTempDir();
        const file = join(directory, "comment.md");
        writeFileSync(file, body);
        const result = spawnSync("bash", [resolve(repoRoot, "scripts/strip-logging-commands.sh"), file, "BODY_VAR", "FLAG_VAR"], {
            cwd: repoRoot,
            encoding: "utf8",
        });
        expect(result.error, "could not run scripts/strip-logging-commands.sh").toBeUndefined();
        return { stdout: result.stdout, status: result.status };
    }

    it("emits exactly the two setvariable commands it composes", () => {
        const { stdout } = run("### Report\n##vso[task.setvariable variable=DEPLOYMENT_SERVER]https://attacker.invalid\n##[warning]hi\n");

        expect(obeyedCommands(stdout).sort()).toEqual(["task.setvariable variable=BODY_VAR", "task.setvariable variable=FLAG_VAR"]);
    });

    it("encodes the newlines instead of dropping the body after the first line", () => {
        // The neutralised body is delivered as one logging command, so the line
        // breaks have to survive as %0A — otherwise the guard would be "safe"
        // by way of posting a one-line comment.
        const { stdout } = run("first\nsecond\n");
        const body = stdout.split("\n").find((line) => line.includes("variable=BODY_VAR")) ?? "";

        expect(body).toContain("first%0Asecond");
        expect(body, "a literal `##vso[` survived into the variable value").not.toMatch(/\].*##vso\[/);
    });

    it("refuses a variable name that could carry a command of its own", () => {
        const directory = createTempDir();
        const file = join(directory, "comment.md");
        writeFileSync(file, "hello\n");
        const result = spawnSync("bash", [resolve(repoRoot, "scripts/strip-logging-commands.sh"), file, "BODY]x##vso[task.setvariable variable=Y", "FLAG_VAR"], {
            cwd: repoRoot,
            encoding: "utf8",
        });

        expect(result.status, "a variable name outside [A-Za-z0-9_] was accepted").not.toBe(0);
        expect(obeyedCommands(result.stdout), "a rejected run still emitted a logging command").toEqual([]);
    });

    it("reports the missing-file case as a flag rather than as a failure", () => {
        const directory = createTempDir();
        const result = spawnSync("bash", [resolve(repoRoot, "scripts/strip-logging-commands.sh"), join(directory, "absent.md"), "BODY_VAR", "FLAG_VAR"], {
            cwd: repoRoot,
            encoding: "utf8",
        });

        expect(result.status, "an absent comment body must not fail the trusted publish job").toBe(0);
        expect(result.stdout).toContain("##vso[task.setvariable variable=FLAG_VAR]false");
    });
});
