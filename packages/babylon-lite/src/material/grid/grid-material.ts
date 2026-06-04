import type { Texture2D } from "../../texture/texture-2d.js";
import type { ShaderMaterial, ShaderUniformOption, ShaderSamplerOption } from "../shader/shader-material.js";
import { createShaderMaterial, setShaderTexture } from "../shader/shader-material.js";

/** A 3-component color/vector expressed as a readonly tuple. */
export type GridVec3 = readonly [number, number, number];

/**
 * Options for {@link createGridMaterial}. Mirrors Babylon.js `GridMaterial`:
 * an unlit, procedural object-space grid. All fields are optional and fall back
 * to the Babylon defaults.
 */
export interface GridMaterialOptions {
    readonly name?: string;
    /** Background color between the lines. Default black `[0,0,0]`. */
    readonly mainColor?: GridVec3;
    /** Color of the grid lines. Default teal `[0,0.5,0.5]`. */
    readonly lineColor?: GridVec3;
    /** Spacing of the grid in object-space units. Default `1`. */
    readonly gridRatio?: number;
    /** Object-space offset added before computing the grid. Default `[0,0,0]`. */
    readonly gridOffset?: GridVec3;
    /** Every Nth line is a major line. Rounded with `Math.round`. Default `10`. */
    readonly majorUnitFrequency?: number;
    /** Visibility of the minor (non-major) lines, `0..1`. Default `0.33`. */
    readonly minorUnitVisibility?: number;
    /** Opacity of the grid outside of the lines. `<1` enables the transparent path. Default `1`. */
    readonly opacity?: number;
    /** Cosine-based antialiasing of the lines. Default `true`. */
    readonly antialias?: boolean;
    /** Premultiply rgb by alpha (transparent path only). Default `false`. */
    readonly preMultiplyAlpha?: boolean;
    /** Combine axes with `max` instead of additive sum. Default `false`. */
    readonly useMaxLine?: boolean;
    /** Optional opacity texture; its `.a` channel multiplies the final opacity. */
    readonly opacityTexture?: Texture2D;
    /** Per-material visibility multiplier applied to the final alpha. Default `1`. */
    readonly visibility?: number;
    /** Cull back faces. Default `true`. */
    readonly backFaceCulling?: boolean;
}

/** Build the VertexOutput struct shared by the vertex and fragment stages. */
function buildVertexOutputStruct(hasOpacity: boolean): string {
    return `struct VertexOutput{@builtin(position) position:vec4<f32>,@location(0) vPosition:vec3<f32>,@location(1) vNormal:vec3<f32>,${
        hasOpacity ? "@location(2) vUv:vec2<f32>," : ""
    }};`;
}

function buildVertexSource(hasOpacity: boolean): string {
    return `${buildVertexOutputStruct(hasOpacity)}
@vertex fn mainVertex(input:VertexInput)->VertexOutput{var out:VertexOutput;out.position=shaderSystem.projection*(shaderSystem.view*(shaderSystem.world*vec4<f32>(input.position,1.0)));out.vPosition=input.position;out.vNormal=input.normal;${
        hasOpacity ? "out.vUv=input.uv;" : ""
    }return out;}`;
}

