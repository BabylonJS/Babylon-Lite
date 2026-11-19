// Scenes 356-358 — shared glow layout and ShaderMaterial sources. Scene 356 renders Standard/PBR emitters and two
// NodeMaterials (see scene356-nme.ts); scene 357 covers ShaderMaterial and PBR emissive-texture/unlit surfaces; scene 358
// is the right-handed twin of 356.

export const GLOW_SCENE = {
    background: [0.018, 0.023, 0.036] as const,
    alpha: -Math.PI / 2,
    beta: 1.24,
    radius: 11,
    target: [0, 1.5, 0] as const,
    intensity: 0.65,
    kernel: 32,
    lightDirection: [0, 1, -0.5] as const,
    lightIntensity: 0.8,
    matteDiffuse: [0.12, 0.15, 0.21] as const,
    matteSpecular: [0.04, 0.04, 0.04] as const,
    /** Frames rendered after startup before the scene reports ready. */
    settleFrames: 30,
};

/** Scene 357 ShaderMaterial colors: a bright occluder without emission, and a bar selected to glow through metadata. */
export const SCENE357_OCCLUDER_COLOR = [1, 0.5, 0.1] as const;
export const SCENE357_BAR_COLOR = [0.85, 0.3, 1] as const;
export const SCENE357_LED_COLOR = [0.2, 1, 0.3] as const;

/** Lite WGSL for an unlit ShaderMaterial of one constant color. */
export function scene357LiteShader(color: readonly number[]): { vertex: string; fragment: string } {
    return {
        vertex: `struct VertexOutput{@builtin(position) position:vec4f}
@vertex fn mainVertex(input:VertexInput)->VertexOutput{var out:VertexOutput;out.position=shaderSystem.worldViewProjection*vec4f(input.position,1);return out;}`,
        fragment: `@fragment fn mainFragment()->@location(0) vec4f{return vec4f(${color.join(",")},1);}`,
    };
}

/** Babylon.js shader-store WGSL for the same material. */
export function scene357BabylonShader(color: readonly number[]): { vertex: string; fragment: string } {
    return {
        vertex: `#include<sceneUboDeclaration>
#include<meshUboDeclaration>
attribute position:vec3f;
@vertex fn main(input:VertexInputs)->FragmentInputs{vertexOutputs.position=scene.viewProjection*mesh.world*vec4f(vertexInputs.position,1);}`,
        fragment: `@fragment fn main(input:FragmentInputs)->FragmentOutputs{fragmentOutputs.color=vec4f(${color.join(",")},1);}`,
    };
}

/** Resolve after `frames` animation frames, once the engine has rendered its startup frame. */
export function settle(frames: number): Promise<void> {
    return new Promise((resolve) => {
        const step = (): void => {
            if (--frames <= 0) {
                resolve();
            } else {
                requestAnimationFrame(step);
            }
        };
        requestAnimationFrame(step);
    });
}
