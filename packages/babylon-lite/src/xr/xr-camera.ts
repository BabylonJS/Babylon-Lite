import type { Camera, NormalizedViewport } from "../camera/camera.js";
import type { Mat4, Mat4Storage } from "../math/types.js";
import type { XrEye } from "./xr-support.js";
import { allocateMat4 } from "../math/_matrix-allocator.js";

/**
 * XrCamera — a {@link Camera} whose view and projection matrices come from an
 * {@link XRView} (one camera per eye) rather than from `fov`/position. Pure data,
 * no scene knowledge (pillar 4b).
 *
 * Integration is deliberately zero-cost for non-XR scenes: instead of adding an
 * override branch to the shared `camera.ts` getters (which would grow every
 * scene's bundle), the XR camera writes directly into the existing matrix caches
 * that `getViewMatrix` / `getProjectionMatrix` / `getViewProjectionMatrix` already
 * read:
 *
 *  - **View matrix + eye position** derive for free from {@link Camera.worldMatrix}:
 *    we set `_world = XRView.transform.matrix` (the eye pose, view→world,
 *    column-major) and bump `worldMatrixVersion`. `getViewMatrix` then produces the
 *    inverse rigid transform (the view matrix) and `_packSceneUniforms` reads the
 *    eye position from the world matrix translation column — both automatically.
 *  - **Projection** is the per-eye asymmetric frustum from `XRView.projectionMatrix`,
 *    which the symmetric-perspective `getProjectionMatrix` cannot reproduce. We
 *    inject it straight into `_projCache` and set `_projVer`/`_projAspect` so the
 *    cache returns it verbatim for the exact aspect the render task will request.
 *
 * **Handedness + depth conversion.** WebXR reports poses and projections in a
 * *right-handed* frame, while Babylon Lite is *left-handed* with a *reverse-Z*
 * ([near→1, far→0]) depth buffer. Feeding the matrices verbatim flips triangle
 * winding (back-face culling then removes the front faces — the scene looks
 * inside-out) and mismatches the depth test. We therefore convert both matrices
 * on the way in, mirroring Babylon.js `WebXRCamera` (which does the same for
 * left-handed scenes):
 *  - **Pose → world:** `toggleModelMatrixHandInPlace` — negate `m[2,6,8,9,14]`
 *    (conjugate the rotation + translation by `diag(1,1,-1,1)`). The result is a
 *    proper LH rigid transform, so `getViewMatrix`'s transpose-inverse stays exact.
 *  - **Projection:** `toggleProjectionMatrixHandInPlace` — negate the whole Z input
 *    column `m[8,9,10,11]`. Together with the pose toggle this preserves winding, so
 *    normal back-face culling works (no `_reverseCulling` needed).
 *  - **Reverse-Z:** the WebGPU binding's `XRView.projectionMatrix` targets `z ∈ [0,1]`
 *    (near→0, far→1). Babylon Lite's pipeline expects reverse-Z (near→1, far→0), so we
 *    additionally remap `row2 ← row3 − row2`. Babylon.js skips this (it is not reverse-Z);
 *    it is specific to this engine.
 */
export interface XrCamera extends Camera {
    /** Which eye this camera renders (`"left"`, `"right"`, or `"none"` for mono). */
    readonly eye: XrEye;
    /** @internal Mutable eye pose (view→world), column-major. Backs `worldMatrix`. */
    _world: Mat4Storage;
    /** @internal Version counter, bumped each {@link updateXrCameraForView}. Backs `worldMatrixVersion`. */
    _wmv: number;
}

/** Create an XR camera for one eye. Matrices are populated each frame by
 *  {@link updateXrCameraForView}; `nearPlane`/`farPlane` are advisory only
 *  (the XR projection matrix already encodes the frustum). */
export function createXrCamera(eye: XrEye): XrCamera {
    const world = allocateMat4() as unknown as Mat4Storage;
    world[0] = world[5] = world[10] = world[15] = 1;
    const cam = {
        eye,
        fov: 1,
        nearPlane: 0.1,
        farPlane: 1000,
        viewport: undefined as NormalizedViewport | undefined,
        children: [],
        _viewCache: allocateMat4() as unknown as Mat4Storage,
        _projCache: allocateMat4() as unknown as Mat4Storage,
        _vpCache: allocateMat4() as unknown as Mat4Storage,
        _world: world,
        _wmv: 1,
        get worldMatrix(): Mat4 {
            return (this as XrCamera)._world as unknown as Mat4;
        },
        get worldMatrixVersion(): number {
            return (this as XrCamera)._wmv;
        },
    } as XrCamera;
    return cam;
}

/**
 * Update an XR camera from an {@link XRView} for the current frame.
 *
 * @param cam - The eye camera to update.
 * @param view - The frame's {@link XRView} for this eye.
 * @param rtWidth - Render-target width in pixels (the projection layer's texture width).
 * @param rtHeight - Render-target height in pixels.
 * @param viewport - Normalized viewport (`subImage.viewport / texture dims`) the
 *   render task will apply. The injected-projection aspect is computed with the
 *   **identical** float expression the render task uses
 *   (`(rtWidth / rtHeight) * (viewport.width / viewport.height)`) so the cache
 *   returns the XR projection verbatim instead of recomputing a symmetric one.
 */
export function updateXrCameraForView(cam: XrCamera, view: XRView, rtWidth: number, rtHeight: number, viewport: NormalizedViewport): void {
    // Eye pose (view→world) → world matrix, converted right-handed → left-handed via
    // `toggleModelMatrixHandInPlace` (negate m[2,6,8,9,14]). Bumping the version
    // invalidates the view / view-projection caches so they recompute from the new pose.
    const m = view.transform.matrix;
    const w = cam._world;
    for (let i = 0; i < 16; i++) {
        w[i] = m[i]!;
    }
    w[2] = -w[2]!;
    w[6] = -w[6]!;
    w[8] = -w[8]!;
    w[9] = -w[9]!;
    w[14] = -w[14]!;
    cam._wmv = (cam._wmv + 1) | 0;
    cam.viewport = viewport;

    // Inject the per-eye projection so getProjectionMatrix returns it unchanged.
    const aspect = (rtWidth / rtHeight) * (viewport.width / viewport.height);
    const p = cam._projCache;
    const pm = view.projectionMatrix;
    for (let i = 0; i < 16; i++) {
        p[i] = pm[i]!;
    }
    // Right-handed → left-handed: `toggleProjectionMatrixHandInPlace` negates the Z
    // input column (m[8,9,10,11]). With the pose toggle above this preserves winding.
    p[8] = -p[8]!;
    p[9] = -p[9]!;
    p[10] = -p[10]!;
    p[11] = -p[11]!;
    // WebGPU-binding projection is z ∈ [0,1] (near→0, far→1); Babylon Lite is reverse-Z
    // (near→1, far→0). Remap row2 ← row3 − row2 so depth matches the reverse-Z pipeline.
    p[2] = p[3]! - p[2]!;
    p[6] = p[7]! - p[6]!;
    p[10] = p[11]! - p[10]!;
    p[14] = p[15]! - p[14]!;
    cam._projVer = cam._wmv;
    cam._projAspect = aspect;
    // Force view + view-projection recompute from the new world matrix + injected projection.
    cam._viewVer = -1;
    cam._vpVer = -1;
}
