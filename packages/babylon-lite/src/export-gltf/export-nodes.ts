/** Scene-graph export: root collection and partitioning, node traversal, transforms, mesh grouping. */

import type { Mat4 } from "../math/types.js";
import { composeMat4 } from "../math/compose-mat4.js";
import { decomposeMat4 } from "../math/decompose-mat4.js";
import type { Mesh } from "../mesh/mesh.js";
import type { SceneContext } from "../scene/scene-core.js";
import type { SceneNode } from "../scene/scene-node.js";
import type { ExportContext } from "./export-context.js";
import { snapshotExtras } from "./export-context.js";
import type { GltfMesh, GltfNode, GltfPrimitive } from "./export-gltf-types.js";
import type { ExportedPrimitive } from "./export-geometry.js";
import { exportPrimitive, zeroUvAccessor } from "./export-geometry.js";
import { convertMatrix, convertRotation, isIdentityRotation, nearlyEqual, OMIT_EPSILON } from "./export-handedness.js";
import { exportMaterial } from "./export-materials.js";
import { writeInstancing } from "./ext/export-ext-instancing.js";

const IDENTITY_MATRIX = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

/** @internal One root of the export and how its subtree exports. */
export interface ExportRoot {
    readonly node: SceneNode;
    /** Converting (Lite left-handed data) or pass-through (right-handed data under a stripped loader root). */
    readonly convert: boolean;
    /** True when the root has a parent that does not export (a camera, a light or another
     *  world-matrix provider); the root then exports at its current world transform. */
    readonly world: boolean;
}

/** @internal Everything the node sweep needs besides the context. */
export interface NodeSweep {
    readonly roots: readonly ExportRoot[];
    /** Parent → children linked only through `child.parent` (missing from `parent.children`). */
    readonly extras: ReadonlyMap<object, readonly SceneNode[]>;
    /** Nodes bound by a glTF-clip animation channel; they must export TRS, never `matrix`. */
    readonly animated: ReadonlySet<object>;
    /** Nodes that never export (the scene camera's fixup node). */
    readonly skipped: ReadonlySet<object>;
    /** `metadata.gltf.extras` of the first stripped loader root that carries extras. */
    readonly assetExtras?: unknown;
}

/** @internal Whether a scene object is a light (exported by the lights module, not the sweep). */
export function isLight(o: object): boolean {
    return "lightType" in o;
}

/** @internal Whether a scene object is a camera (exported by the cameras module, not the sweep). */
export function isCamera(o: object): boolean {
    return "nearPlane" in o;
}

/** @internal Whether a parent link points at a node the sweep exports: a scene node that is
 *  neither a light nor a camera. Any other world-matrix provider is "foreign". */
export function isExportableNode(o: object | null | undefined): o is SceneNode {
    return !!o && "rotationQuaternion" in o && Array.isArray((o as SceneNode).children) && !isLight(o) && !isCamera(o);
}

/** @internal Whether a scene node carries mesh geometry. */
export function isMesh(o: object): o is Mesh {
    return "_gpu" in o;
}

/** @internal Collect and partition the export roots (see "Root collection and partitioning").
 *  `cameraFixup` is the scene camera's fixup node, when it has one; it never exports. */
