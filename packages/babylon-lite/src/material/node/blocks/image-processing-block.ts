/** ImageProcessingBlock — scene image-processing output path.
 *
 *  Matches Babylon.js' NME ImageProcessingBlock for the image-processing state
 *  currently exposed by Lite's canonical scene UBO (sceneU.vImageInfos):
 *  optional input gamma->linear conversion, exposure, standard exponential
 *  tone mapping, gamma encode, clamp, and contrast. Color grading/vignette/
 *  dither are intentionally absent because Lite does not expose those scene
 *  states yet.
 */

import type { BlockEmitter, NodeExpr } from "../node-types.js";

function imageProcessingHelper(convertInputToLinearSpace: boolean): string {
    const linearize = convertInputToLinearSpace ? `rgb = pow(max(rgb, vec3<f32>(0.0)), vec3<f32>(2.2));` : ``;
    return `fn nme_apply_image_processing(inputColor: vec4<f32>) -> vec4<f32> {
    var rgb = inputColor.rgb;
    ${linearize}
    rgb = rgb * sceneU.vImageInfos.x;
    if (sceneU.vImageInfos.w > 0.5) {
        rgb = 1.0 - exp2(-1.590579 * rgb);
    }
    rgb = pow(max(rgb, vec3<f32>(0.0)), vec3<f32>(0.45454545));
    rgb = clamp(rgb, vec3<f32>(0.0), vec3<f32>(1.0));
    let highContrast = rgb * rgb * (vec3<f32>(3.0) - rgb * 2.0);
    if (sceneU.vImageInfos.y < 1.0) {
        rgb = mix(vec3<f32>(0.5), rgb, sceneU.vImageInfos.y);
    } else {
        rgb = mix(rgb, highContrast, sceneU.vImageInfos.y - 1.0);
    }
    return vec4<f32>(max(rgb, vec3<f32>(0.0)), inputColor.a);
}`;
}

export const emitter: BlockEmitter = {
    className: "ImageProcessingBlock",
    stage: "fragment",
    emit(block, outputName, stage, state, ctx): NodeExpr {
        const convertInput = (block.serialized as { convertInputToLinearSpace?: boolean }).convertInputToLinearSpace !== false;
        const helperKey = `nme_image_processing_${convertInput ? "linear" : "as_is"}`;
        state.fragment.helpers.set(helperKey, imageProcessingHelper(convertInput));
        const color = ctx.cast(ctx.resolve(block, "color", stage, state), "vec4f");
        const t = ctx.temp(state, "ip");
        state.fragment.body.push(`let ${t} = nme_apply_image_processing(${color.expr});`);
        if (outputName === "rgb") {
            return { expr: `${t}.rgb`, type: "vec3f" };
        }
        return { expr: t, type: "vec4f" };
    },
};
