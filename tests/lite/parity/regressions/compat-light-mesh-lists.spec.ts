import { expect, test } from "@playwright/test";
import { PNG } from "pngjs";
import { resolve } from "path";

const COMPAT_ENTRY = `/@fs/${resolve(__dirname, "../../../../packages/babylon-lite-compat/src/index.ts").replace(/\\/g, "/")}`;

/**
 * `light.excludedMeshes` set AFTER the scene is running is the case the unit tests cannot cover:
 * the per-mesh light selection is baked into each renderable when it is built (the shader's
 * light-count permutation and the mesh UBO's light indices), and the per-frame updater only
 * revisits it when the light COUNT changes. So this renders the real thing on the GPU and measures
 * the floor, the way the issue reported it — one directional light straight down, a ground plane
 * that is supposed to be skipped, and a box that must stay lit.
 */
test("a runtime excludedMeshes edit darkens the floor and leaves other meshes lit", async ({ page }) => {
    await page.goto("/");
    await page.setContent(`
<canvas id="renderCanvas" width="1280" height="720"></canvas>
<script type="module">
import { ArcRotateCamera, Color3, Color4, DirectionalLight, MeshBuilder, Scene, StandardMaterial, Vector3, WebGPUEngine } from "${COMPAT_ENTRY}";

const canvas = document.getElementById("renderCanvas");
window.addEventListener("error", (event) => { canvas.dataset.error = event.message; });
window.addEventListener("unhandledrejection", (event) => { canvas.dataset.error = event.reason?.message ?? String(event.reason); });

const frames = (n) => new Promise((resolve) => {
    let left = n;
    const tick = () => (left-- > 0 ? requestAnimationFrame(tick) : resolve());
    tick();
});

async function main() {
    const engine = new WebGPUEngine(canvas);
    await engine.initAsync();

    const scene = new Scene(engine);
    scene.clearColor = new Color4(0, 0, 0, 1);

    // Looking straight down: the floor fills the frame and the box sits in the middle of it.
    const camera = new ArcRotateCamera("camera", 0, 0.001, 14, Vector3.Zero(), scene);
    camera.minZ = 0.1;

    const white = new StandardMaterial("white", scene);
    white.diffuseColor = new Color3(1, 1, 1);
    white.specularColor = new Color3(0, 0, 0);

    const floor = MeshBuilder.CreateGround("floor", { width: 40, height: 40 }, scene);
    floor.material = white;

    const box = MeshBuilder.CreateBox("box", { size: 2 }, scene);
    box.position.y = 1;
    box.material = white;

    // One light, straight down, so the floor takes the full N·L and nothing else lights anything.
    const rim = new DirectionalLight("rim", new Vector3(0, -1, 0), scene);
    rim.intensity = 1;

    engine.runRenderLoop(() => scene.render());
    await frames(30);
    canvas.dataset.lit = "true";

    window.__exclude = async () => {
        rim.excludedMeshes = [floor];
        // The sync is coalesced onto the microtask queue and the rebuild it triggers is async.
        await frames(60);
        canvas.dataset.excluded = "true";
    };
}

main().catch((error) => { canvas.dataset.error = error?.message ?? String(error); });
</script>`);

    const canvas = page.locator("#renderCanvas");
    await expect(canvas).toHaveAttribute("data-lit", "true", { timeout: 30_000 });
    await expect(canvas).not.toHaveAttribute("data-error", /./);

    // The box covers the middle of the frame, so sample the floor well outside it.
    const floorSample = (png: PNG): number => luminance(png, 0.2, 0.8);
    const boxSample = (png: PNG): number => luminance(png, 0.5, 0.5);

    const before = PNG.sync.read(await canvas.screenshot());
    expect(floorSample(before)).toBeGreaterThan(80);
    const boxBefore = boxSample(before);
    expect(boxBefore).toBeGreaterThan(80);

    await page.evaluate(() => (window as unknown as { __exclude: () => Promise<void> }).__exclude());
    await expect(canvas).toHaveAttribute("data-excluded", "true", { timeout: 30_000 });
    await expect(canvas).not.toHaveAttribute("data-error", /./);

    const after = PNG.sync.read(await canvas.screenshot());
    // The floor is out of the light: whatever ambient remains, it is nothing like a lit surface.
    expect(floorSample(after)).toBeLessThan(10);
    // ...and the exclusion scoped the light rather than switching it off.
    expect(boxSample(after)).toBeGreaterThan(boxBefore * 0.9);
});

/**
 * The other half of the issue: a spot light scoped to one module with `includedOnlyMeshes`, set
 * before the first frame — the way an application builds its lights. Nothing is rebuilt on this
 * path; the boot-time build has to read the published set.
 */
