import {
    addMeshToTask,
    addToScene,
    createFreeCamera,
    createMeshFromData,
    createRenderTask,
    createShaderMaterial,
    enableOrthographicCamera,
    setShaderFloat,
    setShaderTexture,
    wgsl,
    type ComputeStorageTexture,
    type EngineContext,
    type Mesh,
    type RenderTarget,
    type RenderTask,
    type SceneContext,
} from "babylon-lite";
import type { OceanComputeResources } from "./resources.js";

const VERTEX = wgsl`struct VertexOutput{@builtin(position) position:vec4f,@location(0) uv:vec2f}
@vertex fn mainVertex(input:VertexInput)->VertexOutput{var out:VertexOutput;out.position=shaderSystem.worldViewProjection*vec4f(input.position,1);out.uv=input.uv;return out;}`;
const FRAGMENT = wgsl`struct VertexOutput{@builtin(position) position:vec4f,@location(0) uv:vec2f}
@fragment fn mainFragment(input:VertexOutput)->@location(0) vec4f{
let value=textureSampleLevel(debugTexture,debugTextureSampler,input.uv,0.0);
if(shaderUniforms.kind<0.5){return vec4f(vec3f(0.5+value.y*0.08),1);}
if(shaderUniforms.kind<1.5){return vec4f(value.xyz*0.5+0.5,1);}
return vec4f(vec3f(clamp(value.x,0.0,1.0)),1);
}`;

export interface OceanTextureDebug {
    readonly task: RenderTask;
    readonly meshes: readonly Mesh[];
    setVisible(visible: boolean): void;
}

function sampled(resource: ComputeStorageTexture) {
    if (!resource.sampledTexture) {
        throw new Error("Ocean debug texture is not sampleable.");
    }
    return resource.sampledTexture;
}

function createQuad(engine: EngineContext, name: string, centerX: number, centerY: number): Mesh {
    const half = 0.28;
    const positions = new Float32Array([
        centerX - half,
        centerY - half,
        0,
        centerX + half,
        centerY - half,
        0,
        centerX + half,
        centerY + half,
        0,
        centerX - half,
        centerY + half,
        0,
    ]);
    return createMeshFromData(
        engine,
        name,
        positions,
        new Float32Array([0, 0, -1, 0, 0, -1, 0, 0, -1, 0, 0, -1]),
        new Uint32Array([0, 1, 2, 0, 2, 3]),
        new Float32Array([0, 1, 1, 1, 1, 0, 0, 0])
    );
}

export function createOceanTextureDebug(engine: EngineContext, scene: SceneContext, target: RenderTarget, resources: OceanComputeResources): OceanTextureDebug {
    const camera = createFreeCamera({ x: 0, y: 0, z: -2 }, { x: 0, y: 0, z: 0 });
    camera.nearPlane = 0.1;
    camera.farPlane = 10;
    enableOrthographicCamera(camera, { halfHeight: 1.05, left: -1.85, right: 1.85 });
    const task = createRenderTask({ name: "ocean-texture-debug", rt: target, clr: false, depthClear: false, sharedRt: true, cam: camera, autoMirror: false }, engine, scene);
    const meshes: Mesh[] = [];
    for (let cascadeIndex = 0; cascadeIndex < resources.cascades.length; cascadeIndex++) {
        const cascade = resources.cascades[cascadeIndex]!;
        const entries = [
            { texture: cascade.displacement, kind: 0, name: "displacement" },
            { texture: cascade.derivatives, kind: 1, name: "derivatives" },
            { texture: cascade.turbulenceA, kind: 2, name: "turbulence" },
        ] as const;
        for (let column = 0; column < entries.length; column++) {
            const entry = entries[column]!;
            const mesh = createQuad(engine, `ocean-debug-c${cascadeIndex}-${entry.name}`, -0.68 + column * 0.68, 0.68 - cascadeIndex * 0.68);
            const material = createShaderMaterial({
                name: mesh.name,
                vertexSource: VERTEX,
                fragmentSource: FRAGMENT,
                attributes: ["position", "uv"],
                uniforms: ["worldViewProjection", { name: "kind", type: "f32", defaultValue: entry.kind }],
                samplers: ["debugTexture"],
                backFaceCulling: false,
                depthWrite: false,
                depthCompare: "always",
            });
            setShaderFloat(material, "kind", entry.kind);
            setShaderTexture(material, "debugTexture", sampled(entry.texture));
            mesh.material = material;
            mesh.renderOrder = 10000;
            mesh.pickable = false;
            mesh.visible = true;
            addToScene(scene, mesh);
            addMeshToTask(task, mesh);
            meshes.push(mesh);
        }
    }
    task.executionEnabled = false;
    return {
        task,
        meshes,
        setVisible(visible: boolean): void {
            task.executionEnabled = visible;
        },
    };
}
