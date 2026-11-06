import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { ScriptTarget, transpileModule } from "typescript";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildSingleDemo } from "../../../scripts/bundle-demos-core";
import { startStaticServer } from "../../../scripts/bundle-scenes-core";

const root = resolve(__dirname, "../../..");
const output = resolve(root, "lab/public/bundle/demos");
const basePaths = ["/lite-demos/", "/nested/lite-demos/"];
let site: string;
let server: Server | undefined;
let origin: string;

beforeAll(async () => {
    await buildSingleDemo("ambient-occlusion", { debug: true });
    site = mkdtempSync(join(tmpdir(), "lite-ao-demo-site-"));
    for (const basePath of basePaths) {
        const destination = join(site, basePath);
        mkdirSync(join(destination, "thumbnails"), { recursive: true });
        for (const file of readdirSync(output)) {
            if (file.startsWith("ambient-occlusion") && file.endsWith(".js")) {
                cpSync(join(output, file), join(destination, file));
            }
        }
        for (const file of ["demo-ambient-occlusion.html", "index.html", "brdf-lut.png", "thumbnails/demo-ambient-occlusion.jpg"]) {
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

    it.each(basePaths)("serves the demo, BRDF and local gallery thumbnail under %s", async (basePath) => {
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
        const thumbnail = card!.match(/<img src="([^"]+)"/)?.[1];
        expect(thumbnail).toBe("thumbnails/demo-ambient-occlusion.jpg");
        const image = await fetch(new URL(thumbnail!, index.url));
        expect(image.status).toBe(200);
        expect(image.headers.get("content-type")).toBe("image/jpeg");
        expect(Buffer.from(await image.arrayBuffer())).toEqual(readFileSync(join(root, "lab/public/thumbnails/demo-ambient-occlusion.jpg")));
        expect(html).toContain('<img src="thumbnails/demo-ocean.jpg"');
    });
});

describe("lab demo gallery thumbnails", () => {
    it("uses the demo's local thumbnail in the lab Demos tab", () => {
        const html = readFileSync(join(root, "lab/index.html"), "utf8");
        const escapeAttr = html.slice(html.indexOf("function escapeAttr(s)"), html.indexOf("function normalizeSearchText(s)"));
        const initDemosGrid = html.slice(html.indexOf("function initDemosGrid(demos)"), html.indexOf("// Build the Demos-tab filter pills"));
        const grid = { innerHTML: "" };
        runInNewContext(
            `${escapeAttr}\n${initDemosGrid}\ninitDemosGrid(demos);`,
            {
                document: { getElementById: () => grid },
                demos: [{ slug: "ambient-occlusion", name: "Ambient Occlusion", description: "" }],
                expBasePath: () => "/lite",
                normalizeSearchText: (s: string) => s,
                renderHideBtn: () => "",
                renderBadges: () => "",
                renderDemoFilterPills: () => {},
                DEMO_TAG_LABELS: {},
            },
            { timeout: 1000 }
        );
        expect(grid.innerHTML).toContain('<img src="/lite/thumbnails/demo-ambient-occlusion.jpg"');
    });
});

describe("/pages development preview thumbnails", () => {
    it("uses the demo's local root-relative thumbnail", () => {
        const config = readFileSync(join(root, "lab/vite.config.ts"), "utf8");
        const escapeHtml = config.slice(config.indexOf("function escapeHtml("), config.indexOf("/**", config.indexOf("function escapeHtml(")));
        const renderCard = config.slice(config.indexOf("function renderPagesDemoCard("), config.indexOf("function renderPagesDemoFilters("));
        const { outputText } = transpileModule(`${escapeHtml}\n${renderCard}\nrenderPagesDemoCard(demo, undefined);`, {
            compilerOptions: { target: ScriptTarget.ESNext },
        });
        const card = runInNewContext(
            outputText,
            {
                demo: { slug: "ambient-occlusion", name: "Ambient Occlusion", description: "" },
                DEMO_SOURCE_BASE_URL: "https://github.com/BabylonJS/Babylon-Lite/blob/master/lab/lite/src/demos/",
            },
            { timeout: 1000 }
        ) as string;
        expect(card).toContain('<img src="/thumbnails/demo-ambient-occlusion.jpg"');
    });
});