test("includedOnlyMeshes set before the first frame scopes the light to those meshes", async ({ page }) => {
    await page.goto("/");
    await page.setContent(`
<canvas id="renderCanvas" width="1280" height="720"></canvas>
<script type="module">
import { ArcRotateCamera, Color3, Color4, MeshBuilder, Scene, SpotLight, StandardMaterial, Vector3, WebGPUEngine } from "${COMPAT_ENTRY}";

const canvas = document.getElementById("renderCanvas");
window.addEventListener("error", (event) => { canvas.dataset.error = event.message; });
window.addEventListener("unhandledrejection", (event) => { canvas.dataset.error = event.reason?.message ?? String(event.reason); });

async function main() {
    const engine = new WebGPUEngine(canvas);
    await engine.initAsync();

    const scene = new Scene(engine);
    scene.clearColor = new Color4(0, 0, 0, 1);

    const camera = new ArcRotateCamera("camera", 0, 0.001, 14, Vector3.Zero(), scene);
    camera.minZ = 0.1;

    const white = new StandardMaterial("white", scene);
    white.diffuseColor = new Color3(1, 1, 1);
    white.specularColor = new Color3(0, 0, 0);

    const floor = MeshBuilder.CreateGround("floor", { width: 40, height: 40 }, scene);
    floor.material = white;

    const box = MeshBuilder.CreateBox("box", { size: 2 }, scene);
    box.position.y = 1;
    box.material = white;

    // A wide cone from straight above covers both meshes, so only the list can scope it.
    const led = new SpotLight("led", new Vector3(0, 12, 0), new Vector3(0, -1, 0), Math.PI / 2, 1, scene);
    led.intensity = 200;
    led.includedOnlyMeshes = [box];

    engine.runRenderLoop(() => scene.render());
    await new Promise((resolve) => {
        let left = 30;
        const tick = () => (left-- > 0 ? requestAnimationFrame(tick) : resolve());
        tick();
    });
    canvas.dataset.ready = "true";
}

main().catch((error) => { canvas.dataset.error = error?.message ?? String(error); });
</script>`);

    const canvas = page.locator("#renderCanvas");
    await expect(canvas).toHaveAttribute("data-ready", "true", { timeout: 30_000 });
    await expect(canvas).not.toHaveAttribute("data-error", /./);

    const png = PNG.sync.read(await canvas.screenshot());
    expect(luminance(png, 0.5, 0.5)).toBeGreaterThan(80);
    expect(luminance(png, 0.2, 0.8)).toBeLessThan(10);
});

/**
 * An inclusion list whose every member is also excluded lights nothing in Babylon.js. The published
 * inclusion set has to stay non-empty to say that, because `affectsMesh` honours it only while its
 * size is nonzero; an empty one reads as "no restriction" and lights the whole scene.
 */
test("identical inclusion and exclusion lists light nothing", async ({ page }) => {
    await page.goto("/");
    await page.setContent(`
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
    scene.clearColor = new Color4(0, 0, 0, 1);

    const camera = new ArcRotateCamera("camera", 0, 0.001, 14, Vector3.Zero(), scene);
    camera.minZ = 0.1;

    const white = new StandardMaterial("white", scene);
    white.diffuseColor = new Color3(1, 1, 1);
    white.specularColor = new Color3(0, 0, 0);

    const floor = MeshBuilder.CreateGround("floor", { width: 40, height: 40 }, scene);
    floor.material = white;

    const box = MeshBuilder.CreateBox("box", { size: 2 }, scene);
    box.position.y = 1;
    box.material = white;

    const rim = new DirectionalLight("rim", new Vector3(0, -1, 0), scene);
    rim.intensity = 1;
    rim.includedOnlyMeshes = [box];
    rim.excludedMeshes = [box];

    engine.runRenderLoop(() => scene.render());
    await new Promise((resolve) => {
        let left = 30;
        const tick = () => (left-- > 0 ? requestAnimationFrame(tick) : resolve());
        tick();
    });
    canvas.dataset.ready = "true";
}

main().catch((error) => { canvas.dataset.error = error?.message ?? String(error); });
</script>`);

    const canvas = page.locator("#renderCanvas");
    await expect(canvas).toHaveAttribute("data-ready", "true", { timeout: 30_000 });
    await expect(canvas).not.toHaveAttribute("data-error", /./);

    const png = PNG.sync.read(await canvas.screenshot());
    // The box is the only listed mesh, and the floor was never mentioned by either list.
    expect(luminance(png, 0.5, 0.5)).toBeLessThan(10);
    expect(luminance(png, 0.2, 0.8)).toBeLessThan(10);
});

function luminance(png: PNG, xFraction: number, yFraction: number): number {
    const x = Math.floor(png.width * xFraction);
    const y = Math.floor(png.height * yFraction);
    const i = (y * png.width + x) * 4;
    return (png.data[i]! + png.data[i + 1]! + png.data[i + 2]!) / 3;
}
