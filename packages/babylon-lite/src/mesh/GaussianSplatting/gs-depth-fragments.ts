/** GsShaderFragment plugins for linear-depth output from a Gaussian-Splatting mesh.
 *
 *  Two variants matching BJS `DepthRenderer` configuration on a GS material:
 *
 *  - `gsLinearDepthFragment` mirrors `depthRenderer.forceDepthWriteTransparentMeshes = true`
 *    on a non-alpha-blended depth pass: each splat fragment with `alpha > 0.001`
 *    writes the linear depth as `(d, d, d, 1)` and the rest discard.
 *
 *  - `gsAlphaBlendedDepthFragment` mirrors `depthRenderer.alphaBlendedDepth = true`
 *    on top: the fragment writes `(d, d, d, gaussianAlpha)` so the swapchain blend
 *    accumulates a soft-edged depth visualisation matching BJS `V80DRL#19`.
 *
 *  Both compute linear depth from `in.pos.z` (reverse-Z NDC z in [0,1] for
 *  WebGPU) and the per-mesh projection matrix that's already present in the GS
 *  UBO, so no extra uniforms are required.
 *
 *  Apply by passing the fragment in `loadSplat(scene, url, [gsLinearDepthFragment])`. */

import type { GsShaderFragment } from "./gaussian-splatting-mesh.js";

const GS_LINEAR_DEPTH_HELPERS = /* wgsl */ `
fn gsLinearDepth(ndcZ: f32) -> f32 {
    // Lite uses a reverse-Z left-handed perspective matrix:
    //   projection[2][2] = -near / (far-near)
    //   projection[3][2] =  far*near / (far-near)
    // For a point at camera-space depth viewZ (positive in front in LH):
    //   pos2d.z = projection[2][2] * viewZ + projection[3][2]
    //   pos2d.w = viewZ
    // After perspective divide (what we get as in.pos.z):
    //   ndcZ = pos2d.z / pos2d.w = projection[2][2] + projection[3][2] / viewZ
    // So we can recover viewZ and the camera near/far purely from the projection:
    let p22 = u.projection[2][2];
    let p32 = u.projection[3][2];
    let viewZ = p32 / (ndcZ - p22);
    let near = p32 / (1.0 - p22);
    let far  = -p32 / p22;
    return clamp((viewZ - near) / (far - near), 0.0, 1.0);
}
`;

/** Force-depth-write variant (BJS `forceDepthWriteTransparentMeshes = true`).
 *  Matches BJS's `gaussianSplattingDepth.fragment.fx` default (no `ALPHA_BLENDED_DEPTH`)
 *  branch exactly:
 *
 *      // base WGSL has `let A = -dot(in.vPos, in.vPos);` and `in.vColor.a = splat.color.a * material.alpha`
 *      if (A < -in.vColor.a) { discard; }                  // ↔ if dot(vPos,vPos) > vColor.a
 *      finalColor = vec4(linearDepth, linearDepth, linearDepth, 1.0);
 *
 *  Per-splat α is used as a *squared-radius* threshold in the splat-local 2D
 *  quad coordinate (`vPos ∈ [-1,1]²`), so each splat clips to a disc of
 *  radius √α inside its quad. No gaussian falloff in the depth pass —
 *  surviving fragments all write `opacity = 1.0` (the EWA core is not
 *  used here; that's the `gsAlphaBlendedDepthFragment` regime). */
export const gsLinearDepthFragment: GsShaderFragment = {
    id: "gsLinearDepth",
    helperFunctions: GS_LINEAR_DEPTH_HELPERS,
    fragmentSlots: {
        GS_FRAGMENT_BEFORE_FRAGCOLOR: /* wgsl */ `
            if (dot(in.vPos, in.vPos) > in.vColor.a) { discard; }
            let _gsDepth = gsLinearDepth(in.pos.z);
            finalColor = vec4<f32>(_gsDepth, _gsDepth, _gsDepth, 1.0);
        `,
    },
};

/** Alpha-blended depth variant (BJS `depthRenderer.alphaBlendedDepth = true`).
 *  Splat fragments emit `(d, d, d, gaussianAlpha)` so the existing GS pipeline's
 *  ALPHA_COMBINE blend accumulates a soft-edged grayscale depth visualisation,
 *  matching BJS `V80DRL#19`. */
export const gsAlphaBlendedDepthFragment: GsShaderFragment = {
    id: "gsAlphaBlendedDepth",
    helperFunctions: GS_LINEAR_DEPTH_HELPERS,
    fragmentSlots: {
        GS_FRAGMENT_BEFORE_FRAGCOLOR: /* wgsl */ `
            let _gsDepth = gsLinearDepth(in.pos.z);
            finalColor = vec4<f32>(_gsDepth, _gsDepth, _gsDepth, finalColor.a);
        `,
    },
};
