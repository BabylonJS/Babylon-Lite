import {
    addToScene,
    createArcRotateCamera,
    createEngine,
    createPlane,
    createSceneContext,
    createShaderMaterial,
    registerScene,
    setAlphaToCoverage,
    setShaderFloat,
    setShaderUniform,
    setShaderVector3,
    startEngine,
} from "babylon-lite";
import type { EngineContext, ShaderMaterial } from "babylon-lite";
import { wgsl } from "babylon-lite/shader/wgsl.js";

/**
 * Scene 274 — Alpha-to-Coverage.
 *
 * Both panels render the same overlapping red/green cards into the default 4x MSAA scene target.
 * The left materials use ordinary replacement color/depth writes, so the nearest half-alpha card
 * still covers every sample. The right materials opt into alpha-to-coverage, so a 0.5-alpha front
 * card covers two samples while the opaque rear card fills the other two, resolving to olive.
 */

const VERTEX_SOURCE = wgsl`struct VertexOutput{@builtin(position) position:vec4<f32>,};
@vertex fn mainVertex(input:VertexInput)->VertexOutput{let c=cos(shaderUniforms.angle);let s=sin(shaderUniforms.angle);let local=input.position.xy*1.65;let rotated=vec2<f32>(local.x*c-local.y*s,local.x*s+local.y*c);let world=shaderUniforms.center+rotated;var out:VertexOutput;out.position=vec4<f32>(world.x/3.3,world.y/2.2,shaderUniforms.depth,1.0);return out;}`;
const FRAGMENT_SOURCE = wgsl`@fragment fn mainFragment()->@location(0) vec4<f32>{return vec4<f32>(shaderUniforms.color,shaderUniforms.opacity);}`;

// Exact 8-bit colours (n/255) whose per-channel sums are even. A 0.5-alpha alpha-to-coverage mix covers
// 2 of 4 samples, so the MSAA resolve averages these two colours; an average landing on .5 has an
// implementation-defined rounding direction, which makes software rasterizers disagree with a GPU-captured
// golden by 1 LSB. Even sums keep every resolved channel an exact integer.
const RED: readonly [number, number, number] = [242 / 255, 31 / 255, 41 / 255];
const GREEN: readonly [number, number, number] = [26 / 255, 217 / 255, 83 / 255];
// Rows sit far enough apart that no card ever overlaps a card from the other row. Cross-row overlap
// would land on identical depth values, and a depth tie resolves differently under reverse-Z
// "greater-equal" (WebGPU) than under strict LESS (WebGL2) — diverging the backends for reasons that
// have nothing to do with alpha-to-coverage.
const ROWS = [
    { y: 1.05, redInFront: true, redRotation: -0.08, greenRotation: 0.1 },
    { y: -1.05, redInFront: false, redRotation: 0.1, greenRotation: -0.07 },
] as const;

function createCardMaterial(center: readonly [number, number], rotation: number, depth: number, color: readonly [number, number, number], opacity: number): ShaderMaterial {
    const material = createShaderMaterial({
        name: "a2c-card",
        vertexSource: VERTEX_SOURCE,
        fragmentSource: FRAGMENT_SOURCE,
        attributes: ["position"],
        uniforms: [
            { name: "center", type: "vec2<f32>" },
            { name: "angle", type: "f32" },
            { name: "depth", type: "f32" },
            { name: "color", type: "vec3<f32>" },
            { name: "opacity", type: "f32" },
        ],
        backFaceCulling: false,
        depthWrite: true,
    });
    setShaderUniform(material, "center", center);
    setShaderFloat(material, "angle", rotation);
    setShaderFloat(material, "depth", depth);
    setShaderVector3(material, "color", color);
    setShaderFloat(material, "opacity", opacity);
    return material;
}

function addPanel(engine: EngineContext, scene: ReturnType<typeof createSceneContext>, x: number, alphaToCoverage: boolean): void {
    for (const row of ROWS) {
        // Lite uses reverse-Z: the larger clip-space depth is nearer.
        const redFront = row.redInFront;
        const redMaterial = createCardMaterial([x - 0.08, row.y - 0.04], row.redRotation, redFront ? 0.6 : 0.4, RED, redFront ? 0.5 : 1);
        const greenMaterial = createCardMaterial([x + 0.08, row.y + 0.04], row.greenRotation, redFront ? 0.4 : 0.6, GREEN, redFront ? 1 : 0.5);
        if (alphaToCoverage) {
            setAlphaToCoverage(redMaterial, true);
            setAlphaToCoverage(greenMaterial, true);
        }

        const redCard = createPlane(engine);
        redCard.material = redMaterial;
        addToScene(scene, redCard);

        const greenCard = createPlane(engine);
        greenCard.material = greenMaterial;
        addToScene(scene, greenCard);
    }
}

async function main(): Promise<void> {
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = await createEngine(canvas, { msaaSamples: 4 });
    const scene = createSceneContext(engine);
    scene.clearColor = { r: 0.035, g: 0.045, b: 0.07, a: 1 };

    addPanel(engine, scene, -1.65, false);
    addPanel(engine, scene, 1.65, true);
    scene.camera = createArcRotateCamera(0, Math.PI / 2, 1, { x: 0, y: 0, z: 0 });

    await registerScene(scene);
    await startEngine(engine);

    canvas.dataset.sampleCount = String(engine.msaaSamples);
    canvas.dataset.ready = "true";
}

main().catch(console.error);
