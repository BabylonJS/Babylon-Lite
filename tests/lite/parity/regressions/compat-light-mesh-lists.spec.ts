import { expect, test } from "@playwright/test";
import { PNG } from "pngjs";
import { resolve } from "path";

const COMPAT_ENTRY = `/@fs/${resolve(__dirname, "../../../../packages/babylon-lite-compat/src/index.ts").replace(/\\/g, "/")}`;

/**
 * The scene every case below renders: one directional light straight down, a ground plane, and a box
 * on it, seen from directly above. The ground is narrower than the horizontal field of view, so the
 * left edge of the frame shows the clear colour.
 *
 * That background is the control. A canvas that has not rendered yet is pure black, which would
 * otherwise satisfy "the floor is dark" on its own, so every case asserts the background before it
 * reads the lit surfaces. The readiness flags wait for real rendered frames, counted from
 * `onAfterRenderObservable`, and for the rebuild a list change triggers, never for a frame quota.
 */
function scenePage(body: string): string {
    return `
<canvas id="renderCanvas" width="1280" height="720"></canvas>
<script type="module">
import { ArcRotateCamera, Color3, Color4, DirectionalLight, MeshBuilder, Scene, StandardMaterial, Vector3, WebGPUEngine } from "${COMPAT_ENTRY}";

const canvas = document.getElementById("renderCanvas");
window.addEventListener("error", (event) => { canvas.dataset.error = event.message; });
window.addEventListener("unhandledrejection", (event) => { canvas.dataset.error = event.reason?.message ?? String(event.reason); });

async function main() {
    const engine = new WebGPUEngine(canvas);
    await engine.initAsync();

    const scene = new Scene(engine);
    // Not black: an unrendered canvas has to be distinguishable from an unlit one.
    scene.clearColor = new Color4(0, 0, 0.25, 1);

    const camera = new ArcRotateCamera("camera", 0, 0.001, 14, Vector3.Zero(), scene);
    camera.minZ = 0.1;

    const white = new StandardMaterial("white", scene);
    white.diffuseColor = new Color3(1, 1, 1);
    white.specularColor = new Color3(0, 0, 0);

    const floor = MeshBuilder.CreateGround("floor", { width: 14, height: 14 }, scene);
    floor.material = white;

    const box = MeshBuilder.CreateBox("box", { size: 2 }, scene);
    box.position.y = 1;
    box.material = white;

    const rim = new DirectionalLight("rim", new Vector3(0, -1, 0), scene);
    rim.intensity = 1;

    let frames = 0;
    scene.onAfterRenderObservable.add(() => { frames++; });

    const renderedFrames = async (count) => {
        const target = frames + count;
        const deadline = Date.now() + 20000;
        while (frames < target) {
            if (Date.now() > deadline) {
                throw new Error("timed out waiting for " + count + " rendered frames");
            }
            await new Promise((resolve) => requestAnimationFrame(resolve));
        }
    };

    // Whatever a list change schedules: the microtask that publishes the sets, the asynchronous
    // renderable rebuild it requests, then frames drawn from the rebuilt renderables.
    const settled = async () => {
        await Promise.resolve();
        await scene._lite._runtimeBuilds?.all?.();
        await renderedFrames(2);
    };

    ${body}
}

main().catch((error) => { canvas.dataset.error = error?.message ?? String(error); });
</script>`;
}

const BACKGROUND = { x: 0.03, y: 0.5 };
const FLOOR = { x: 0.25, y: 0.5 };
const BOX = { x: 0.5, y: 0.5 };

test("a runtime excludedMeshes edit darkens the floor and leaves other meshes lit", async ({ page }) => {
    await page.goto("/");
    await page.setContent(
        scenePage(`
    engine.runRenderLoop(() => scene.render());
    await renderedFrames(2);
    canvas.dataset.lit = "true";

    window.__exclude = async () => {
        rim.excludedMeshes = [floor];
        await settled();
        canvas.dataset.excluded = "true";
    };
`)
    );

    const canvas = page.locator("#renderCanvas");
    await expect(canvas).toHaveAttribute("data-lit", "true", { timeout: 30_000 });
    await expect(canvas).not.toHaveAttribute("data-error", /./);

    const before = PNG.sync.read(await canvas.screenshot());
    expectRendered(before);
    expect(luminance(before, FLOOR)).toBeGreaterThan(80);
    const boxBefore = luminance(before, BOX);
    expect(boxBefore).toBeGreaterThan(80);

    await page.evaluate(() => (window as unknown as { __exclude: () => Promise<void> }).__exclude());
    await expect(canvas).toHaveAttribute("data-excluded", "true", { timeout: 30_000 });
    await expect(canvas).not.toHaveAttribute("data-error", /./);

    const after = PNG.sync.read(await canvas.screenshot());
    expectRendered(after);
    // The floor is out of the light: whatever ambient remains, it is nothing like a lit surface.
    expect(luminance(after, FLOOR)).toBeLessThan(10);
    // ...and the exclusion scoped the light rather than switching it off.
    expect(luminance(after, BOX)).toBeGreaterThan(boxBefore * 0.9);
});

test("includedOnlyMeshes set before the first frame scopes the light to those meshes", async ({ page }) => {
    await page.goto("/");
    await page.setContent(
        scenePage(`
    rim.includedOnlyMeshes = [box];

    engine.runRenderLoop(() => scene.render());
    await renderedFrames(2);
    canvas.dataset.ready = "true";
`)
    );

    const canvas = page.locator("#renderCanvas");
    await expect(canvas).toHaveAttribute("data-ready", "true", { timeout: 30_000 });
    await expect(canvas).not.toHaveAttribute("data-error", /./);

    const png = PNG.sync.read(await canvas.screenshot());
    expectRendered(png);
    expect(luminance(png, BOX)).toBeGreaterThan(80);
    expect(luminance(png, FLOOR)).toBeLessThan(10);
});

test("identical inclusion and exclusion lists light nothing", async ({ page }) => {
    await page.goto("/");
    await page.setContent(
        scenePage(`
    rim.includedOnlyMeshes = [box];
    rim.excludedMeshes = [box];

    engine.runRenderLoop(() => scene.render());
    await renderedFrames(2);
    canvas.dataset.ready = "true";
`)
    );

    const canvas = page.locator("#renderCanvas");
    await expect(canvas).toHaveAttribute("data-ready", "true", { timeout: 30_000 });
    await expect(canvas).not.toHaveAttribute("data-error", /./);

    const png = PNG.sync.read(await canvas.screenshot());
    // Without this the two assertions below would also pass on a canvas that never rendered.
    expectRendered(png);
    // The box is the only listed mesh, and the floor was never mentioned by either list.
    expect(luminance(png, BOX)).toBeLessThan(10);
    expect(luminance(png, FLOOR)).toBeLessThan(10);
});

/** The frame shows the scene's clear colour where the ground does not reach, so something drew. */
function expectRendered(png: PNG): void {
    const [, , blue] = pixel(png, BACKGROUND);
    expect(blue).toBeGreaterThan(40);
}

function pixel(png: PNG, at: { x: number; y: number }): [number, number, number] {
    const x = Math.floor(png.width * at.x);
    const y = Math.floor(png.height * at.y);
    const i = (y * png.width + x) * 4;
    return [png.data[i]!, png.data[i + 1]!, png.data[i + 2]!];
}

function luminance(png: PNG, at: { x: number; y: number }): number {
    const [r, g, b] = pixel(png, at);
    return (r + g + b) / 3;
}
