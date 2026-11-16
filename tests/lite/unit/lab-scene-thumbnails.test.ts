import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

const html = readFileSync(resolve(__dirname, "../../../lab/index.html"), "utf8");
const escapeAttr = html.slice(html.indexOf("function escapeAttr(s)"), html.indexOf("function normalizeSearchText(s)"));
const renderSceneCardImage = html.slice(html.indexOf("function renderSceneCardImage(s, priorityAttrs)"), html.indexOf("function renderFilterPills("));

function render(thumbnailUrl?: string, basePath = "/lite"): string {
    return runInNewContext(
        `${escapeAttr}\n${renderSceneCardImage}\nrenderSceneCardImage(scene, ' loading="lazy"');`,
        { scene: { id: 355, name: "Orthographic Kitchen", thumbnailUrl }, expBasePath: () => basePath },
        { timeout: 1000 }
    ) as string;
}

describe("Lab scene thumbnails", () => {
    it("uses a remote thumbnail override without losing image priority attributes", () => {
        expect(render("https://example.test/scene355.jpg")).toContain('<img src="https://example.test/scene355.jpg"');
        expect(render("https://example.test/scene355.jpg")).toContain(' loading="lazy"');
    });

    it.each(["/lite", "/gl"])("preserves the local thumbnail fallback for %s", (basePath) => {
        expect(render(undefined, basePath)).toContain(`<img src="${basePath}/thumbnails/scene355.jpg"`);
    });

    it("HTML-escapes thumbnail overrides", () => {
        expect(render('https://example.test/scene355.jpg?a=1&b="<image>"')).toContain('<img src="https://example.test/scene355.jpg?a=1&amp;b=&quot;&lt;image&gt;&quot;"');
    });
});
