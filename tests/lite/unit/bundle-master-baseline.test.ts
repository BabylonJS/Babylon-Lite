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
        // find a legacy ref. What matters is that a 404 does not throw.
        await expect(resolveMasterBundleManifest()).resolves.not.toThrow();
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
