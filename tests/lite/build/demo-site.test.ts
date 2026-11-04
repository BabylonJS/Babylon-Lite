import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildSingleDemo } from "../../../scripts/bundle-demos-core";
import { startStaticServer } from "../../../scripts/bundle-scenes-core";

const root = resolve(__dirname, "../../..");
const output = resolve(root, "lab/public/bundle/demos");
const basePaths = ["/", "/nested/lite-demos/"];
let site: string;
let server: Server | undefined;
let origin: string;

beforeAll(async () => {
    await buildSingleDemo("playroom");
    site = mkdtempSync(join(tmpdir(), "lite-demo-site-"));
    for (const basePath of basePaths) {
        const destination = join(site, basePath);
        mkdirSync(destination, { recursive: true });
        cpSync(join(output, "demo-playroom.html"), join(destination, "demo-playroom.html"));
        cpSync(join(output, "playroom.js"), join(destination, "playroom.js"));
        cpSync(join(output, "playroom/ui"), join(destination, "playroom/ui"), { recursive: true });
    }
    const started = await startStaticServer(site);
    server = started.server;
    origin = `http://127.0.0.1:${started.port}`;
}, 300_000);

afterAll(async () => {
    if (server) {
        await new Promise<void>((resolve, reject) => {
            server!.close((error) => (error ? reject(error) : resolve()));
        });
    }
    if (site) {
        rmSync(site, { recursive: true, force: true });
    }
});

describe("standalone demo deployment", () => {
    it.each(basePaths)("serves every Playroom HTML and CSS asset beneath %s without lab route aliases", async (basePath) => {
        const pageUrl = `${origin}${basePath}demo-playroom.html`;
        const response = await fetch(pageUrl);
        expect(response.status).toBe(200);
        const html = await response.text();
        const references = Array.from(html.matchAll(/(?:\b(?:src|data-landscape-src|data-portrait-src)=|url\()(["'])([^"']+)\1/g), (match) => match[2]!);
        const urls = [...new Set(references)];
        const imageUrls = urls.filter((url) => url.endsWith(".png"));
        expect(imageUrls.map((url) => basename(url)).sort()).toEqual(
            [
                "kick.png",
                "nextKickButton.png",
                "playAgain.png",
                "freemode.png",
                "loading.png",
                "havok_playButton_landscape_outlines.png",
                "havok_splash_landscape_outlines.png",
                "havok_splash_portrait_outlines.png",
            ].sort()
        );
        expect(html).toContain('src="./playroom.js"');
        const failures: string[] = [];
        for (const reference of urls) {
            const url = new URL(reference, pageUrl);
            expect(url.pathname.startsWith(basePath), reference).toBe(true);
            const asset = await fetch(url);
            if (asset.status !== 200) {
                failures.push(`${url.pathname}: ${asset.status}`);
                await asset.arrayBuffer();
                continue;
            }
            const bytes = Buffer.from(await asset.arrayBuffer());
            if (imageUrls.includes(reference)) {
                expect(asset.headers.get("content-type"), reference).toBe("image/png");
                expect(bytes, reference).toEqual(readFileSync(join(root, "lab/public/playroom/ui", basename(reference))));
            } else {
                expect(bytes, reference).toEqual(readFileSync(join(output, "playroom.js")));
            }
        }
        expect(failures).toEqual([]);
    });
});
