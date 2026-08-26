import { createServer, type Server } from "http";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { resolve } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { resolveMasterBundleManifest } from "../../../scripts/bundle-scenes-core";

/**
 * The master bundle-size baseline is published to a public URL instead of being
 * tracked in git. Nothing gates on it, so every failure mode here must degrade to
 * "no baseline" rather than throwing — otherwise an unreachable CDN would break
 * every build, which is exactly the class of failure this design removed.
 */

const VALID_MANIFEST = { scene1: { rawKB: 12.3, gzipKB: 4.5 }, scene2: { rawKB: 20, gzipKB: 8 } };

let server: Server;
let baseUrl: string;
let requestCount = 0;
const tempDirs: string[] = [];
let routes: Record<string, { status: number; contentType: string; body: string }> = {};

beforeEach(async () => {
    requestCount = 0;
    routes = {};
    // These cases exercise the mutable-baseline fetch in isolation, so the
    // per-commit lookup is switched off rather than left to depend on the git
    // state of whatever checkout the suite runs in. Its own behaviour is covered
    // by the "per-commit baseline" block below.
    process.env.BUNDLE_BASELINE_COMMIT = "";
    server = createServer((req, res) => {
        requestCount += 1;
        const route = routes[req.url ?? ""];
        if (!route) {
            res.writeHead(404, { "content-type": "text/plain" });
            res.end("not found");
            return;
        }
        res.writeHead(route.status, { "content-type": route.contentType });
        res.end(route.body);
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const address = server.address();
    if (typeof address === "string" || address === null) throw new Error("Expected a TCP address");
    baseUrl = `http://127.0.0.1:${address.port}`;
});

afterEach(async () => {
    delete process.env.BUNDLE_MASTER_MANIFEST_URL;
    delete process.env.BUNDLE_MASTER_MANIFEST_FILE;
    delete process.env.BUNDLE_BASELINE_COMMIT;
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
    await new Promise<void>((done, fail) => server.close((err) => (err ? fail(err) : done())));
});

function writeTempJson(name: string, contents: string): string {
    const dir = mkdtempSync(resolve(tmpdir(), "bundle-baseline-"));
    tempDirs.push(dir);
    const path = resolve(dir, name);
    writeFileSync(path, contents);
    return path;
}

describe("resolveMasterBundleManifest", () => {
    it("returns the published manifest when the URL serves one", async () => {
        routes["/manifest.json"] = { status: 200, contentType: "application/json", body: JSON.stringify(VALID_MANIFEST) };
        process.env.BUNDLE_MASTER_MANIFEST_URL = `${baseUrl}/manifest.json`;

        const baseline = await resolveMasterBundleManifest();

        expect(baseline?.manifest).toEqual(VALID_MANIFEST);
        expect(baseline?.source).toBe(`${baseUrl}/manifest.json`);
    });

    it("degrades to no baseline when master has not published one yet (404)", async () => {
        process.env.BUNDLE_MASTER_MANIFEST_URL = `${baseUrl}/never-published.json`;

        // No refs are passed, so the git fallback is consulted; in this repo it may
        // find a legacy ref. What matters is that a 404 degrades to a resolved
        // value instead of rejecting — awaiting is the assertion, since a rejection
        // fails the test on its own.
        await resolveMasterBundleManifest();
        expect(requestCount).toBe(1);
    });

    it("rejects a non-manifest response rather than trusting whatever parsed", async () => {
        // A CDN misconfiguration or SPA rewrite can return HTML, or JSON of the
        // wrong shape. Treating that as a baseline would silently produce a delta
        // report comparing against nonsense.
        const url = `${baseUrl}/manifest.json`;
        routes["/manifest.json"] = { status: 200, contentType: "application/json", body: JSON.stringify({ scene1: { notASize: true } }) };
        process.env.BUNDLE_MASTER_MANIFEST_URL = url;

        const baseline = await resolveMasterBundleManifest();

        // Asserted on `source` rather than on null: the git fallback still runs and
        // may legitimately find a legacy baseline. What must not happen is the
        // malformed HTTP response being adopted.
        expect(requestCount).toBe(1);
        expect(baseline?.source).not.toBe(url);
    });

    it("prefers BUNDLE_MASTER_MANIFEST_FILE over the network", async () => {
        routes["/manifest.json"] = { status: 200, contentType: "application/json", body: JSON.stringify(VALID_MANIFEST) };
        process.env.BUNDLE_MASTER_MANIFEST_URL = `${baseUrl}/manifest.json`;
        const fileManifest = { scene1: { rawKB: 99, gzipKB: 33 } };
        process.env.BUNDLE_MASTER_MANIFEST_FILE = writeTempJson("baseline.json", JSON.stringify(fileManifest));

        const baseline = await resolveMasterBundleManifest();

        expect(baseline?.manifest).toEqual(fileManifest);
        expect(requestCount).toBe(0);
    });

    it("falls through to the network when the named file is unreadable", async () => {
        routes["/manifest.json"] = { status: 200, contentType: "application/json", body: JSON.stringify(VALID_MANIFEST) };
        process.env.BUNDLE_MASTER_MANIFEST_URL = `${baseUrl}/manifest.json`;
        process.env.BUNDLE_MASTER_MANIFEST_FILE = writeTempJson("broken.json", "{ not json");

        const baseline = await resolveMasterBundleManifest();

        expect(baseline?.manifest).toEqual(VALID_MANIFEST);
    });

    it("skips the fetch entirely when the URL is explicitly blanked", async () => {
        // `requestCount` alone would not prove this: `fetch("")` throws before it
        // reaches the network, so it stays 0 either way. The observable difference
        // is that no fetch failure is reported.
        process.env.BUNDLE_MASTER_MANIFEST_URL = "";
        const warnings: string[] = [];
        const originalWarn = console.warn;
        console.warn = (...args: unknown[]) => void warnings.push(args.join(" "));

        try {
            await resolveMasterBundleManifest();
        } finally {
            console.warn = originalWarn;
        }

        expect(requestCount).toBe(0);
        expect(warnings.filter((line) => line.includes("Could not fetch the bundle-size baseline"))).toEqual([]);
    });
});

/**
 * The mutable baseline is whatever master published most recently, which after any
 * intervening merge is not the commit the PR under test was merged with. Every byte
 * master moved in between then lands in the PR's delta. The publisher writes an
 * immutable copy per commit so a build can ask for its own base commit instead.
 */
describe("resolveMasterBundleManifest — per-commit baseline", () => {
    const COMMIT = "c4284aa6c4284aa6c4284aa6c4284aa6c4284aa6";
    /** What master published for the commit this build was actually merged with. */
    const BASE_MANIFEST = { scene1: { rawKB: 12.3, gzipKB: 4.5, ceilingKB: 13 } };
    /** What master has published since — includes another PR's bytes. */
    const LATEST_MANIFEST = { scene1: { rawKB: 99.9, gzipKB: 40 } };

    it("prefers the baseline published for this build's base commit", async () => {
        routes[`/${COMMIT}/manifest.json`] = { status: 200, contentType: "application/json", body: JSON.stringify(BASE_MANIFEST) };
        routes["/manifest.json"] = { status: 200, contentType: "application/json", body: JSON.stringify(LATEST_MANIFEST) };
        process.env.BUNDLE_MASTER_MANIFEST_URL = `${baseUrl}/manifest.json`;
        process.env.BUNDLE_BASELINE_COMMIT = COMMIT;

        const baseline = await resolveMasterBundleManifest();

        // The whole point: the newer, closer-to-hand manifest is the wrong answer.
        expect(baseline?.manifest).toEqual(BASE_MANIFEST);
        expect(baseline?.source).toBe(`${baseUrl}/${COMMIT}/manifest.json`);
    });

    it("carries the ceilings the baseline was measured against", async () => {
        // Without this the only ceiling a consumer can see is its own working tree's,
        // so a PR that tightens a ceiling makes master look retroactively in breach.
        routes[`/${COMMIT}/manifest.json`] = { status: 200, contentType: "application/json", body: JSON.stringify(BASE_MANIFEST) };
        process.env.BUNDLE_MASTER_MANIFEST_URL = `${baseUrl}/manifest.json`;
        process.env.BUNDLE_BASELINE_COMMIT = COMMIT;

        const baseline = await resolveMasterBundleManifest();

        expect(baseline?.manifest.scene1?.ceilingKB).toBe(13);
    });

    it("falls back to the mutable baseline when the base commit has none, and says so", async () => {
        // A base commit has no baseline whenever master's build is still running,
        // failed, or predates per-commit publishing. That must degrade, not wait or
        // fail — but silently degrading is what causes mis-attributed deltas, so the
        // fallback has to announce itself.
        routes["/manifest.json"] = { status: 200, contentType: "application/json", body: JSON.stringify(LATEST_MANIFEST) };
        process.env.BUNDLE_MASTER_MANIFEST_URL = `${baseUrl}/manifest.json`;
        process.env.BUNDLE_BASELINE_COMMIT = COMMIT;

        const warnings: string[] = [];
        const originalWarn = console.warn;
        console.warn = (...args: unknown[]) => void warnings.push(args.join(" "));
        let baseline;
        try {
            baseline = await resolveMasterBundleManifest();
        } finally {
            console.warn = originalWarn;
        }

        expect(baseline?.manifest).toEqual(LATEST_MANIFEST);
        expect(baseline?.source).toBe(`${baseUrl}/manifest.json`);
        expect(warnings.some((line) => line.includes("no baseline was published for this build's base commit"))).toBe(true);
    });

    it("does not warn about the per-commit miss as if the baseline were unreachable", async () => {
        // The per-commit probe 404s on most builds today. Reporting each one the way
        // a missing baseline is reported would train readers to ignore the message
        // that actually means the delta is unavailable.
        routes["/manifest.json"] = { status: 200, contentType: "application/json", body: JSON.stringify(LATEST_MANIFEST) };
        process.env.BUNDLE_MASTER_MANIFEST_URL = `${baseUrl}/manifest.json`;
        process.env.BUNDLE_BASELINE_COMMIT = COMMIT;

        const warnings: string[] = [];
        const originalWarn = console.warn;
        console.warn = (...args: unknown[]) => void warnings.push(args.join(" "));
        try {
            await resolveMasterBundleManifest();
        } finally {
            console.warn = originalWarn;
        }

        expect(warnings.filter((line) => line.includes("No published bundle-size baseline at"))).toEqual([]);
    });

    it("costs exactly one extra request when the base commit has no baseline", async () => {
        routes["/manifest.json"] = { status: 200, contentType: "application/json", body: JSON.stringify(LATEST_MANIFEST) };
        process.env.BUNDLE_MASTER_MANIFEST_URL = `${baseUrl}/manifest.json`;
        process.env.BUNDLE_BASELINE_COMMIT = COMMIT;

        await resolveMasterBundleManifest();

        expect(requestCount).toBe(2);
    });

    it("ignores a malformed BUNDLE_BASELINE_COMMIT instead of fetching a bogus path", async () => {
        // A short SHA, a branch name, or a stray "refs/heads/master" must not become
        // part of a URL — the published layout only ever uses full object names.
        routes["/manifest.json"] = { status: 200, contentType: "application/json", body: JSON.stringify(LATEST_MANIFEST) };
        process.env.BUNDLE_MASTER_MANIFEST_URL = `${baseUrl}/manifest.json`;
        process.env.BUNDLE_BASELINE_COMMIT = "origin/master";

        const warnings: string[] = [];
        const originalWarn = console.warn;
        console.warn = (...args: unknown[]) => void warnings.push(args.join(" "));
        let baseline;
        try {
            baseline = await resolveMasterBundleManifest();
        } finally {
            console.warn = originalWarn;
        }

        expect(requestCount).toBe(1);
        expect(baseline?.source).toBe(`${baseUrl}/manifest.json`);
        // Reporting "no baseline was published for this build's base commit" here would
        // send the reader to the publisher for a fault that is in this build's own
        // configuration, so the two fallback reasons have to stay distinguishable.
        expect(warnings.some((line) => line.includes("base commit could not be determined"))).toBe(true);
    });

    it("reports an explicit opt-out as a setting rather than as a fault", async () => {
        // beforeEach blanks BUNDLE_BASELINE_COMMIT, which is the documented off
        // switch. Describing that as "could not be determined" would send a reader
        // looking for a broken checkout to explain a value someone set on purpose.
        routes["/manifest.json"] = { status: 200, contentType: "application/json", body: JSON.stringify(LATEST_MANIFEST) };
        process.env.BUNDLE_MASTER_MANIFEST_URL = `${baseUrl}/manifest.json`;

        const warnings: string[] = [];
        const originalWarn = console.warn;
        console.warn = (...args: unknown[]) => void warnings.push(args.join(" "));
        try {
            await resolveMasterBundleManifest();
        } finally {
            console.warn = originalWarn;
        }

        expect(requestCount).toBe(1);
        expect(warnings.some((line) => line.includes("switched off for this run"))).toBe(true);
        expect(warnings.some((line) => line.includes("could not be determined"))).toBe(false);
    });

    it("does not adopt a malformed per-commit response", async () => {
        routes[`/${COMMIT}/manifest.json`] = { status: 200, contentType: "application/json", body: "<html>nope</html>" };
        routes["/manifest.json"] = { status: 200, contentType: "application/json", body: JSON.stringify(LATEST_MANIFEST) };
        process.env.BUNDLE_MASTER_MANIFEST_URL = `${baseUrl}/manifest.json`;
        process.env.BUNDLE_BASELINE_COMMIT = COMMIT;

        const baseline = await resolveMasterBundleManifest();

        expect(baseline?.manifest).toEqual(LATEST_MANIFEST);
    });
});
