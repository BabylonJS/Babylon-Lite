import type { GLEngineContext } from "../../context.js";
import { createEffect, setEffectFloat4, setEffectMatrix, useEffect } from "../../effect.js";
import type { GLEffect } from "../../effect.js";
import type { GLTextLayer } from "../text-renderer.js";
import { composeSlugShader } from "../shaders/slug-shader.js";
import type { ComposedSlugShader } from "../shaders/slug-shader.js";

/** @internal Uniform caches belong to the shared program, not an individual layer/renderer. */
export interface TextProgram {
    /** @internal */
    _effect: GLEffect;
    /** @internal */
    _uploadedProgram: WebGLProgram | null;
    /** @internal */
    _mvpInputs: Float64Array;
    /** @internal */
    _mvp: Float32Array;
}

let programs: WeakMap<GLEffect, TextProgram> | null = null;
let baseShader: ComposedSlugShader | null = null;

/** @internal Optional feature-owned variant factory. */
export let _createTextVariant: ((engine: GLEngineContext) => TextProgram) | null = null;

/** @internal */
export function _installTextVariantResolver(factory: (engine: GLEngineContext) => TextProgram): void {
    _createTextVariant = factory;
}

/** @internal Acquires one effect reference for this renderer. */
export function createTextProgram(engine: GLEngineContext, shader?: ComposedSlugShader): TextProgram {
    const source = shader ?? (baseShader ??= composeSlugShader(null));
    const effect = createEffect(engine, {
        name: "text-slug" + source._key,
        vertexSource: source._vert,
        fragmentSource: source._frag,
        uniformNames: ["mvp", "viewport", "color"],
        samplerNames: ["curveTex", "bandTex", "glyphMetadata", "styles"],
        attributeNames: ["corner", "anchor", "glyphStyle"],
    });
    const cache = (programs ??= new WeakMap());
    let program = cache.get(effect);
    if (!program) {
        program = { _effect: effect, _uploadedProgram: null, _mvpInputs: new Float64Array(6), _mvp: new Float32Array(16) };
        cache.set(effect, program);
    }
    return program;
}

/** @internal Skip unchanged projection work and uploads; relink always invalidates the cache. */
export function uploadTextUniforms(engine: GLEngineContext, program: TextProgram, layer: GLTextLayer, width: number, height: number): void {
    const effect = program._effect;
    useEffect(engine, effect);
    const inputs = program._mvpInputs;
    const px = layer.positionPx.x;
    const py = layer.positionPx.y;
    const rotation = layer.rotationRad;
    const scale = layer.scale;
    if (
        program._uploadedProgram !== effect.program ||
        inputs[0] !== px ||
        inputs[1] !== py ||
        inputs[2] !== rotation ||
        inputs[3] !== scale ||
        inputs[4] !== width ||
        inputs[5] !== height
    ) {
        const mvp = program._mvp;
        const cx = (2 * scale) / width;
        const cy = (2 * scale) / height;
        const cr = Math.cos(rotation);
        const sr = Math.sin(rotation);
        mvp[0] = cx * cr;
        mvp[1] = -cy * sr;
        mvp[4] = cx * sr;
        mvp[5] = cy * cr;
        mvp[10] = mvp[15] = 1;
        mvp[12] = (2 * px) / width - 1;
        mvp[13] = 1 - (2 * py) / height;
        setEffectMatrix(engine, effect, "mvp", mvp);
        inputs[0] = px;
        inputs[1] = py;
        inputs[2] = rotation;
        inputs[3] = scale;
        inputs[4] = width;
        inputs[5] = height;
        program._uploadedProgram = effect.program;
    }
    setEffectFloat4(engine, effect, "viewport", width, height, 0, 0);
    setEffectFloat4(engine, effect, "color", layer.coverageGamma > 0 ? 1 / layer.coverageGamma : 1, 1, 1, layer.opacity);
}
