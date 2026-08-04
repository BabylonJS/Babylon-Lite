/**
 * End-to-end coverage for scripts/commit-bundle-manifest.ts against a local bare
 * "remote". The script's whole job is a git dance that is hard to eyeball —
 * fetching the PR head, adding a detached worktree so the PR *merge* commit is
 * never pushed onto the contributor's branch, mirroring the manifest dir, and
 * pushing — so exercise it for real rather than mocking git.
 */
import { execFileSync } from "child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { resolve } from "path";
import { afterEach, describe, expect, it } from "vitest";

const ROOT = resolve(__dirname, "../../..");
const SCRIPT = resolve(ROOT, "scripts/commit-bundle-manifest.ts");
const TSX = resolve(ROOT, "node_modules/tsx/dist/cli.mjs");
const MANIFEST_REL = "lab/public/bundle/manifest";

const tempDirs: string[] = [];

afterEach(() => {
    while (tempDirs.length > 0) {
        rmSync(tempDirs.pop()!, { recursive: true, force: true });
    }
});

function git(cwd: string, args: string[]): string {
    return execFileSync("git", args, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/** Query the bare "remote" explicitly — `safe.bareRepository=explicit` rejects a bare cwd. */
function gitRemote(fixture: Fixture, args: string[]): string {
    return execFileSync("git", ["--git-dir", fixture.remote, ...args], { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function writeManifest(dir: string, scene: string, entry: unknown): void {
    mkdirSync(resolve(dir, MANIFEST_REL), { recursive: true });
    writeFileSync(resolve(dir, MANIFEST_REL, `${scene}.json`), `${JSON.stringify(entry, null, 2)}\n`);
}

interface Fixture {
    /** Bare repo standing in for GitHub. */
    remote: string;
    /** Working checkout, left on a detached PR-merge commit like an Azure PR build. */
    work: string;
    branch: string;
    /** The PR branch tip before the script runs — the only legal parent for the bot commit. */
    prHead: string;
}

/**
 * Build: a bare remote holding `master` plus a PR branch, and a working checkout
 * sitting on the merge of that branch into master (detached HEAD), exactly like
 * an Azure DevOps PR build.
 *
 * `master` deliberately moves *after* the branch point and adds `master-only.ts`,
 * so the merge commit carries content the PR branch has never seen. That is what
 * makes it possible to detect an implementation that commits on the merge commit
 * and pushes it — such a push is a fast-forward and would silently drag master
 * into the contributor's branch.
 */
function makeFixture(): Fixture {
    const base = mkdtempSync(resolve(tmpdir(), "commit-bundle-manifest-"));
    tempDirs.push(base);
    const remote = resolve(base, "remote.git");
    const seed = resolve(base, "seed");
    const work = resolve(base, "work");
    const branch = "pr-branch";

    execFileSync("git", ["init", "-q", "--bare", "-b", "master", remote]);

    execFileSync("git", ["init", "-q", "-b", "master", seed]);
    git(seed, ["config", "user.email", "seed@example.com"]);
    git(seed, ["config", "user.name", "seed"]);
    writeManifest(seed, "scene1", { rawKB: 88.4, rawBytes: 90550 });
    writeFileSync(resolve(seed, "README.md"), "seed\n");
    git(seed, ["add", "-A"]);
    git(seed, ["commit", "-qm", "master baseline"]);

    git(seed, ["checkout", "-qb", branch]);
    writeFileSync(resolve(seed, "feature.ts"), "export const feature = 1;\n");
    git(seed, ["add", "-A"]);
    git(seed, ["commit", "-qm", "feat: add a feature"]);
    const prHead = git(seed, ["rev-parse", "HEAD"]);

    git(seed, ["checkout", "-q", "master"]);
    writeFileSync(resolve(seed, "master-only.ts"), "export const masterOnly = 1;\n");
    git(seed, ["add", "-A"]);
    git(seed, ["commit", "-qm", "chore: master moves on"]);

    git(seed, ["push", "-q", remote, "master", branch]);

    execFileSync("git", ["clone", "-q", remote, work]);
    git(work, ["config", "user.email", "ci@example.com"]);
    git(work, ["config", "user.name", "ci"]);
    // Reproduce the PR merge commit Azure checks out, then detach from it.
    git(work, ["checkout", "-q", "master"]);
    git(work, ["merge", "-q", "--no-ff", "-m", "Merge pr-branch", `origin/${branch}`]);
    git(work, ["checkout", "-q", "--detach", "HEAD"]);

    return { remote, work, branch, prHead };
}

function runScript(fixture: Fixture, env: Record<string, string> = {}): string {
    return execFileSync(process.execPath, [TSX, SCRIPT], {
        cwd: fixture.work,
        encoding: "utf-8",
        env: {
            ...process.env,
            BUNDLE_MANIFEST_ROOT: fixture.work,
            BUNDLE_MANIFEST_REMOTE_URL: fixture.remote,
            SYSTEM_PULLREQUEST_SOURCEBRANCH: `refs/heads/${fixture.branch}`,
            SYSTEM_PULLREQUEST_ISFORK: "False",
            AUTO_COMMIT_BUNDLE_MANIFEST: "true",
            DRY_RUN: "",
            ...env,
        },
        stdio: ["ignore", "pipe", "pipe"],
    });
}

/** Read a file from the branch tip on the bare remote. */
function showOnRemote(fixture: Fixture, path: string): string {
    return gitRemote(fixture, ["show", `${fixture.branch}:${path}`]);
}

describe("commit-bundle-manifest", () => {
    it("pushes the freshly measured manifest onto the PR branch", () => {
        const fixture = makeFixture();
        writeManifest(fixture.work, "scene1", { rawKB: 91.2, rawBytes: 93400 });

        const output = runScript(fixture);
        expect(output).toContain("Pushed refreshed bundle-size manifest");

        expect(JSON.parse(showOnRemote(fixture, `${MANIFEST_REL}/scene1.json`))).toMatchObject({ rawBytes: 93400 });
    });

    it("never pushes the PR merge commit onto the contributor's branch", () => {
        const fixture = makeFixture();
        writeManifest(fixture.work, "scene1", { rawKB: 91.2, rawBytes: 93400 });
        runScript(fixture);

        // The bot commit must sit directly on the PR head. If it were made on the
        // build's own checkout — the merge of the PR into master — the push would
        // still fast-forward, silently dragging master into the contributor's branch.
        expect(gitRemote(fixture, ["rev-parse", `${fixture.branch}^`])).toBe(fixture.prHead);
        expect(gitRemote(fixture, ["log", "-1", "--format=%s", fixture.branch])).toBe("chore(bundle): refresh per-scene bundle-size manifest");

        // Master-only content must not have arrived on the branch; the branch's own
        // content must still be there.
        expect(() => showOnRemote(fixture, "master-only.ts")).toThrow();
        expect(() => showOnRemote(fixture, "feature.ts")).not.toThrow();
    });

    it("mirrors added and removed scenes", () => {
        const fixture = makeFixture();
        rmSync(resolve(fixture.work, MANIFEST_REL, "scene1.json"));
        writeManifest(fixture.work, "scene2", { rawKB: 10, rawBytes: 10240 });
        writeManifest(fixture.work, "scene3", { rawKB: 11, rawBytes: 11264 });

        runScript(fixture);

        const files = gitRemote(fixture, ["ls-tree", "--name-only", `${fixture.branch}:${MANIFEST_REL}`]).split("\n");
        expect(files.sort()).toEqual(["scene2.json", "scene3.json"]);
    });

    it("does nothing when the branch manifest already matches", () => {
        const fixture = makeFixture();
        const before = gitRemote(fixture, ["rev-parse", fixture.branch]);

        const output = runScript(fixture);
        expect(output).toContain("already matches this build");
        expect(gitRemote(fixture, ["rev-parse", fixture.branch])).toBe(before);
    });

    it("refuses to mirror an incomplete build rather than deleting live entries", () => {
        const fixture = makeFixture();
        for (const scene of ["scene2", "scene3", "scene4", "scene5"]) {
            writeManifest(fixture.work, scene, { rawKB: 1, rawBytes: 1024 });
        }
        runScript(fixture);
        const before = gitRemote(fixture, ["rev-parse", fixture.branch]);

        // Simulate a filtered/partial rebuild that only regenerated one scene.
        for (const scene of ["scene2", "scene3", "scene4", "scene5"]) {
            rmSync(resolve(fixture.work, MANIFEST_REL, `${scene}.json`));
        }
        writeManifest(fixture.work, "scene1", { rawKB: 99, rawBytes: 101376 });

        const output = runScript(fixture);
        expect(output).toContain("looks like an incomplete build");
        expect(gitRemote(fixture, ["rev-parse", fixture.branch])).toBe(before);
    });

    it("stops after consecutive bot commits instead of ping-ponging", () => {
        const fixture = makeFixture();
        writeManifest(fixture.work, "scene1", { rawKB: 91.2, rawBytes: 93400 });
        runScript(fixture);
        writeManifest(fixture.work, "scene1", { rawKB: 91.3, rawBytes: 93500 });
        runScript(fixture);
        const before = gitRemote(fixture, ["rev-parse", fixture.branch]);

        writeManifest(fixture.work, "scene1", { rawKB: 91.4, rawBytes: 93600 });
        const output = runScript(fixture);

        expect(output).toContain("Not pushing again");
        expect(gitRemote(fixture, ["rev-parse", fixture.branch])).toBe(before);
    });

    it("skips outside a pull-request build", () => {
        const fixture = makeFixture();
        writeManifest(fixture.work, "scene1", { rawKB: 91.2, rawBytes: 93400 });
        const before = gitRemote(fixture, ["rev-parse", fixture.branch]);

        const output = runScript(fixture, { SYSTEM_PULLREQUEST_SOURCEBRANCH: "" });
        expect(output).toContain("Not a pull-request build");
        expect(gitRemote(fixture, ["rev-parse", fixture.branch])).toBe(before);
    });

    it("skips fork pull requests, which it cannot push to", () => {
        const fixture = makeFixture();
        writeManifest(fixture.work, "scene1", { rawKB: 91.2, rawBytes: 93400 });
        const before = gitRemote(fixture, ["rev-parse", fixture.branch]);

        const output = runScript(fixture, { SYSTEM_PULLREQUEST_ISFORK: "True" });
        expect(output).toContain("Fork pull request");
        expect(gitRemote(fixture, ["rev-parse", fixture.branch])).toBe(before);
    });

    it("honours DRY_RUN", () => {
        const fixture = makeFixture();
        writeManifest(fixture.work, "scene1", { rawKB: 91.2, rawBytes: 93400 });
        const before = gitRemote(fixture, ["rev-parse", fixture.branch]);

        const output = runScript(fixture, { DRY_RUN: "true" });
        expect(output).toContain("[dry-run]");
        expect(gitRemote(fixture, ["rev-parse", fixture.branch])).toBe(before);
    });

    it("leaves the build's own working tree untouched", () => {
        const fixture = makeFixture();
        writeManifest(fixture.work, "scene1", { rawKB: 91.2, rawBytes: 93400 });
        const headBefore = git(fixture.work, ["rev-parse", "HEAD"]);

        runScript(fixture);

        expect(git(fixture.work, ["rev-parse", "HEAD"])).toBe(headBefore);
        expect(JSON.parse(readFileSync(resolve(fixture.work, MANIFEST_REL, "scene1.json"), "utf-8"))).toMatchObject({ rawBytes: 93400 });
        expect(git(fixture.work, ["worktree", "list"]).split("\n")).toHaveLength(1);
    });
});
