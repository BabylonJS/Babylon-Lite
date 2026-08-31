import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "fs";
import { join } from "path";

const repoRoot = join(__dirname, "..", "..", "..");

/**
 * Guards the one structural property that keeps pull-request CI from handing a
 * credential to the code under review.
 *
 * `azure-pipelines.yml` is the only pipeline with a `pr:` trigger, so it is the
 * only one that executes code authored by the pull request: `pnpm install` runs
 * dependency lifecycle scripts, and every build/test/report step runs source
 * from the PR head. Any secret in scope for such a job is readable by that
 * code, and — worse — any *destination* it uploads to is rewritable by it,
 * because `##vso[task.setvariable]` can overwrite an ordinary pipeline variable
 * at runtime. An authenticated `curl` sharing a job with PR code can therefore
 * be pointed at an attacker's host and made to deliver `DEPLOY_TOKEN`.
 *
 * The fix is structural rather than a filter: privileged work runs in its own
 * `checkout: none` job that consumes a pipeline artifact and runs no repository
 * code at all. These assertions pin that shape, because it is invisible in
 * review — a template call moved back into a build job looks like a tidy-up and
 * silently restores the whole vulnerability.
 */

/** Pipelines that build from a pull-request ref, and so run untrusted code. */
function prTriggeredPipelines(): string[] {
    const files = readdirSync(repoRoot).filter((f) => /^azure-pipelines.*\.ya?ml$/.test(f));

    // Guard the guard: an empty subject makes every assertion below vacuously
    // true, which is precisely the failure this file exists to prevent.
    expect(files.length, "found no azure-pipelines*.yml files to inspect").toBeGreaterThan(0);

    // `pr: none` opts out; a bare `pr:` opens a branch-filter block and opts in.
    return files.filter((f) => /^pr:\s*$/m.test(readFileSync(join(repoRoot, f), "utf8")));
}

interface Job {
    name: string;
    /** The job's own lines, from its `- job:` line up to the next job. */
    body: string;
}

/**
 * Splits a pipeline into job blocks.
 *
 * Line-based rather than YAML-parsed, matching the other pipeline guards in
 * this directory (the repo ships no YAML parser as a direct dependency).
 */
function jobsOf(source: string): Job[] {
    const lines = source.split("\n");
    const starts: { line: number; name: string }[] = [];
    lines.forEach((line, index) => {
        const name = /^\s*-\s*job:\s*(\S+)\s*$/.exec(line)?.[1];
        if (name !== undefined) {
            starts.push({ line: index, name });
        }
    });

    return starts.map(({ line, name }, index) => ({
        name,
        body: lines.slice(line, starts[index + 1]?.line ?? lines.length).join("\n"),
    }));
}

/** The `variables:` block at pipeline scope, i.e. before the first stage/job. */
function pipelineScopedVariables(source: string): string {
    const start = source.search(/^variables:\s*$/m);
    if (start === -1) {
        return "";
    }
    // The block ends at the next line starting in column zero, i.e. the next
    // top-level key.
    const rest = source.slice(start);
    const end = rest.search(/\n(?=\S)/);
    return end === -1 ? rest : rest.slice(0, end);
}

/**
 * True when a job runs anything authored by the pull request.
 *
 * Package installs run dependency lifecycle scripts and the build/test commands
 * run repository source, but an inline `- script:` counts too: for a PR build
 * Azure reads this YAML from the PR head, so a script body written here is
 * PR-authored content just as much as a file under `scripts/`.
 *
 * A `- template:` call is deliberately not a marker. The step bodies it
 * contributes are reviewed, shared upload logic held to their own security
 * contract, which is the whole point of routing privileged work through them.
 */
function runsRepositoryCode(body: string): boolean {
    return /^\s*-\s*script:\s|^\s*-\s*checkout:\s*self\b|\bpnpm (install|build|test|exec)\b|\bnpx\b/m.test(body);
}

function declaredGroups(body: string): string[] {
    return [...body.matchAll(/^\s*-\s*group:\s*(\S+)\s*$/gm)].flatMap((m) => (m[1] === undefined ? [] : [m[1]]));
}

/** Jobs that perform an authenticated upload via a shared deploy template. */
function callsUploadTemplate(body: string): boolean {
    return /^\s*-\s*template:\s*config\/templates\/upload-[\w-]+\.yml\s*$/m.test(body);
}

