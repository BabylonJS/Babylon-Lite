import { expect, test } from "@playwright/test";
import { PNG } from "pngjs";
import { resolve } from "path";

const LITE_ENTRY = `/@fs/${resolve(__dirname, "../../../../packages/babylon-lite/src/index.ts").replace(/\\/g, "/")}`;

test("PBR material can gain gamma albedo after first render", async ({ page }) => {
    await page.goto("/");
    await page.setContent(`
<canvas id="renderCanvas" width="1280" height="720"></canvas>
<script type="module">
import { addToScene, createArcRotateCamera, createBox, createEngine, createHemisphericLight, createPbrMaterial, createSceneContext, createSolidTexture2D, rebuildMaterial, registerScene, startEngine } from "${LITE_ENTRY}";

const canvas = document.getElementById("renderCanvas");
window.addEventListener("error", (event) => { canvas.dataset.error = event.message; });
window.addEventListener("unhandledrejection", (event) => { canvas.dataset.error = event.reason?.message ?? String(event.reason); });

async function main() {
    const engine = await createEngine(canvas);
    const scene = createSceneContext(engine);
    scene.camera = createArcRotateCamera(0, Math.PI / 2, 5, { x: 0, y: 0, z: 0 });
    const light = createHemisphericLight([0, 1, 0]);
    light.intensity = 0.8;
    addToScene(scene, light);

    const mesh = createBox(engine, 2);
    const material = createPbrMaterial({
        baseColorTexture: createSolidTexture2D(engine, 0.8, 0.2, 0.2),
        ormTexture: createSolidTexture2D(engine, 1, 0.5, 0),
    });
    mesh.material = material;
    addToScene(scene, mesh);

    await registerScene(scene);
    await startEngine(engine);
    canvas.dataset.ready = "true";

    material.baseColorTexture = createSolidTexture2D(engine, 0.2, 0.8, 0.2);
    material.gammaAlbedo = true;
    rebuildMaterial(scene, material);

    for (let i = 0; i < 60; i++) {
        await new Promise((resolve) => requestAnimationFrame(resolve));
        if (scene._runtimeBuilds) {
            await scene._runtimeBuilds.all();
            canvas.dataset.rebuilt = "true";
            return;
        }
    }
    throw new Error("PBR gamma swap did not enter the async runtime rebuild path");
}

main().catch((error) => { canvas.dataset.error = error?.message ?? String(error); });
</script>`);

    const canvas = page.locator("#renderCanvas");
    await expect(canvas).toHaveAttribute("data-ready", "true", { timeout: 30_000 });
    await expect(canvas).toHaveAttribute("data-rebuilt", "true", { timeout: 30_000 });
    await expect(canvas).not.toHaveAttribute("data-error", /./);

    const png = PNG.sync.read(await canvas.screenshot());
    const center = ((Math.floor(png.height / 2) * png.width + Math.floor(png.width / 2)) * 4) | 0;
    expect(png.data[center + 1]).toBeGreaterThan(png.data[center]!);
});
