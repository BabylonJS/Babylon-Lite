import type { GLEngineContext } from "../context.js";
import type { GLCurveSetId } from "./glyph-storage.js";
import type { GLGlyphRun, GLTextData, TextGroupKey } from "./text-data.js";
import { _installTextStyleSeam, _resolveRunRef, updateTextData } from "./text-data.js";
import { _installTextVariantResolver, createTextProgram } from "./_gpu/text-effect.js";
import type { TextProgram } from "./_gpu/text-effect.js";
import { composeSlugShader } from "./shaders/slug-shader.js";
import type { ComposedSlugShader } from "./shaders/slug-shader.js";
import { WEIGHT_SHADER_FRAGMENT } from "./shaders/weight-shader-fragment.js";

let offsets: WeakMap<GLGlyphRun, number> | null = null;
let keys: Map<GLCurveSetId, object> | null = null;
let shader: ComposedSlugShader | null = null;

function runOffset(run: GLGlyphRun): number {
    return offsets?.get(run) ?? 0;
}

function runGroupKey(run: GLGlyphRun): TextGroupKey {
    if (runOffset(run) === 0) {
        return run.curveSet;
    }
    const cache = (keys ??= new Map());
    let key = cache.get(run.curveSet);
    if (!key) {
        key = {};
        cache.set(run.curveSet, key);
    }
    return key;
}

function createVariant(engine: GLEngineContext): TextProgram {
    return createTextProgram(engine, (shader ??= composeSlugShader(WEIGHT_SHADER_FRAGMENT)));
}

/** Set a run's synthetic outward contour offset in font units, clamped to 0..100.
 * Zero selects the base shader. Replacing the run descriptor drops its offset.
 * This optional module owns all weight state and shader code; ordinary text does not retain it. */
export function setFontWeightOffset(data: GLTextData, run: GLGlyphRun | number, offset: number): void {
    if (!Number.isFinite(offset)) {
        console.error("setFontWeightOffset: offset must be finite, got", offset);
        return;
    }
    const target = _resolveRunRef(data, run, "setFontWeightOffset");
    const value = Math.min(Math.max(offset, 0), 100);
    if (value !== offset) {
        console.warn(`setFontWeightOffset: offset ${offset} clamped to ${value} (range 0-100 font units).`);
    }
    if (runOffset(target) === value) {
        return;
    }
    if (!offsets) {
        offsets = new WeakMap();
        _installTextStyleSeam({ _key: runGroupKey, _param: runOffset });
        _installTextVariantResolver(createVariant);
    }
    const previous = offsets.get(target);
    if (value === 0) {
        offsets.delete(target);
    } else {
        offsets.set(target, value);
    }
    try {
        updateTextData(data, { update: "reset" });
    } catch (error) {
        if (previous === undefined) {
            offsets.delete(target);
        } else {
            offsets.set(target, previous);
        }
        throw error;
    }
}
