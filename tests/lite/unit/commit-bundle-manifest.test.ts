/**
 * End-to-end coverage for scripts/commit-bundle-manifest.ts against a local bare
 * "remote". The script's whole job is a git dance that is hard to eyeball —
 * fetching the current tip of master, adding a detached worktree so commits that
 * landed during the (very long) measurement are never dropped, mirroring the
 * manifest dir, and pushing with a retry — so exercise it for real rather than
 * mocking git.
 */
import { execFileSync } from "child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { resolve } from "path";
import { afterEach, describe, expect, it } from "vitest";

const ROOT = resolve(__dirname, "../../..");
const SCRIPT = resolve(ROOT, "scripts/commit-bundle-manifest.ts");
const TSX = resolve(ROOT, "node_modules/tsx/dist/cli.mjs");
const MANIFEST_REL = "lab/public/bundle/manifest";
const BOT_SUBJECT = "chore(bundle): refresh per-scene bundle-size manifest";

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
    /** Working checkout, detached at the triggering commit like a master CI build. */
    work: string;
    /** Scratch clone used to land commits on the remote behind the build's back. */
    seed: string;
    branch: string;
    /** Tip of master at the moment the build started. */
    startSha: string;
}

/**
 * Build: a bare remote holding `master`, and a working checkout detached at its
 * tip — what an Azure build triggered by a push to master sees.
 */
function makeFixture(): Fixture {
    const base = mkdtempSync(resolve(tmpdir(), "commit-bundle-manifest-"));
    tempDirs.push(base);
    const remote = resolve(base, "remote.git");
    const seed = resolve(base, "seed");
    const work = resolve(base, "work");
    const branch = "master";

    execFileSync("git", ["init", "-q", "--bare", "-b", branch, remote]);

    execFileSync("git", ["init", "-q", "-b", branch, seed]);
    git(seed, ["config", "user.email", "seed@example.com"]);
    git(seed, ["config", "user.name", "seed"]);
    writeManifest(seed, "scene1", { rawKB: 88.4, rawBytes: 90550 });
    writeFileSync(resolve(seed, "README.md"), "seed\n");
    git(seed, ["add", "-A"]);
    git(seed, ["commit", "-qm", "master baseline"]);
    git(seed, ["push", "-q", remote, branch]);

    execFileSync("git", ["clone", "-q", remote, work]);
    git(work, ["config", "user.email", "ci@example.com"]);
    git(work, ["config", "user.name", "ci"]);
    git(work, ["checkout", "-q", "--detach", "HEAD"]);

    return { remote, work, seed, branch, startSha: git(work, ["rev-parse", "HEAD"]) };
}

/** Land a commit on the remote's master, simulating another merge during the build. */
function advanceMaster(fixture: Fixture, file: string): string {
    git(fixture.seed, ["fetch", "-q", fixture.remote, fixture.branch]);
    git(fixture.seed, ["checkout", "-q", "-B", fixture.branch, "FETCH_HEAD"]);
    writeFileSync(resolve(fixture.seed, file), "export const x = 1;\n");
    git(fixture.seed, ["add", "-A"]);
    git(fixture.seed, ["commit", "-qm", `feat: ${file}`]);
    git(fixture.seed, ["push", "-q", fixture.remote, fixture.branch]);
    return git(fixture.seed, ["rev-parse", "HEAD"]);
}

/**
 * Stage a commit on the remote without moving `master`: the objects land under a
 * side ref so a hook can fast-forward `master` onto them mid-push.
 */
function stageMasterMove(fixture: Fixture, file: string): string {
    git(fixture.seed, ["fetch", "-q", fixture.remote, fixture.branch]);
    git(fixture.seed, ["checkout", "-q", "-B", "staging", "FETCH_HEAD"]);
    writeFileSync(resolve(fixture.seed, file), "export const x = 1;\n");
    git(fixture.seed, ["add", "-A"]);
    git(fixture.seed, ["commit", "-qm", `feat: ${file}`]);
    git(fixture.seed, ["push", "-q", fixture.remote, "staging:refs/heads/staging"]);
    return git(fixture.seed, ["rev-parse", "HEAD"]);
}

/**
 * Install a pre-receive hook that rejects the first `rejectCount` pushes, so the
 * retry path runs against a genuinely rejected push rather than a simulated one.
 *
 * When `moveMasterTo` is given the hook also advances `master` onto that commit
 * as it rejects — reproducing the race the retry exists for: another merge lands
 * between our fetch and our push. Without this the retry would re-push the same
 * parent and the test could not tell a re-fetch from a reuse of the stale tip.
 */
