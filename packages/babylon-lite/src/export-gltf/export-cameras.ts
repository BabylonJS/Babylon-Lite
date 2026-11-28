/** Camera export: the scene camera's node placement and projection. */

import type { Camera } from "../camera/camera.js";
import { getEffectiveAspectRatio } from "../camera/camera.js";
import type { Mat4 } from "../math/types.js";
import { decomposeMat4 } from "../math/decompose-mat4.js";
import { invertMat4 } from "../math/invert-mat4.js";
import { mat4Determinant3 } from "../math/mat4-determinant3.js";
import { multiplyMat4 } from "../math/multiply-mat4.js";
import type { SceneContext } from "../scene/scene-core.js";
import type { SceneNode } from "../scene/scene-node.js";
import type { ExportContext } from "./export-context.js";
import type { GltfCamera, GltfNode } from "./export-gltf-types.js";
import { convertRotation, EXPORT_EPSILON, isIdentityRotation, nearlyEqual, OMIT_EPSILON, rotate180Y } from "./export-handedness.js";
import { isExportableNode, isMesh } from "./export-nodes.js";

/** Lite stores glTF's infinite perspective far plane as this sentinel. */
const INFINITE_FAR = 1e6;

/** The camera's world matrix relative to a pristine fixup: the 180° yaw `diag(−1, 1, −1)` that
 *  `createFreeCamera((0,0,0), (0,0,−1))` leaves, with zero translation. */
const PRISTINE_RELATIVE = [-1, 0, 0, 0, 0, 1, 0, 0, 0, 0, -1, 0, 0, 0, 0, 1];

type ParentedCamera = Camera & { readonly parent?: object | null };

/** @internal The camera's parent when it is fixup-shaped: a geometry-free TransformNode with empty
 *  `children` and scaling `(−a, a, a)` for a uniform `a > 0` — the scaffolding `gltf-feature-camera.ts`
 *  inserts (detected by shape only). Null otherwise. */
export function cameraFixupOf(camera: Camera | null): SceneNode | null {
    const parent = (camera as ParentedCamera | null)?.parent ?? null;
    if (!isExportableNode(parent) || isMesh(parent) || parent.children.length > 0) {
        return null;
    }
    const s = parent.scaling;
    return s.y > 0 && Math.abs(s.x + s.y) <= EXPORT_EPSILON && Math.abs(s.z - s.y) <= EXPORT_EPSILON ? parent : null;
}

/** @internal Emit `cameras[0]` and the scene camera's node placement (synchronous, after the node sweep). */
export function exportCamera(ctx: ExportContext, scene: SceneContext, fixup: SceneNode | null): void {
    const camera = scene.camera as ParentedCamera | null;
    if (!camera) {
        return;
    }
    const cameraIndex = ctx.doc.cameras.push(projectionOf(ctx, scene, camera)) - 1;

    // Placement parent: the fixup's parent when the camera sits under a fixup, else the camera's own
    // parent — in both cases only when that node exported through another seed.
    const candidate = fixup ? (fixup.parent as object | null) : (camera.parent ?? null);
    let parent: object | null = candidate && ctx.nodeIndex.has(candidate) ? candidate : null;
    // In a converting pass the parent's glTF global basis has the sign of its Lite world determinant; a
    // negative one (a loader root kept under an app node) would leave the camera's view undefined. Under a
    // stripped loader root any mirror comes from the source glTF and is kept as it was.
    if (parent && ctx.nodeConvert.get(parent) === true && mat4Determinant3((parent as SceneNode).worldMatrix) < 0) {
        ctx.warn(`Camera parent "${(parent as SceneNode).name}" has a mirrored glTF frame; exporting the camera as a scene root.`);
        parent = null;
    }

    if (fixup && parent) {
        if (isPristineFixup(fixup, camera)) {
            ctx.doc.nodes[ctx.nodeIndex.get(parent)!]!.camera = cameraIndex;
            ctx.nodeIndex.set(camera, ctx.nodeIndex.get(parent)!);
            ctx.nodeConvert.set(camera, ctx.nodeConvert.get(parent) === true);
            return;
        }
        ctx.warn(`Camera fixup node "${fixup.name}" carries extra transform; exporting the camera as its own node.`);
    }

    let relative: Mat4 = camera.worldMatrix;
    if (parent) {
        const inverse = invertMat4((parent as { worldMatrix: Mat4 }).worldMatrix);
        if (inverse) {
            relative = multiplyMat4(inverse, camera.worldMatrix);
        } else {
            ctx.warn(`Camera parent "${(parent as { name?: string }).name ?? ""}" has a singular world matrix; exporting the camera as a scene root.`);
            parent = null;
        }
    }
    const convert = parent ? ctx.nodeConvert.get(parent) === true : true;

    const node: GltfNode = {};
    if (camera.name) {
        node.name = camera.name;
    }
    let translation: number[];
    let rotation: number[];
    if (convert) {
        if (mat4Determinant3(relative) < 0) {
            // A mirrored view would fold into −Y scale and flip the camera upside down; negating the X
            // column keeps its forward and up.
            ctx.warn(`Camera "${camera.name ?? ""}" has a mirrored view under its parent; exporting it unmirrored.`);
            const m = Array.from(relative as ArrayLike<number>);
            m[0] = -m[0]!;
            m[1] = -m[1]!;
            m[2] = -m[2]!;
            relative = m as unknown as Mat4;
        }
        // Lite cameras look along local +Z; glTF cameras look along −Z.
        const { translation: t, rotation: q } = decomposeMat4(relative);
        translation = [-t.x, t.y, t.z];
        const c = convertRotation(q.x, q.y, q.z, q.w);
        rotation = rotate180Y(c[0], c[1], c[2], c[3]);
    } else {
        // `relative` is in the parent's right-handed frame. An unmirrored Lite view under the root
        // flip has det < 0; negating the third column turns it into a proper glTF camera frame.
        if (mat4Determinant3(relative) > 0) {
            ctx.warn(`Camera "${camera.name ?? ""}" has a mirrored view under its parent; exporting it unmirrored.`);
        }
        const m = Array.from(relative as ArrayLike<number>);
        m[8] = -m[8]!;
        m[9] = -m[9]!;
        m[10] = -m[10]!;
        const { translation: t, rotation: q } = decomposeMat4(m as unknown as Mat4);
        translation = [t.x, t.y, t.z];
        rotation = [q.x, q.y, q.z, q.w];
    }
    if (!isIdentityRotation(rotation)) {
        node.rotation = rotation;
    }
    if (!nearlyEqual(translation, [0, 0, 0], OMIT_EPSILON)) {
        node.translation = translation;
    }
    node.camera = cameraIndex;
    const index = ctx.doc.nodes.push(node) - 1;
    ctx.nodeIndex.set(camera, index);
    ctx.nodeConvert.set(camera, convert);
    if (parent) {
        (ctx.doc.nodes[ctx.nodeIndex.get(parent)!]!.children ??= []).push(index);
    } else {
        ctx.doc.sceneNodes.push(index);
    }
}