export function collectRoots(ctx: ExportContext, scene: SceneContext, animated: ReadonlySet<object>, cameraFixup: SceneNode | null): NodeSweep {
    const extras = new Map<object, SceneNode[]>();
    const found: SceneNode[] = [];
    const seen = new Set<SceneNode>();
    const skipped = new Set<object>();
    if (cameraFixup) {
        skipped.add(cameraFixup);
    }

    // Membership sets per parent, built on first use, keep the walk linear in large hierarchies.
    const listedChildren = new Map<object, Set<SceneNode>>();
    const isListed = (parent: SceneNode, child: SceneNode): boolean => {
        let set = listedChildren.get(parent);
        if (!set) {
            set = new Set(parent.children);
            listedChildren.set(parent, set);
        }
        return set.has(child);
    };
    const recorded = new Set<SceneNode>();
    const cycleRoots = new Set<SceneNode>();

    const addRoot = (node: SceneNode): void => {
        if (!seen.has(node)) {
            seen.add(node);
            found.push(node);
        }
    };
    // Walk to the topmost exportable ancestor. Membership is defined by `parent`: a parent that
    // does not list the child records it as an extra child, so the sweep still visits it.
    const topmost = (start: SceneNode, recordExtras: boolean): SceneNode => {
        let node = start;
        const path = new Set<SceneNode>([node]);
        for (;;) {
            const parent = node.parent as object | null;
            if (!isExportableNode(parent)) {
                return node;
            }
            if (path.has(parent)) {
                // A cycle has no world matrix (computing it would recurse forever): export the cycle from
                // this node with its local transform.
                ctx.warn(`Node "${node.name}" is part of a parent cycle; exporting the cycle from this node.`);
                cycleRoots.add(node);
                return node;
            }
            path.add(parent);
            if (recordExtras && !recorded.has(node) && !isListed(parent, node)) {
                recorded.add(node);
                let list = extras.get(parent);
                if (!list) {
                    list = [];
                    extras.set(parent, list);
                }
                list.push(node);
            }
            node = parent;
        }
    };

    for (const mesh of scene.meshes) {
        addRoot(topmost(mesh, true));
    }
    for (const light of scene.lights) {
        const parent = light.parent as object | null;
        if (isExportableNode(parent)) {
            addRoot(topmost(parent, false));
        }
    }
    // A camera under its fixup node contributes no root: it attaches to the fixup's parent only
    // when that parent exports through another seed (see Cameras).
    const cameraParent = (scene.camera as { parent?: object | null } | null)?.parent ?? null;
    if (cameraParent !== cameraFixup && isExportableNode(cameraParent)) {
        addRoot(topmost(cameraParent, false));
    }
    for (const target of animated) {
        if (isExportableNode(target)) {
            addRoot(topmost(target, true));
        }
    }

    const roots: ExportRoot[] = [];
    let assetExtras: unknown;
    for (const node of found) {
        if (skipped.has(node)) {
            continue;
        }
        const world = node.parent !== null && node.parent !== undefined && !cycleRoots.has(node);
        if (!world && isLoaderRoot(node, animated)) {
            const rootExtras = node.metadata?.gltf?.extras;
            if (assetExtras === undefined && rootExtras !== undefined) {
                assetExtras = rootExtras;
            }
            for (const child of childrenOf(node, extras, skipped)) {
                roots.push({ node: child, convert: false, world: false });
            }
            continue;
        }
        roots.push({ node, convert: true, world });
    }
    return { roots, extras, animated, skipped, assetExtras };
}

/** The glTF loader's conversion root: a geometry-free, matrix-free TransformNode at the origin with
 *  identity rotation and scaling (−1, 1, 1), not bound by any animation channel. Detected by shape
 *  only (never by name); inverts `createTransformNode("__root__", 0,0,0, 0,0,0,1, −1,1,1)`. */
function isLoaderRoot(node: SceneNode, animated: ReadonlySet<object>): boolean {
    if (isMesh(node) || node._localMatrix || animated.has(node)) {
        return false;
    }
    const p = node.position;
    const q = node.rotationQuaternion;
    const s = node.scaling;
    return nearlyEqual([p.x, p.y, p.z], [0, 0, 0]) && nearlyEqual([q.x, q.y, q.z, q.w], [0, 0, 0, 1]) && nearlyEqual([s.x, s.y, s.z], [-1, 1, 1]);
}

/** A node's children as the sweep visits them: listed children whose `parent` is the node, then
 *  parent-only extras; lights, cameras and skipped nodes excluded (they export elsewhere or never). */
function childrenOf(node: SceneNode, extras: ReadonlyMap<object, readonly SceneNode[]>, skipped: ReadonlySet<object>): SceneNode[] {
    const out: SceneNode[] = [];
    const seen = new Set<SceneNode>();
    for (const child of node.children) {
        if (child.parent === node && !isLight(child) && !isCamera(child) && !skipped.has(child) && !seen.has(child)) {
            seen.add(child);
            out.push(child);
        }
    }
    for (const child of extras.get(node) ?? []) {
        if (!skipped.has(child) && !seen.has(child)) {
            seen.add(child);
            out.push(child);
        }
    }
    return out;
}

/** @internal Export every root depth-first and append the root indices to `scenes[0].nodes`. */
export function exportNodeTrees(ctx: ExportContext, sweep: NodeSweep): void {
    for (const root of sweep.roots) {
        if (root.world) {
            ctx.warn(`Node "${root.node.name}" is parented to a camera, light or other non-node object; exporting it as a scene root at its current world transform.`);
        }
        const index = exportNode(ctx, sweep, root.node, root.convert, root.world);
        if (index !== undefined) {
            ctx.doc.sceneNodes.push(index);
        }
    }
}

