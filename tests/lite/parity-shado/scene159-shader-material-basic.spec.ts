import { test, expect } from "@playwright/test";
import { createLitePreviewSession, encodePng } from "@knervous/shado/devtools";
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { compareImages, getSceneConfig } from "../parity/compare-utils";

const sceneConfig = getSceneConfig(159);
const GOLDEN_REF = path.resolve(__dirname, "../../../reference/lite/scene159-shader-material-basic/babylon-ref-golden.png");
const LITE_MODULE = pathToFileURL(path.resolve(__dirname, "../../../packages/babylon-lite/build/lib/index.js")).href;

const vertexSource = `struct VertexOutput{@builtin(position) position:vec4<f32>,};
@vertex fn mainVertex(input:VertexInput)->VertexOutput{var out:VertexOutput;out.position=shaderSystem.worldViewProjection*vec4<f32>(input.position,1.0);return out;}`;
const fragmentSource = `struct VertexOutput{@builtin(position) position:vec4<f32>,};
@fragment fn mainFragment(input:VertexOutput)->@location(0) vec4<f32>{return vec4<f32>(25.0/255.0,0.70,1.00,1.0);}`;

// Playwright requires fixture-object destructuring even though this Node-only test uses none.
// eslint-disable-next-line no-empty-pattern
test("Scene 159 - ShaderMaterial basic color matches Babylon.js reference in Shado", async ({}, testInfo) => {
    const session = await createLitePreviewSession({
        width: 1280,
        height: 720,
        liteModule: LITE_MODULE,
    });

    try {
        const scene = await session.newScene({ defaultLights: false });
        const { engine, lite } = session;
        scene.clearColor = { r: 51 / 255, g: 51 / 255, b: 76 / 255, a: 1 };

        const material = lite.createShaderMaterial({
            name: "scene159Shader",
            vertexSource,
            fragmentSource,
            attributes: ["position"],
            uniforms: ["worldViewProjection"],
        });
        const sphere = lite.createSphere(engine, { segments: 32, diameter: 2 });
        sphere.material = material;
        lite.addToScene(scene, sphere);

        // Shado frames by the mesh AABB diagonal. For a unit sphere, this zoom
        // reproduces scene159's explicit camera radius of 4.2.
        const camera = await session.frameCamera({
            alpha: -Math.PI / 2,
            beta: Math.PI / 2.25,
            zoom: 4.2 / Math.sqrt(3),
            target: [0, 0, 0],
        });
        camera.nearPlane = 0.1;
        camera.farPlane = 100;

        const frame = await session.captureRaw();
        expect(frame.format).toBe("bgra8");
        expect(frame.flipped).toBe(false);

        const rgba = new Uint8Array(frame.data);
        for (let i = 0; i < rgba.length; i += 4) {
            const red = rgba[i]!;
            rgba[i] = rgba[i + 2]!;
            rgba[i + 2] = red;
        }

        const actualPath = testInfo.outputPath("scene159-actual.png");
        fs.mkdirSync(path.dirname(actualPath), { recursive: true });
        fs.writeFileSync(actualPath, encodePng(rgba, frame.width, frame.height));

        const result = compareImages(actualPath, GOLDEN_REF);
        expect(result.maxDiff).toBeLessThanOrEqual(1);
        expect(result.mad).toBeLessThanOrEqual(sceneConfig.maxMad);
    } finally {
        await session.dispose();
    }
});
