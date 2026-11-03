import type { ComposedShader } from "../../shader/fragment-types.js";
import { wgsl } from "../../shader/wgsl.js";

/** @internal Family-owned shader expressions, not parsed layout metadata. */
interface _ParallaxShaderConfig {
    readonly _position: string;
    readonly _normal: string;
    readonly _uv: string;
    readonly _uniform: string;
    readonly _surfaceTextures: readonly string[];
    readonly _standardBump?: boolean;
}

function replaceSurfaceSamples(source: string, textures: readonly string[]): string {
    const samples = /\btextureSample\s*\(/g;
    let result = "";
    let copiedThrough = 0;
    let match: RegExpExecArray | null;
    while ((match = samples.exec(source))) {
        let depth = 1;
        let argumentStart = samples.lastIndex;
        const args: string[] = [];
        let end = argumentStart;
        for (; end < source.length; end++) {
            const char = source[end];
            if (char === "(") {
                depth++;
            } else if (char === ")") {
                if (--depth === 0) {
                    args.push(source.slice(argumentStart, end).trim());
                    break;
                }
            } else if (char === "," && depth === 1) {
                args.push(source.slice(argumentStart, end).trim());
                argumentStart = end + 1;
            }
        }
        if (depth !== 0) {
            throw new Error("Parallax shader composition encountered an unterminated textureSample expression.");
        }
        samples.lastIndex = end + 1;
        if (!textures.includes(args[0]!)) {
            continue;
        }
        if (args.length !== 3) {
            throw new Error(`Parallax surface texture ${args[0]} requires a 2D textureSample expression.`);
        }
        result += source.slice(copiedThrough, match.index) + `parallaxSample(${args.join(",")},parallaxScreenOffset)`;
        copiedThrough = end + 1;
    }
    return result + source.slice(copiedThrough);
}

/** @internal Transform only surface sampling expressions; preserve all structured composer data. */
export function _patchParallaxShader(composed: ComposedShader, config: _ParallaxShaderConfig): ComposedShader {
    let source: string = composed._fragmentWGSL;
    if (config._standardBump) {
        const declaration = /\bfn\s+perturbNormal\s*\(([^)]*)\)/;
        if (!declaration.test(source)) {
            throw new Error("Parallax shader composition could not find the Standard normal-map helper.");
        }
        source = source.replace(declaration, "fn perturbNormal($1,parallaxScreenOffset:vec2f)");
        let patchedCall = false;
        source = source.replace(
            /\bperturbNormal\s*\(\s*(input\.\w+)\s*,\s*(input\.\w+)\s*,\s*(input\.\w+)\s*,\s*mat\.bs\s*\)/g,
            (_match, normal: string, position: string, uv: string) => {
                patchedCall = true;
                return `perturbNormal(${normal},${position},${uv},mat.bs,parallaxScreenOffset)`;
            }
        );
        if (!patchedCall) {
            throw new Error("Parallax shader composition could not find the Standard normal-map invocation.");
        }
    }
    source = replaceSurfaceSamples(source, config._surfaceTextures);
    const entry = source.indexOf("@fragment");
    const body = entry < 0 ? -1 : source.indexOf("{", entry);
    if (body < 0) {
        throw new Error("Parallax shader composition requires a fragment entry point.");
    }
    const uniform = config._uniform;
    const initialization = wgsl`let parallaxHeightUV=parallaxTransformUV(${config._uv},${uniform}.parallaxUVm,${uniform}.parallaxUVt.xy);
let parallaxScreenOffset=parallaxOffset(${config._position},${config._normal},dpdx(${config._position}),dpdy(${config._position}),scene.vEyePosition.xyz,parallaxHeightUV,dpdx(parallaxHeightUV),dpdy(parallaxHeightUV),${uniform}.parallaxHeight,${uniform}.parallaxSampling);`;
    return {
        ...composed,
        _fragmentWGSL: wgsl`${source.slice(0, body + 1)}${initialization}${source.slice(body + 1)}`,
    };
}