function exportNode(ctx: ExportContext, sweep: NodeSweep, node: SceneNode, convert: boolean, world: boolean): number | undefined {
    if (ctx.nodeIndex.has(node)) {
        // A strict tree reaches every node once; never link a node under a second parent.
        return undefined;
    }
    const out: GltfNode = {};
    if (node.name) {
        out.name = node.name;
    }
    const index = ctx.doc.nodes.push(out) - 1;
    ctx.nodeIndex.set(node, index);
    ctx.nodeConvert.set(node, convert);

    writeTransform(ctx, out, node, convert, sweep.animated.has(node), world ? node.worldMatrix : node._localMatrix);

    const children = childrenOf(node, sweep.extras, sweep.skipped);
    let contributors: Mesh[];
    let rest: SceneNode[];
    if (isMesh(node)) {
        contributors = [node];
        rest = children;
    } else {
        contributors = [];
        rest = [];
        for (const child of children) {
            if (isMesh(child) && canFold(child, contributors[0], sweep)) {
                contributors.push(child);
                ctx.nodeIndex.set(child, index);
                ctx.nodeConvert.set(child, convert);
            } else {
                rest.push(child);
            }
        }
    }
    if (contributors.length > 0) {
        writeMesh(ctx, out, node, contributors, convert);
    }

    const extras = snapshotExtras(ctx, node.metadata?.gltf?.extras, node.name);
    if (extras !== undefined) {
        out.extras = extras;
    }

    for (const child of rest) {
        const childIndex = exportNode(ctx, sweep, child, convert, false);
        if (childIndex !== undefined) {
            (out.children ??= []).push(childIndex);
        }
    }
    return index;
}

/** Whether a mesh child folds into its non-mesh parent's glTF mesh (see "Mesh assembly"). */
function canFold(mesh: Mesh, first: Mesh | undefined, sweep: NodeSweep): boolean {
    if (mesh._localMatrix || mesh.children.length > 0 || sweep.extras.has(mesh) || sweep.animated.has(mesh) || !isIdentityTrs(mesh)) {
        return false;
    }
    if (!first) {
        return true;
    }
    const a = mesh.thinInstances && mesh.thinInstances.count > 0 ? mesh.thinInstances : null;
    const b = first.thinInstances && first.thinInstances.count > 0 ? first.thinInstances : null;
    if (a !== b && (!a || !b || a.matrices !== b.matrices || a.count !== b.count)) {
        return false;
    }
    const ma = mesh.morphTargets?.targets.length ? mesh.morphTargets : null;
    const mb = first.morphTargets?.targets.length ? first.morphTargets : null;
    if (!ma || !mb) {
        return ma === mb;
    }
    if (ma.targets.length !== mb.targets.length) {
        return false;
    }
    for (let i = 0; i < ma.weights.length; i++) {
        if (ma.weights[i] !== mb.weights[i]) {
            return false;
        }
    }
    return true;
}

function isIdentityTrs(node: SceneNode): boolean {
    const p = node.position;
    const q = node.rotationQuaternion;
    const s = node.scaling;
    return nearlyEqual([p.x, p.y, p.z], [0, 0, 0], OMIT_EPSILON) && isIdentityRotation([q.x, q.y, q.z, q.w]) && nearlyEqual([s.x, s.y, s.z], [1, 1, 1], OMIT_EPSILON);
}

/** Write a node's local transform. `matrix` is the node's `_localMatrix`, or its world matrix for a
 *  root whose parent does not export; otherwise the observable TRS is used. */
function writeTransform(ctx: ExportContext, out: GltfNode, node: SceneNode, convert: boolean, animated: boolean, matrix: Mat4 | undefined): void {
    if (matrix) {
        const d = decomposeMat4(matrix);
        const recomposed = composeMat4(d.translation.x, d.translation.y, d.translation.z, d.rotation.x, d.rotation.y, d.rotation.z, d.rotation.w, d.scale.x, d.scale.y, d.scale.z);
        const decomposable = nearlyEqual(recomposed, matrix);
        if (decomposable && !animated) {
            const m = convert ? convertMatrix(matrix) : Array.from(matrix as ArrayLike<number>);
            if (!nearlyEqual(m, IDENTITY_MATRIX, OMIT_EPSILON)) {
                out.matrix = m;
            }
            return;
        }
        if (!decomposable) {
            ctx.warn(`Node "${node.name}" has a sheared local transform, which glTF cannot represent; exporting the nearest TRS.`);
        }
        writeTrs(out, convert, d.translation, d.rotation, d.scale);
        return;
    }
    writeTrs(out, convert, node.position, node.rotationQuaternion, node.scaling);
}

