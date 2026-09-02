import type { Color4 } from "../../math/types.js";
import type { Material } from "../material.js";
import type { Mesh } from "../../mesh/mesh.js";
import type { MeshGroupBuilder } from "../../render/renderable.js";
import type { ShaderMaterial } from "../shader/shader-material.js";
import { createShaderMaterial, setShaderUniform } from "../shader/shader-material.js";
import { getShaderGroupBuilder } from "../shader/shader-group-builder.js";
import { wgsl } from "../../shader/wgsl.js";

/** Options for the unlit material used by line-list meshes. */
export interface LineMaterialOptions {
    readonly name?: string;
    readonly color?: Color4;
    readonly useVertexColor?: boolean;
    readonly useVertexAlpha?: boolean;
    readonly useThinInstances?: boolean;
    readonly useThinInstanceColors?: boolean;
    readonly depthWrite?: boolean;
    readonly depthCompare?: GPUCompareFunction;
}

/** Unlit ShaderMaterial configured for WebGPU line-list rendering. */
export interface LineMaterial extends ShaderMaterial {
    readonly useVertexColor: boolean;
    readonly useVertexAlpha: boolean;
    readonly useThinInstances: boolean;
    readonly useThinInstanceColors: boolean;
    readonly color: Color4;
}

let _lineGroupBuilder: MeshGroupBuilder | null = null;

function requireThinInstances(mesh: Mesh, material: LineMaterial): void {
    if (material.useThinInstances && !mesh.thinInstances) {
        throw new Error(`LineMaterial "${material.name ?? "<unnamed>"}" requires thin-instance data`);
    }
}

function getLineGroupBuilder(): MeshGroupBuilder {
    if (_lineGroupBuilder) {
        return _lineGroupBuilder;
    }
    const shaderBuilder = getShaderGroupBuilder();
    const builder: MeshGroupBuilder = async (scene, meshes) => {
        for (const mesh of meshes) {
            requireThinInstances(mesh, mesh.material as LineMaterial);
        }
        const result = await shaderBuilder(scene, meshes);
        const innerRebuildSingle = result.rebuildSingle;
        const rebuildSingle = (rebuildScene: typeof scene, mesh: Mesh, materialOverride?: Material) => {
            requireThinInstances(mesh, (materialOverride ?? mesh.material) as LineMaterial);
            return innerRebuildSingle(rebuildScene, mesh, materialOverride);
        };
        builder._rebuildSingle = rebuildSingle;
        return { ...result, rebuildSingle };
    };
    builder._materialFamily = "shader";
    return (_lineGroupBuilder = builder);
}

function vertexOutput(hasColor: boolean): string {
    return wgsl`struct VertexOutput{@builtin(position) position:vec4<f32>,${hasColor ? "@location(0) color:vec4<f32>," : ""}};`;
}

function vertexSource(useVertexColor: boolean, useThinInstances: boolean, useThinInstanceColors: boolean): string {
    const hasColor = useVertexColor || useThinInstanceColors;
    const world = useThinInstances
        ? "let instanceWorld=mat4x4<f32>(input.world0,input.world1,input.world2,input.world3);let finalWorld=shaderSystem.world*instanceWorld;"
        : "let finalWorld=shaderSystem.world;";
    const outputColor =
        useVertexColor && useThinInstanceColors
            ? "out.color=input.color*input.instanceColor;"
            : useVertexColor
              ? "out.color=input.color;"
              : useThinInstanceColors
                ? "out.color=input.instanceColor;"
                : "";
    return wgsl`${vertexOutput(hasColor)}
@vertex fn mainVertex(input:VertexInput)->VertexOutput{var out:VertexOutput;${world}out.position=shaderSystem.viewProjection*finalWorld*vec4<f32>(input.position,1.0);${outputColor}return out;}`;
}

function fragmentSource(hasColor: boolean): string {
    return wgsl`${vertexOutput(hasColor)}
@fragment fn mainFragment(input:VertexOutput)->@location(0) vec4<f32>{return ${hasColor ? "input.color" : "shaderUniforms.lineColor"};}`;
}

/** Create an unlit line-list material. */
export function createLineMaterial(options: LineMaterialOptions = {}): LineMaterial {
    const useVertexColor = options.useVertexColor ?? false;
    const useVertexAlpha = options.useVertexAlpha ?? true;
    const useThinInstances = options.useThinInstances ?? false;
    const useThinInstanceColors = options.useThinInstanceColors ?? false;
    if (useThinInstanceColors && !useThinInstances) {
        throw new Error("createLineMaterial requires useThinInstances when useThinInstanceColors is enabled");
    }

    const sourceColor = options.color ?? { r: 1, g: 1, b: 1, a: 1 };
    const color: Color4 = { r: sourceColor.r, g: sourceColor.g, b: sourceColor.b, a: sourceColor.a };
    const hasColorVarying = useVertexColor || useThinInstanceColors;
    const material = createShaderMaterial({
        name: options.name ?? "LineMaterial",
        vertexSource: vertexSource(useVertexColor, useThinInstances, useThinInstanceColors),
        fragmentSource: fragmentSource(hasColorVarying),
        attributes: useVertexColor ? ["position", "color"] : ["position"],
        uniforms: [
            "world",
            "viewProjection",
            ...(!hasColorVarying ? ([{ name: "lineColor", type: "vec4<f32>", defaultValue: [color.r, color.g, color.b, color.a] }] as const) : []),
        ],
        useThinInstanceColors,
        needAlphaBlending: useVertexAlpha,
        blendMode: "alpha",
        backFaceCulling: false,
        depthWrite: options.depthWrite,
        depthCompare: options.depthCompare,
    }) as LineMaterial;
    Object.assign(material, { useVertexColor, useVertexAlpha, useThinInstances, useThinInstanceColors, color, _topology: "line-list", _buildGroup: getLineGroupBuilder() });
    return material;
}

/** Update the uniform color used by a non-vertex-colored line material. */
export function setLineMaterialColor(material: LineMaterial, color: Color4): void {
    material.color.r = color.r;
    material.color.g = color.g;
    material.color.b = color.b;
    material.color.a = color.a;
    if (!material.useVertexColor && !material.useThinInstanceColors) {
        setShaderUniform(material, "lineColor", [color.r, color.g, color.b, color.a]);
    }
}