/** The loader's untouched fixup: origin, identity rotation, and the camera's 180° yaw relative to it. */
function isPristineFixup(fixup: SceneNode, camera: Camera): boolean {
    const p = fixup.position;
    const q = fixup.rotationQuaternion;
    if (!nearlyEqual([p.x, p.y, p.z], [0, 0, 0]) || !nearlyEqual([q.x, q.y, q.z, q.w], [0, 0, 0, 1])) {
        return false;
    }
    const inverse = invertMat4(fixup.worldMatrix);
    if (!inverse) {
        return false;
    }
    return nearlyEqual(multiplyMat4(inverse, camera.worldMatrix), PRISTINE_RELATIVE);
}

function projectionOf(ctx: ExportContext, scene: SceneContext, camera: Camera): GltfCamera {
    const canvas = (scene.surface as { canvas?: { width: number; height: number } } | undefined)?.canvas;
    const ratio = canvas && canvas.width > 0 && canvas.height > 0 ? getEffectiveAspectRatio(camera, canvas.width, canvas.height) : undefined;
    const aspect = ratio !== undefined && ratio > 0 && Number.isFinite(ratio) ? ratio : undefined;
    const out: GltfCamera = { type: "perspective" };
    if (camera.name) {
        out.name = camera.name;
    }
    const ortho = camera.ortho;
    if (!ortho) {
        out.perspective = { yfov: camera.fov, znear: camera.nearPlane };
        if (camera.farPlane < INFINITE_FAR && camera.farPlane > camera.nearPlane) {
            out.perspective.zfar = camera.farPlane;
        }
        if (aspect !== undefined) {
            out.perspective.aspectRatio = aspect;
        }
        return out;
    }
    out.type = "orthographic";
    const name = camera.name ?? "";
    let xmag: number;
    if (ortho.left !== null && ortho.right !== null) {
        xmag = (ortho.right - ortho.left) / 2;
        if (Math.abs(ortho.left + ortho.right) > EXPORT_EPSILON) {
            ctx.warn(`Orthographic camera "${name}" has off-center bounds; exporting a symmetric projection.`);
        }
    } else if (aspect !== undefined) {
        xmag = ortho.halfHeight * aspect;
    } else {
        ctx.warn("Orthographic camera aspect is unavailable under a null engine; exporting xmag = ymag.");
        xmag = ortho.halfHeight;
    }
    let ymag: number;
    if (ortho.top !== null && ortho.bottom !== null) {
        ymag = (ortho.top - ortho.bottom) / 2;
        if (Math.abs(ortho.top + ortho.bottom) > EXPORT_EPSILON) {
            ctx.warn(`Orthographic camera "${name}" has off-center bounds; exporting a symmetric projection.`);
        }
    } else {
        ymag = ortho.halfHeight;
    }
    out.orthographic = { xmag, ymag, znear: camera.nearPlane, zfar: camera.farPlane };
    return out;
}