describe("pull-request CI keeps credentials away from pull-request code", () => {
    const pipelines = prTriggeredPipelines();

    it("has a pr-triggered pipeline to make assertions about", () => {
        // Without this the whole suite passes by inspecting nothing.
        expect(pipelines, "no pipeline declares a `pr:` trigger").not.toHaveLength(0);
    });

    it.each(pipelines)("%s declares no variable group at pipeline scope", (file) => {
        const source = readFileSync(join(repoRoot, file), "utf8");

        // A group listed at pipeline scope is in scope for *every* job,
        // including the ones running PR code, which defeats any per-job care
        // taken below.
        expect(declaredGroups(pipelineScopedVariables(source)), `${file} declares a variable group at pipeline scope; move it to the jobs that need it`).toEqual([]);
    });

    it.each(pipelines)("%s runs every authenticated upload in a job that runs no repository code", (file) => {
        const source = readFileSync(join(repoRoot, file), "utf8");
        const uploaders = jobsOf(source).filter((job) => callsUploadTemplate(job.body));

        expect(uploaders.length, `${file} calls no upload template — the selector has drifted`).toBeGreaterThan(0);

        for (const job of uploaders) {
            expect(job.body, `${file}: job ${job.name} uploads with a deploy token but does not use \`checkout: none\``).toMatch(/^\s*-\s*checkout:\s*none\s*$/m);
            expect(runsRepositoryCode(job.body), `${file}: job ${job.name} uploads with a deploy token and also runs repository code`).toBe(false);
        }
    });

    it.each(pipelines)("%s gates every credentialed job on the fork status system variable", (file) => {
        const source = readFileSync(join(repoRoot, file), "utf8");
        const credentialed = jobsOf(source).filter((job) => declaredGroups(job.body).length > 0);

        expect(credentialed.length, `${file} has no job importing a variable group — the selector has drifted`).toBeGreaterThan(0);

        for (const job of credentialed) {
            // `System.PullRequest.IsFork` is read-only, so unlike an ordinary
            // pipeline variable it cannot be forged by `task.setvariable`.
            expect(job.body, `${file}: job ${job.name} imports a variable group without gating on System.PullRequest.IsFork`).toContain("variables['System.PullRequest.IsFork']");
        }
    });

    it.each(pipelines)("%s never lets a repository-set variable gate a deploy credential", (file) => {
        const source = readFileSync(join(repoRoot, file), "utf8");

        for (const job of jobsOf(source)) {
            if (!declaredGroups(job.body).includes("BabylonJS-Deployment")) {
                continue;
            }
            // `ArtifactsSafe` is set by a repository-authored script through
            // `##vso[task.setvariable]`, so PR code can set it too. It may gate
            // artifact publication; it must never gate the deploy token.
            expect(job.body, `${file}: job ${job.name} holds the deploy token and gates on ArtifactsSafe, which PR code can set`).not.toContain("ArtifactsSafe");
        }
    });

    it.each(pipelines)("%s keeps the deploy token out of every job that runs repository code", (file) => {
        const source = readFileSync(join(repoRoot, file), "utf8");

        for (const job of jobsOf(source)) {
            if (!runsRepositoryCode(job.body)) {
                continue;
            }
            expect(declaredGroups(job.body), `${file}: job ${job.name} runs repository code with a deployment variable group in scope`).not.toContain("BabylonJS-Deployment");
            expect(declaredGroups(job.body), `${file}: job ${job.name} runs repository code with an infrastructure variable group in scope`).not.toContain(
                "BabylonJS-CI-Infrastructure"
            );
        }
    });
});

describe("the job-block parser accepts and rejects the right shapes", () => {
    // The assertions above are only as good as the split that feeds them: a
    // parser that returns one giant block would smear a credentialed job's
    // properties across every other job and pass regardless.
    const sample = [
        "stages:",
        "    - stage: CI",
        "      jobs:",
        "          - job: Alpha",
        "            steps:",
        "                - script: pnpm install",
        "          - job: Beta",
        "            variables:",
        "                - group: BabylonJS-Deployment",
        "            steps:",
        "                - checkout: none",
    ].join("\n");

    it("separates adjacent jobs", () => {
        expect(jobsOf(sample).map((j) => j.name)).toEqual(["Alpha", "Beta"]);
    });

    it("keeps each job's own content in its own block", () => {
        const blocks = jobsOf(sample);
        const alpha = blocks[0];
        const beta = blocks[1];
        expect(alpha).toBeDefined();
        expect(beta).toBeDefined();
        expect(runsRepositoryCode(alpha!.body)).toBe(true);
        expect(runsRepositoryCode(beta!.body)).toBe(false);
        expect(declaredGroups(alpha!.body)).toEqual([]);
        expect(declaredGroups(beta!.body)).toEqual(["BabylonJS-Deployment"]);
    });

    it("recognises an upload template call only when it is a template step", () => {
        expect(callsUploadTemplate("          - template: config/templates/upload-static-site.yml")).toBe(true);
        expect(callsUploadTemplate("# see config/templates/upload-static-site.yml for the contract")).toBe(false);
    });
});
