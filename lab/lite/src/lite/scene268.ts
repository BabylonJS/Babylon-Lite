import {
    addToScene,
    createDefaultCamera,
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

/**
 * Scene 268 — Alpha-to-Coverage.
 *
 * Both panels render the same overlapping red/green cards into the default 4x MSAA scene target.
 * The left materials use ordinary replacement color/depth writes, so the nearest half-alpha card
 * still covers every sample. The right materials opt into alpha-to-coverage, so a 0.5-alpha front
 * card covers two samples while the opaque rear card fills the other two, resolving to olive.
 */

const VERTEX_SOURCE = `struct VertexOutput{@builtin(position) position:vec4<f32>,};
@vertex fn mainVertex(input:VertexInput)->VertexOutput{let c=cos(shaderUniforms.angle);let s=sin(shaderUniforms.angle);let local=input.position.xy*1.65;let rotated=vec2<f32>(local.x*c-local.y*s,local.x*s+local.y*c);let world=shaderUniforms.center+rotated;var out:VertexOutput;out.position=vec4<f32>(world.x/3.3,world.y/2.2,shaderUniforms.depth,1.0);return out;}`;
const FRAGMENT_SOURCE = `@fragment fn mainFragment()->@location(0) vec4<f32>{return vec4<f32>(shaderUniforms.color,shaderUniforms.opacity);}`;

const RED: readonly [number, number, number] = [0.95, 0.12, 0.16];
const GREEN: readonly [number, number, number] = [0.1, 0.85, 0.32];
const ROWS = [
    { y: 0.85, redInFront: true, redRotation: -0.08, greenRotation: 0.1 },
    { y: -0.85, redInFront: false, redRotation: 0.1, greenRotation: -0.07 },
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

function addPanel(engine: EngineContext, scene: ReturnType<typeof createSceneContext>, x: number, alphaToCoverage: boolean, firstOrder: number): void {
    let order = firstOrder;
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
        redCard.renderOrder = order++;
        addToScene(scene, redCard);

        const greenCard = createPlane(engine);
        greenCard.material = greenMaterial;
        greenCard.renderOrder = order++;
        addToScene(scene, greenCard);
    }
}

async function main(): Promise<void> {
    const initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = await createEngine(canvas, { msaaSamples: 4 });
    const scene = createSceneContext(engine);
    scene.clearColor = { r: 0.035, g: 0.045, b: 0.07, a: 1 };

    addPanel(engine, scene, -1.65, false, 0);
    addPanel(engine, scene, 1.65, true, 10);
    createDefaultCamera(scene);

    await registerScene(scene);
    await startEngine(engine);

    canvas.dataset.drawCalls = String(engine.drawCallCount);
    canvas.dataset.sampleCount = String(engine.msaaSamples);
    canvas.dataset.initMs = String(performance.now() - initStart);
    canvas.dataset.ready = "true";
}

main().catch((err) => {
    console.error(err);
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement | null;
    if (canvas) {
        canvas.dataset.error = String(err);
    }
});