interface Xyz {
    readonly x: number;
    readonly y: number;
    readonly z: number;
}

function writeTrs(out: GltfNode, convert: boolean, t: Xyz, q: Xyz & { readonly w: number }, s: Xyz): void {
    if (!nearlyEqual([t.x, t.y, t.z], [0, 0, 0], OMIT_EPSILON)) {
        out.translation = [convert ? -t.x : t.x, t.y, t.z];
    }
    const r = convert ? convertRotation(q.x, q.y, q.z, q.w) : unitQuat(q.x, q.y, q.z, q.w);
    if (!isIdentityRotation(r)) {
        out.rotation = r;
    }
    if (!nearlyEqual([s.x, s.y, s.z], [1, 1, 1], OMIT_EPSILON)) {
        out.scale = [s.x, s.y, s.z];
    }
}

/** A quaternion as emitted in pass-through: verbatim when already unit length (keeps round trips
 *  byte-stable), normalized otherwise. */
function unitQuat(x: number, y: number, z: number, w: number): [number, number, number, number] {
    const len = Math.hypot(x, y, z, w);
    if (!(len > 0)) {
        return [0, 0, 0, 1];
    }
    return Math.abs(len - 1) <= 1e-6 ? [x, y, z, w] : [x / len, y / len, z / len, w / len];
}

/** Build (or reuse) the glTF mesh for a node's contributing Lite meshes and attach it, together
 *  with the thin-instance extension and the morph weights. */
function writeMesh(ctx: ExportContext, out: GltfNode, owner: SceneNode, contributors: readonly Mesh[], convert: boolean): void {
    const primitives: GltfPrimitive[] = [];
    let weights: number[] | undefined;
    for (const mesh of contributors) {
        const exported: ExportedPrimitive | null = exportPrimitive(ctx, mesh, convert);
        if (!exported) {
            continue;
        }
        const material = exportMaterial(ctx, mesh.material, exported.uvState);
        if (material !== undefined) {
            exported.primitive.material = material;
            // Lite samples a zero-filled UV buffer on a mesh without UVs; glTF needs the attribute.
            if (ctx.materialsUsingUv0.has(material) && exported.primitive.attributes.TEXCOORD_0 === undefined) {
                exported.primitive.attributes.TEXCOORD_0 = zeroUvAccessor(ctx, exported.vertexCount);
            }
        }
        primitives.push(exported.primitive);
        weights ??= exported.weights;
    }
    if (primitives.length === 0) {
        return;
    }
    const name = contributors.find((m) => m.name)?.name;
    // The loader promotes the first of primitive, mesh or node extras onto each Lite mesh, by
    // reference: a mesh holding its node's extras object got them from the node, so they are node
    // extras, not mesh extras. (For a standalone mesh node the two are the same object.)
    const ownerExtras = owner.metadata?.gltf?.extras;
    const extrasSource = contributors.find((m) => m.metadata?.gltf?.extras !== undefined && m.metadata.gltf.extras !== ownerExtras);
    const meshExtras = extrasSource ? snapshotExtras(ctx, extrasSource.metadata?.gltf?.extras, extrasSource.name) : undefined;
    // Meshes are shared only when everything they would emit is identical.
    const signature = JSON.stringify([primitives, weights, name, meshExtras]);
    let meshIndex = ctx.meshIndex.get(signature);
    if (meshIndex === undefined) {
        const gltfMesh: GltfMesh = { primitives };
        if (name) {
            gltfMesh.name = name;
        }
        if (weights) {
            gltfMesh.weights = weights;
        }
        if (meshExtras !== undefined) {
            gltfMesh.extras = meshExtras;
        }
        meshIndex = ctx.doc.meshes.push(gltfMesh) - 1;
        ctx.meshIndex.set(signature, meshIndex);
    }
    out.mesh = meshIndex;
    const instanced = contributors.find((m) => m.thinInstances && m.thinInstances.count > 0);
    if (instanced) {
        writeInstancing(ctx, out, instanced, convert);
    }
}
