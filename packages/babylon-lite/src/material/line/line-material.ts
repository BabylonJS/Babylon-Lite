import type { Color4 } from "../../math/types.js";
import type { ShaderMaterial } from "../shader/shader-material.js";
import { createShaderMaterial, setShaderUniform } from "../shader/shader-material.js";

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

function vertexOutput(hasColor: boolean): string {
    return `struct VertexOutput{@builtin(position) position:vec4<f32>,${hasColor ? "@location(0) color:vec4<f32>," : ""}};`;
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
    return `${vertexOutput(hasColor)}
@vertex fn mainVertex(input:VertexInput)->VertexOutput{var out:VertexOutput;${world}out.position=shaderSystem.viewProjection*finalWorld*vec4<f32>(input.position,1.0);${outputColor}return out;}`;
}

function fragmentSource(hasColor: boolean): string {
    return `${vertexOutput(hasColor)}
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
        _topology: "line-list",
        _requiresThinInstances: useThinInstances,
    }) as LineMaterial;
    Object.assign(material, { useVertexColor, useVertexAlpha, useThinInstances, useThinInstanceColors, color });
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