function buildFragmentSource(opts: { antialias: boolean; useMaxLine: boolean; transparent: boolean; preMultiplyAlpha: boolean; hasOpacity: boolean }): string {
    const onLine = opts.antialias ? "fr=clamp(fr,-1.0,1.0);return 0.5+0.5*cos(fr*PI);" : "if(abs(fr)<SQRT2/4.0){return 1.0;}return 0.0;";
    const grid = opts.useMaxLine ? "let grid=clamp(max(max(x,y),z),0.0,1.0);" : "let grid=clamp(x+y+z,0.0,1.0);";
    const transparent = opts.transparent ? "opacity=clamp(grid,0.08,shaderUniforms.gridControl.w*grid);" : "";
    const opacityTex = opts.hasOpacity ? "opacity=opacity*textureSample(opacitySampler,opacitySamplerSampler,input.vUv).a;" : "";
    const premultiply = opts.transparent && opts.preMultiplyAlpha ? "rgb=rgb*opacity;" : "";
    return `${buildVertexOutputStruct(opts.hasOpacity)}
const SQRT2:f32=1.41421356;
const PI:f32=3.14159;
fn gridDynamicVisibility(position:f32)->f32{let f=shaderUniforms.gridControl.y;if(floor(position+0.5)==floor(position/f+0.5)*f){return 1.0;}return shaderUniforms.gridControl.z;}
fn gridAniso(d:f32)->f32{return clamp(1.0/(d+1.0)-1.0/10.0,0.0,1.0);}
fn gridIsOnLine(position:f32,d:f32)->f32{var fr=position-floor(position+0.5);fr=fr/d;${onLine}}
fn gridContrib(position:f32)->f32{var d=length(vec2<f32>(dpdx(position),dpdy(position)));d=d*SQRT2;var r=gridIsOnLine(position,d);r=r*gridDynamicVisibility(position);r=r*gridAniso(d);return r;}
fn gridNormalImpact(x:f32)->f32{return clamp(1.0-3.0*abs(x*x*x),0.0,1.0);}
@fragment fn mainFragment(input:VertexOutput)->@location(0) vec4<f32>{let gridRatio=shaderUniforms.gridControl.x;let gridPos=(input.vPosition+shaderUniforms.gridOffset)/gridRatio;var x=gridContrib(gridPos.x);var y=gridContrib(gridPos.y);var z=gridContrib(gridPos.z);let n=normalize(input.vNormal);x=x*gridNormalImpact(n.x);y=y*gridNormalImpact(n.y);z=z*gridNormalImpact(n.z);${grid}var rgb=mix(shaderUniforms.mainColor,shaderUniforms.lineColor,vec3<f32>(grid));var opacity=1.0;${transparent}${opacityTex}${premultiply}return vec4<f32>(rgb,opacity*shaderUniforms.visibility);}`;
}

/**
 * Create a Babylon.js-equivalent `GridMaterial`: an unlit, procedural object-space
 * grid built on top of {@link createShaderMaterial}. The grid math runs entirely in
 * object space — the vertex stage forwards object-space position and normal, and the
 * fragment stage derives per-axis line contributions weighted by the normal.
 *
 * @param options - Grid appearance and blend options.
 * @returns A configured {@link ShaderMaterial}.
 */
export function createGridMaterial(options: GridMaterialOptions = {}): ShaderMaterial {
    const mainColor = options.mainColor ?? [0, 0, 0];
    const lineColor = options.lineColor ?? [0, 0.5, 0.5];
    const gridRatio = options.gridRatio ?? 1;
    const gridOffset = options.gridOffset ?? [0, 0, 0];
    const majorUnitFrequency = options.majorUnitFrequency ?? 10;
    const minorUnitVisibility = options.minorUnitVisibility ?? 0.33;
    const opacity = options.opacity ?? 1;
    const antialias = options.antialias ?? true;
    const preMultiplyAlpha = options.preMultiplyAlpha ?? false;
    const useMaxLine = options.useMaxLine ?? false;
    const visibility = options.visibility ?? 1;
    const backFaceCulling = options.backFaceCulling ?? true;
    const opacityTexture = options.opacityTexture;
    const hasOpacity = !!opacityTexture;
    const transparent = opacity < 1;

    // gridControl = (gridRatio, round(majorUnitFrequency), minorUnitVisibility, opacity).
    const gridControl = [gridRatio, Math.round(majorUnitFrequency), minorUnitVisibility, opacity];

    const uniforms: ShaderUniformOption[] = [
        "world",
        "view",
        "projection",
        { name: "gridControl", type: "vec4<f32>", defaultValue: gridControl },
        { name: "mainColor", type: "vec3<f32>", defaultValue: mainColor },
        { name: "lineColor", type: "vec3<f32>", defaultValue: lineColor },
        { name: "gridOffset", type: "vec3<f32>", defaultValue: gridOffset },
        { name: "visibility", type: "f32", defaultValue: visibility },
    ];
    const samplers: ShaderSamplerOption[] = hasOpacity ? ["opacitySampler"] : [];

    const material = createShaderMaterial({
        name: options.name ?? "GridMaterial",
        vertexSource: buildVertexSource(hasOpacity),
        fragmentSource: buildFragmentSource({ antialias, useMaxLine, transparent, preMultiplyAlpha, hasOpacity }),
        attributes: hasOpacity ? ["position", "normal", "uv"] : ["position", "normal"],
        uniforms,
        samplers,
        needAlphaBlending: transparent || hasOpacity,
        blendMode: "alpha",
        backFaceCulling,
    });

    if (opacityTexture) {
        setShaderTexture(material, "opacitySampler", opacityTexture);
    }

    return material;
}
