import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildSingleDemo } from "../../../scripts/bundle-demos-core";
import { startStaticServer } from "../../../scripts/bundle-scenes-core";

const root = resolve(__dirname, "../../..");
const output = resolve(root, "lab/public/bundle/demos");
const basePaths = ["/lite-demos/", "/nested/lite-demos/"];
const thumbnailUrl = "https://raw.githubusercontent.com/BabylonJS/Assets/6d2691d223b46b0218c51b159ee5a5ccbe0123bc/textures/lite/demo-ambient-occlusion.jpg";
let site: string;
let server: Server | undefined;
let origin: string;

beforeAll(async () => {
    await buildSingleDemo("ambient-occlusion", { debug: true });
    site = mkdtempSync(join(tmpdir(), "lite-ao-demo-site-"));
    for (const basePath of basePaths) {
        const destination = join(site, basePath);
        mkdirSync(destination, { recursive: true });
        for (const file of readdirSync(output)) {
            if (file.startsWith("ambient-occlusion") && file.endsWith(".js")) {
                cpSync(join(output, file), join(destination, file));
            }
        }
        for (const file of ["demo-ambient-occlusion.html", "index.html", "brdf-lut.png"]) {
            cpSync(join(output, file), join(destination, file));
        }
    }
    const started = await startStaticServer(site);
    server = started.server;
    origin = `http://127.0.0.1:${started.port}`;
}, 120_000);

afterAll(async () => {
    if (server) {
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) => {
            server!.close((error) => (error ? reject(error) : resolve()));
        });
    }
    if (site) {
        rmSync(site, { recursive: true, force: true });
    }
});

describe("Ambient Occlusion standalone deployment", () => {
    it("resolves its BRDF beside the module instead of at the site root", async () => {
        const code = readFileSync(join(output, "ambient-occlusion.js"), "utf8");
        expect(code).toContain('brdfUrl: demoAssetUrl("./brdf-lut.png", import.meta.url)');
        expect(code).not.toContain('brdfUrl: "/brdf-lut.png"');
        expect((await fetch(`${origin}/brdf-lut.png`)).status).toBe(404);
    });

    it("updates the direct light through the versioned setter", () => {
        const code = readFileSync(join(output, "ambient-occlusion.js"), "utf8");
        expect(code).toContain("setLightIntensity(sun, direct.checked ? 1.2 : 0)");
        expect(code).not.toContain("sun.intensity = direct.checked");
    });

    it.each(basePaths)("serves the demo, BRDF and hosted gallery reference under %s", async (basePath) => {
        const pageUrl = `${origin}${basePath}demo-ambient-occlusion.html`;
        const page = await fetch(pageUrl);
        expect(page.status).toBe(200);
        expect(await page.text()).toContain('src="./ambient-occlusion.js"');
        const script = await fetch(new URL("./ambient-occlusion.js", pageUrl));
        expect(script.status).toBe(200);
        const brdf = await fetch(new URL("./brdf-lut.png", script.url));
        expect(brdf.status).toBe(200);
        expect(brdf.headers.get("content-type")).toBe("image/png");
        expect(Buffer.from(await brdf.arrayBuffer())).toEqual(readFileSync(join(root, "lab/public/brdf-lut.png")));

        const index = await fetch(`${origin}${basePath}index.html`);
        expect(index.status).toBe(200);
        const html = await index.text();
        const card = html.match(/<article\b[\s\S]*?<\/article>/g)?.find((article) => article.includes('href="./demo-ambient-occlusion.html"'));
        expect(card).toBeDefined();
        expect(card!.match(/<img src="([^"]+)"/)?.[1]).toBe(thumbnailUrl);
        expect(html).toContain('<img src="thumbnails/demo-ocean.jpg"');
    });
});

describe("lab demo gallery thumbnails", () => {
    function renderLabCard(override?: string): string {
        const html = readFileSync(join(root, "lab/index.html"), "utf8");
        const escapeAttr = html.slice(html.indexOf("function escapeAttr(s)"), html.indexOf("function normalizeSearchText(s)"));
        const initDemosGrid = html.slice(html.indexOf("function initDemosGrid(demos)"), html.indexOf("// Build the Demos-tab filter pills"));
        const grid = { innerHTML: "" };
        runInNewContext(
            `${escapeAttr}\n${initDemosGrid}\ninitDemosGrid(demos);`,
            {
                document: { getElementById: () => grid },
                demos: [{ slug: "ambient-occlusion", name: "Ambient Occlusion", description: "", thumbnailUrl: override }],
                expBasePath: () => "/lite",
                normalizeSearchText: (s: string) => s,
                renderHideBtn: () => "",
                renderBadges: () => "",
                renderDemoFilterPills: () => {},
                DEMO_TAG_LABELS: {},
            },
            { timeout: 1000 }
        );
        return grid.innerHTML;
    }

    it("uses the same immutable Assets thumbnail as the standalone gallery", () => {
        const demos = JSON.parse(readFileSync(join(root, "demos-config.json"), "utf8")) as { slug: string; thumbnailUrl?: string }[];
        const ao = demos.find((demo) => demo.slug === "ambient-occlusion");
        expect(ao?.thumbnailUrl).toBe(thumbnailUrl);
        expect(renderLabCard(ao?.thumbnailUrl)).toContain(`<img src="${thumbnailUrl}"`);
    });

    it("preserves the lab-relative thumbnail fallback", () => {
        expect(renderLabCard()).toContain('<img src="/lite/thumbnails/demo-ambient-occlusion.jpg"');
    });

    it("HTML-escapes hosted thumbnail URLs", () => {
        expect(renderLabCard('https://example.test/ao.jpg?a=1&b="<ao>"')).toContain('<img src="https://example.test/ao.jpg?a=1&amp;b=&quot;&lt;ao&gt;&quot;"');
    });
});