function rejectPushes(fixture: Fixture, rejectCount: number, moveMasterTo?: string): void {
    const counter = resolve(fixture.remote, "push-attempts");
    const hooksDir = resolve(fixture.remote, "hooks");
    mkdirSync(hooksDir, { recursive: true });
    const hook = resolve(hooksDir, "pre-receive");
    const move = moveMasterTo
        ? // `update-ref` is refused inside receive-pack's object quarantine; the
          // commit we point at is already in the remote's odb, so leaving the
          // quarantine is safe here.
          `  (unset GIT_QUARANTINE_PATH; git update-ref refs/heads/${fixture.branch} ${moveMasterTo})\n`
        : "";
    writeFileSync(
        hook,
        `#!/bin/sh
n=$(cat "${counter}" 2>/dev/null || echo 0)
n=$((n+1))
echo "$n" > "${counter}"
if [ "$n" -le ${rejectCount} ]; then
${move}  echo "test hook: rejecting push $n" >&2
  exit 1
fi
exit 0
`
    );
    chmodSync(hook, 0o755);
}

function pushAttempts(fixture: Fixture): number {
    try {
        return Number(readFileSync(resolve(fixture.remote, "push-attempts"), "utf-8").trim());
    } catch {
        return 0;
    }
}

function runScript(fixture: Fixture, env: Record<string, string> = {}): string {
    return execFileSync(process.execPath, [TSX, SCRIPT], {
        cwd: fixture.work,
        encoding: "utf-8",
        env: {
            ...process.env,
            BUNDLE_MANIFEST_ROOT: fixture.work,
            BUNDLE_MANIFEST_REMOTE_URL: fixture.remote,
            BUNDLE_MANIFEST_BRANCH: fixture.branch,
            // A master build has no pull-request variables set.
            SYSTEM_PULLREQUEST_SOURCEBRANCH: "",
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
    it("pushes the freshly measured manifest onto master", () => {
        const fixture = makeFixture();
        writeManifest(fixture.work, "scene1", { rawKB: 91.2, rawBytes: 93400 });

        const output = runScript(fixture);
        expect(output).toContain("Pushed refreshed bundle-size manifest");

        expect(JSON.parse(showOnRemote(fixture, `${MANIFEST_REL}/scene1.json`))).toMatchObject({ rawBytes: 93400 });
        expect(gitRemote(fixture, ["log", "-1", "--format=%s", fixture.branch])).toBe(BOT_SUBJECT);
    });

    it("refuses to write the manifest on a pull-request build", () => {
        const fixture = makeFixture();
        writeManifest(fixture.work, "scene1", { rawKB: 91.2, rawBytes: 93400 });
        const before = gitRemote(fixture, ["rev-parse", fixture.branch]);

        // The whole point of the master-only design: PR diffs must never carry
        // generated manifest files, because that is what makes branches conflict.
        const output = runScript(fixture, { SYSTEM_PULLREQUEST_SOURCEBRANCH: "refs/heads/some-pr" });

        expect(output).toContain("Pull-request build");
        expect(gitRemote(fixture, ["rev-parse", fixture.branch])).toBe(before);
    });

    it("never drops commits that landed on master during the measurement", () => {
        const fixture = makeFixture();
        writeManifest(fixture.work, "scene1", { rawKB: 91.2, rawBytes: 93400 });

        // Another PR merges while this build is still measuring. The build's own
        // checkout is now stale; committing there would either be rejected or,
        // if forced, silently discard the commit that landed.
        const movedSha = advanceMaster(fixture, "landed-during-build.ts");

        runScript(fixture);

        expect(gitRemote(fixture, ["rev-parse", `${fixture.branch}^`])).toBe(movedSha);
        expect(() => showOnRemote(fixture, "landed-during-build.ts")).not.toThrow();
        expect(JSON.parse(showOnRemote(fixture, `${MANIFEST_REL}/scene1.json`))).toMatchObject({ rawBytes: 93400 });
    });

    it("re-applies onto the tip that moved underneath a rejected push", () => {
        const fixture = makeFixture();
        writeManifest(fixture.work, "scene1", { rawKB: 91.2, rawBytes: 93400 });

        // The race the retry exists for: our push is rejected precisely because
        // another merge landed between our fetch and our push. Staging the commit
        // first keeps master still until the hook fast-forwards it mid-rejection,
        // so attempt 2 must re-fetch to see it.
        const movedSha = stageMasterMove(fixture, "landed-mid-push.ts");
        rejectPushes(fixture, 1, movedSha);

        const output = runScript(fixture);

        expect(output).toContain("re-applying onto the new tip");
        expect(output).toContain("Pushed refreshed bundle-size manifest");
        expect(pushAttempts(fixture)).toBe(2);
        // Built on the *new* tip, not the stale one we fetched on attempt 1.
        expect(gitRemote(fixture, ["rev-parse", `${fixture.branch}^`])).toBe(movedSha);
        expect(() => showOnRemote(fixture, "landed-mid-push.ts")).not.toThrow();
        expect(JSON.parse(showOnRemote(fixture, `${MANIFEST_REL}/scene1.json`))).toMatchObject({ rawBytes: 93400 });
    });

    it("gives up with a warning rather than looping forever on a rejected push", () => {
        const fixture = makeFixture();
        writeManifest(fixture.work, "scene1", { rawKB: 91.2, rawBytes: 93400 });
        const before = gitRemote(fixture, ["rev-parse", fixture.branch]);
        rejectPushes(fixture, 99);

        const output = runScript(fixture);

        expect(output).toContain("Could not push the refreshed bundle-size manifest");
        expect(pushAttempts(fixture)).toBe(3);
        expect(gitRemote(fixture, ["rev-parse", fixture.branch])).toBe(before);
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

    it("does nothing when master's manifest already matches", () => {
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

    it("stops after consecutive bot commits measured from the same revision", () => {
        const fixture = makeFixture();
        const rev = "a".repeat(40);
        writeManifest(fixture.work, "scene1", { rawKB: 91.2, rawBytes: 93400 });
        runScript(fixture, { BUILD_SOURCEVERSION: rev });
        writeManifest(fixture.work, "scene1", { rawKB: 91.3, rawBytes: 93500 });
        runScript(fixture, { BUILD_SOURCEVERSION: rev });
        const before = gitRemote(fixture, ["rev-parse", fixture.branch]);

        writeManifest(fixture.work, "scene1", { rawKB: 91.4, rawBytes: 93600 });
        const output = runScript(fixture, { BUILD_SOURCEVERSION: rev });

        expect(output).toContain("Not pushing");
        expect(gitRemote(fixture, ["rev-parse", fixture.branch])).toBe(before);
    });

    it("still pushes when the leading bot commits came from a different revision", () => {
        const fixture = makeFixture();
        const older = "a".repeat(40);
        writeManifest(fixture.work, "scene1", { rawKB: 91.2, rawBytes: 93400 });
        runScript(fixture, { BUILD_SOURCEVERSION: older });
        writeManifest(fixture.work, "scene1", { rawKB: 91.3, rawBytes: 93500 });
        runScript(fixture, { BUILD_SOURCEVERSION: older });

        // Concurrent master builds stack bot commits, so a run of them is normal
        // and must not be mistaken for our own measurement failing to converge.
        writeManifest(fixture.work, "scene1", { rawKB: 91.4, rawBytes: 93600 });
        const output = runScript(fixture, { BUILD_SOURCEVERSION: "b".repeat(40) });

        expect(output).not.toContain("Not pushing");
        expect(JSON.parse(showOnRemote(fixture, `${MANIFEST_REL}/scene1.json`))).toMatchObject({ rawBytes: 93600 });
    });

    it("honours AUTO_COMMIT_BUNDLE_MANIFEST=false", () => {
        const fixture = makeFixture();
        writeManifest(fixture.work, "scene1", { rawKB: 91.2, rawBytes: 93400 });
        const before = gitRemote(fixture, ["rev-parse", fixture.branch]);

        const output = runScript(fixture, { AUTO_COMMIT_BUNDLE_MANIFEST: "false" });
        expect(output).toContain("AUTO_COMMIT_BUNDLE_MANIFEST=false");
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

        runScript(fixture);

        expect(git(fixture.work, ["rev-parse", "HEAD"])).toBe(fixture.startSha);
        expect(JSON.parse(readFileSync(resolve(fixture.work, MANIFEST_REL, "scene1.json"), "utf-8"))).toMatchObject({ rawBytes: 93400 });
        expect(git(fixture.work, ["worktree", "list"]).split("\n")).toHaveLength(1);
    });
});
