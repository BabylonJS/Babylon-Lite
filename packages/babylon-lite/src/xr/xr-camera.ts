import type { Camera, NormalizedViewport } from "../camera/camera.js";
import { _cameraChangeKey } from "../camera/camera.js";
import type { Mat4, Mat4Storage } from "../math/types.js";
import type { XrEye } from "./xr-support.js";
import { allocateMat4 } from "../math/_matrix-allocator.js";
import { copyXrProjectionToLeftHanded, copyXrRigidMatrixToLeftHanded } from "./xr-coordinates.js";

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
 * **Handedness + depth.** WebXR reports right-handed poses/projections while Babylon
 * Lite renders a left-handed world with a reverse-Z ([near→1, far→0]) depth buffer.
 * The eye pose is converted with `H·T·H` and the projection with `P·H`, where
 * `H = diag(1,1,-1,1)`. Input and hand poses use the same boundary conversion, so
 * every material pipeline sees an ordinary left-handed scene with normal winding.
 *  - **Reverse-Z:** the WebGPU binding's `XRView.projectionMatrix` targets `z ∈ [0,1]`
 *    (near→0, far→1). Babylon Lite's pipeline expects reverse-Z (near→1, far→0), so we
 *    remap `row2 ← row3 − row2`. This is handedness-independent and specific to this engine.
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
    // Convert the right-handed eye pose into Lite's left-handed world.
    const m = view.transform.matrix;
    const w = cam._world;
    copyXrRigidMatrixToLeftHanded(w, m);
    // Monotonic bump (never truncated to int32: `worldMatrixVersion` must never
    // decrease per the camera.ts contract; a plain +1 stays exact up to 2^53).
    cam._wmv = cam._wmv + 1;
    cam.viewport = viewport;

    // Inject the per-eye projection so getProjectionMatrix returns it unchanged.
    const aspect = (rtWidth / rtHeight) * (viewport.width / viewport.height);
    const p = cam._projCache;
    const pm = view.projectionMatrix;
    copyXrProjectionToLeftHanded(p, pm);
    // WebGPU-binding projection is z ∈ [0,1] (near→0, far→1); Babylon Lite is reverse-Z
    // (near→1, far→0). Remap row2 ← row3 − row2 so depth matches the reverse-Z pipeline.
    // Handedness-independent after the projection's boundary conversion above.
    p[2] = p[3]! - p[2]!;
    p[6] = p[7]! - p[6]!;
    p[10] = p[11]! - p[10]!;
    p[14] = p[15]! - p[14]!;
    // Match the projection cache to the camera's change key (worldMatrixVersion + the projection
    // revision `getProjectionMatrix` derives from fov/near/far) so the injected matrix is returned
    // verbatim for this aspect instead of being recomputed as a symmetric frustum.
    cam._projVer = _cameraChangeKey(cam);
    cam._projAspect = aspect;
    // Force view + view-projection recompute from the new world matrix + injected projection.
    cam._viewVer = -1;
    cam._vpVer = -1;
}
