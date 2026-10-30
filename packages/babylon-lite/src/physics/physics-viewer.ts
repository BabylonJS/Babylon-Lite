import type { Mesh } from "../mesh/mesh.js";
import { createCylinder, createDisc, createMeshFromData, updateMeshPositions } from "../mesh/mesh-factories.js";
import { _hasSceneChangeHook, _runSceneChange, addToScene, type SceneContext } from "../scene/scene-core.js";
import { removeFromScene } from "../scene/scene-remove.js";
import type { Mat4Storage, Quat, Vec3 } from "../math/types.js";
import { _quatFromRotationBasis } from "../math/create-quat-from-rotation-mat4.js";
import { multiplyMat4IntoBuffer } from "../math/multiply-mat4-into-buffer.js";
import { composeMat4IntoBuffer } from "../math/compose-mat4-into-buffer.js";
import { createStandardMaterial } from "../material/standard/create-standard-material.js";
import type { PhysicsBody, PhysicsWorld, PhysicsConstraint } from "./havok.js";
import { getPhysicsBodyDebugGeometry } from "./havok.js";
import { createPhysicsDebugLineMaterial } from "./physics-debug-line-material.js";

/** Options used when creating a physics debug viewer. */
export interface PhysicsViewerOptions {
    /** RGBA debug line color. Defaults to opaque white, matching Babylon.js PhysicsViewer. */
    color?: readonly [number, number, number, number];
}

/** Pure-state handle for Havok Physics V2 debug rendering. */
export interface PhysicsViewer {
    readonly scene: SceneContext;
    readonly world: PhysicsWorld;
    /** @internal */
    readonly _bodies: PhysicsBody[];
    /** @internal */
    readonly _meshes: Mesh[];
    /** @internal */
    readonly _constraintMeshes: Mesh[];
    /** @internal */
    readonly _constraintKeys: PhysicsConstraintDebug[];
    /** @internal */
    readonly _constraintGroups: Mesh[][];
    /** @internal */
    readonly _constraintLines: ConstraintLine[];
    /** @internal */
    readonly _constraintDisks: ConstraintDisk[];
    /** @internal */
    readonly _constraintArrowheads: ConstraintArrowhead[];
    /** @internal */
    readonly _color: readonly [number, number, number, number];
    /** @internal */
    readonly _update: () => void;
    /** @internal */
    _registered: boolean;
}

/** Minimal constraint debug data consumed by the Lite PhysicsViewer. */
export interface PhysicsConstraintDebug {
    readonly bodyA: PhysicsBody;
    readonly bodyB: PhysicsBody;
    readonly pivotA: Vec3;
    readonly pivotB: Vec3;
    readonly axisA?: Vec3;
    readonly axisB?: Vec3;
    readonly perpAxisA?: Vec3;
    readonly perpAxisB?: Vec3;
    readonly type?: number;
}

interface ConstraintEndpoint {
    readonly body: PhysicsBody;
    readonly pivot: Vec3;
    readonly axis?: Vec3;
    readonly axisLength?: number;
}

interface ConstraintLine {
    readonly mesh: Mesh;
    readonly positions: Float32Array;
    readonly a: ConstraintEndpoint;
    readonly b: ConstraintEndpoint;
}

interface ConstraintDisk {
    readonly mesh: Mesh;
    readonly endpoint: ConstraintEndpoint;
    readonly axis: Vec3;
}

interface ConstraintArrowhead {
    readonly mesh: Mesh;
    readonly endpoint: ConstraintEndpoint;
}

const CONSTRAINT_BALL_AND_SOCKET = 1;
const CONSTRAINT_DISTANCE = 2;
const CONSTRAINT_HINGE = 3;
const CONSTRAINT_SLIDER = 4;
const CONSTRAINT_LOCK = 5;
const CONSTRAINT_PRISMATIC = 6;
const CONSTRAINT_SIX_DOF = 7;

/** Creates a tree-shakable Physics V2 debug viewer for a scene/world pair. */
export function createPhysicsViewer(scene: SceneContext, world: PhysicsWorld, options: PhysicsViewerOptions = {}): PhysicsViewer {
    const viewer: PhysicsViewer = {
        scene,
        world,
        _bodies: [],
        _meshes: [],
        _constraintMeshes: [],
        _constraintKeys: [],
        _constraintGroups: [],
        _constraintLines: [],
        _constraintDisks: [],
        _constraintArrowheads: [],
        _color: options.color ?? [1, 1, 1, 1],
        _registered: false,
        _update: () => {
            updatePhysicsViewer(viewer);
        },
    };
    return viewer;
}

/**
 * Cached viewer data for a constraint. Repeated calls return the identical object.
 * Creation options are immutable; omitted pivots default to body-local zero.
 * No native calls are made, including after constraint release.
 */
export function getPhysicsConstraintDebug(constraint: PhysicsConstraint): PhysicsConstraintDebug {
    return (constraint._debug ??= {
        bodyA: constraint.bodyA,
        bodyB: constraint.bodyB,
        type: constraint.type,
        pivotA: constraint.options.pivotA ?? { x: 0, y: 0, z: 0 },
        pivotB: constraint.options.pivotB ?? { x: 0, y: 0, z: 0 },
        axisA: constraint.options.axisA,
        axisB: constraint.options.axisB,
        perpAxisA: constraint.options.perpAxisA,
        perpAxisB: constraint.options.perpAxisB,
    });
}

/** Shows a simplified Physics V2 constraint overlay: local axes (with arrowheads) plus angular-limit disks. */
export function showPhysicsConstraint(viewer: PhysicsViewer, constraint: PhysicsConstraintDebug): Mesh[] {
    if (viewer._constraintKeys.includes(constraint)) {
        return [];
    }
    let meshes: Mesh[] = [];
    // Defer scene-change listeners until the key and full mesh group are registered.
    batchSceneChanges(viewer.scene, () => {
        meshes = addConstraintMeshes(viewer, constraint);
    });
    return meshes;
}

function addConstraintMeshes(viewer: PhysicsViewer, constraint: PhysicsConstraintDebug): Mesh[] {
    const meshStart = viewer._constraintMeshes.length;
    const axisLen = 0.4;
    const diskRadius = 0.6;
    const axisA = constraint.axisA ?? { x: 1, y: 0, z: 0 };
    const axisB = constraint.axisB ?? { x: 1, y: 0, z: 0 };
    const perpAxisA = constraint.perpAxisA ?? normalTo(axisA);
    const perpAxisB = constraint.perpAxisB ?? normalTo(axisB);
    const thirdAxisA = normalize(cross(axisA, perpAxisA));
    const thirdAxisB = normalize(cross(axisB, perpAxisB));
    const meshes = [
        createConstraintAxisMesh(viewer, constraint.bodyA, constraint.pivotA, axisA, axisLen, [1, 0, 0, 1], "constraintAxisAX"),
        createConstraintAxisMesh(viewer, constraint.bodyA, constraint.pivotA, perpAxisA, axisLen, [0, 1, 0, 1], "constraintAxisAY"),
        createConstraintAxisMesh(viewer, constraint.bodyA, constraint.pivotA, thirdAxisA, axisLen, [0, 0.35, 1, 1], "constraintAxisAZ"),
        createConstraintAxisMesh(viewer, constraint.bodyB, constraint.pivotB, axisB, axisLen, [1, 0, 0, 1], "constraintAxisBX"),
        createConstraintAxisMesh(viewer, constraint.bodyB, constraint.pivotB, perpAxisB, axisLen, [0, 1, 0, 1], "constraintAxisBY"),
        createConstraintAxisMesh(viewer, constraint.bodyB, constraint.pivotB, thirdAxisB, axisLen, [0, 0.35, 1, 1], "constraintAxisBZ"),
    ];
    const diskAxes = [axisB, perpAxisB, thirdAxisB] as const;
    const diskColors = [
        [1, 0, 0, 1],
        [0, 1, 0, 1],
        [0, 0.35, 1, 1],
    ] as const;
    for (const axisIndex of angularDiskAxes(constraint.type)) {
        const color = diskColors[axisIndex]!;
        meshes.push(
            createConstraintDiskMesh(
                viewer,
                constraint.bodyB,
                constraint.pivotB,
                diskAxes[axisIndex]!,
                diskRadius,
                [color[0], color[1], color[2], color[3]],
                `constraintAngle${axisIndex}`
            )
        );
    }
    for (const mesh of meshes) {
        viewer._constraintMeshes.push(mesh);
        addToScene(viewer.scene, mesh);
    }
    viewer._constraintKeys.push(constraint);
    viewer._constraintGroups.push(viewer._constraintMeshes.slice(meshStart));
    registerViewerUpdate(viewer);
    return meshes;
}

/**
 * Hide a previously shown constraint by its stable debug object, returning whether it was shown.
 * Makes no native calls; safe after constraint release, body removal, or world disposal.
 */
export function hidePhysicsConstraint(viewer: PhysicsViewer, constraint: PhysicsConstraintDebug): boolean {
    const index = viewer._constraintKeys.indexOf(constraint);
    if (index < 0) {
        return false;
    }
    const group = viewer._constraintGroups[index]!;
    // Commit all bookkeeping before removing meshes so reentrant listeners see a consistent viewer.
    viewer._constraintKeys.splice(index, 1);
    viewer._constraintGroups.splice(index, 1);
    for (const mesh of group) {
        viewer._constraintMeshes.splice(viewer._constraintMeshes.indexOf(mesh), 1);
    }
    for (const entries of [viewer._constraintLines, viewer._constraintDisks, viewer._constraintArrowheads]) {
        for (let i = entries.length - 1; i >= 0; i--) {
            if (group.includes(entries[i]!.mesh)) {
                entries.splice(i, 1);
            }
        }
    }
    unregisterViewerUpdateIfEmpty(viewer);
    batchSceneChanges(viewer.scene, () => {
        for (const mesh of group) {
            removeFromScene(viewer.scene, mesh);
        }
    });
    return true;
}

function batchSceneChanges(scene: SceneContext, mutation: () => void): void {
    if (_hasSceneChangeHook()) {
        _runSceneChange(scene, mutation);
    } else {
        mutation();
    }
}

/** Shows a Havok Physics V2 body as a wireframe debug mesh. */
export function showPhysicsBody(viewer: PhysicsViewer, body: PhysicsBody): Mesh | null {
    for (let i = 0; i < viewer._bodies.length; i++) {
        if (viewer._bodies[i] === body) {
            return null;
        }
    }

    const geometry = getPhysicsBodyDebugGeometry(viewer.world, body);
    if (geometry.positions.length === 0 || geometry.indices.length === 0) {
        return null;
    }

    const lineIndices = createLineListIndices(geometry.indices);
    const normals = new Float32Array(geometry.positions.length);
    const debugMesh = createMeshFromData(viewer.scene.surface.engine, "physicsBodyDebug", geometry.positions, normals, lineIndices);
    debugMesh.material = createPhysicsDebugLineMaterial(viewer._color);
    debugMesh.pickable = false;
    debugMesh.renderOrder = 1000;
    copyBodyTransform(body, debugMesh);

    viewer._bodies.push(body);
    viewer._meshes.push(debugMesh);
    addToScene(viewer.scene, debugMesh);
    registerViewerUpdate(viewer);
    return debugMesh;
}

/** Hides a body that was previously shown with {@link showPhysicsBody}. */
export function hidePhysicsBody(viewer: PhysicsViewer, body: PhysicsBody): boolean {
    const index = viewer._bodies.indexOf(body);
    if (index < 0) {
        return false;
    }
    const mesh = viewer._meshes[index]!;
    viewer._bodies.splice(index, 1);
    viewer._meshes.splice(index, 1);
    removeFromScene(viewer.scene, mesh);
    unregisterViewerUpdateIfEmpty(viewer);
    return true;
}

/** Disposes all physics debug meshes and unregisters the viewer update hook. */
export function disposePhysicsViewer(viewer: PhysicsViewer): void {
    // Commit all bookkeeping before removing meshes so reentrant listeners see an empty viewer.
    const meshes = viewer._meshes.splice(0).concat(viewer._constraintMeshes.splice(0));
    viewer._bodies.length = 0;
    viewer._constraintLines.length = 0;
    viewer._constraintDisks.length = 0;
    viewer._constraintArrowheads.length = 0;
    viewer._constraintKeys.length = 0;
    viewer._constraintGroups.length = 0;
    unregisterViewerUpdate(viewer);
    batchSceneChanges(viewer.scene, () => {
        for (const mesh of meshes) {
            removeFromScene(viewer.scene, mesh);
        }
    });
}

function registerViewerUpdate(viewer: PhysicsViewer): void {
    if (viewer._registered) {
        return;
    }
    viewer.scene._beforeRender.push(viewer._update);
    viewer._registered = true;
}

function unregisterViewerUpdateIfEmpty(viewer: PhysicsViewer): void {
    if (viewer._bodies.length === 0 && viewer._constraintLines.length === 0 && viewer._constraintDisks.length === 0 && viewer._constraintArrowheads.length === 0) {
        unregisterViewerUpdate(viewer);
    }
}

function unregisterViewerUpdate(viewer: PhysicsViewer): void {
    if (!viewer._registered) {
        return;
    }
    const index = viewer.scene._beforeRender.indexOf(viewer._update);
    if (index >= 0) {
        viewer.scene._beforeRender.splice(index, 1);
    }
    viewer._registered = false;
}

function updatePhysicsViewer(viewer: PhysicsViewer): void {
    for (let i = 0; i < viewer._bodies.length; i++) {
        copyBodyTransform(viewer._bodies[i]!, viewer._meshes[i]!);
    }
    for (let i = 0; i < viewer._constraintLines.length; i++) {
        updateConstraintLine(viewer, viewer._constraintLines[i]!);
    }
    for (let i = 0; i < viewer._constraintDisks.length; i++) {
        updateConstraintDisk(viewer._constraintDisks[i]!);
    }
    for (let i = 0; i < viewer._constraintArrowheads.length; i++) {
        updateConstraintArrowhead(viewer._constraintArrowheads[i]!);
    }
}

function copyBodyTransform(body: PhysicsBody, mesh: Mesh): void {
    const node = body.node;
    mesh.position.set(node.position.x, node.position.y, node.position.z);
    mesh.rotationQuaternion.set(node.rotationQuaternion.x, node.rotationQuaternion.y, node.rotationQuaternion.z, node.rotationQuaternion.w);
    mesh.scaling.set(1, 1, 1);
}

function createLineListIndices(triangleIndices: Uint32Array): Uint32Array {
    const lines = new Uint32Array(triangleIndices.length * 2);
    let o = 0;
    for (let i = 0; i < triangleIndices.length; i += 3) {
        const a = triangleIndices[i]!;
        const b = triangleIndices[i + 1]!;
        const c = triangleIndices[i + 2]!;
        lines[o++] = a;
        lines[o++] = b;
        lines[o++] = b;
        lines[o++] = c;
        lines[o++] = c;
        lines[o++] = a;
    }
    return lines;
}

function createConstraintAxisMesh(viewer: PhysicsViewer, body: PhysicsBody, pivot: Vec3, axis: Vec3, len: number, color: [number, number, number, number], name: string): Mesh {
    const tip = { body, pivot, axis, axisLength: len };
    const line = createConstraintLineMesh(viewer, color, name, { body, pivot }, tip);
    const head = createConstraintArrowheadMesh(viewer, color, `${name}Head`, tip);
    viewer._constraintMeshes.push(head);
    addToScene(viewer.scene, head);
    return line;
}

function createConstraintArrowheadMesh(viewer: PhysicsViewer, color: [number, number, number, number], name: string, endpoint: ConstraintEndpoint): Mesh {
    const mesh = createCylinder(viewer.scene.surface.engine, { height: 0.13, diameterTop: 0, diameterBottom: 0.08, tessellation: 12 });
    mesh.name = name;
    const material = createStandardMaterial();
    material.disableLighting = true;
    material.emissiveColor = [color[0], color[1], color[2]];
    material.diffuseColor = [color[0], color[1], color[2]];
    mesh.material = material;
    mesh.pickable = false;
    mesh.renderOrder = 1001;
    const arrowhead = { mesh, endpoint };
    updateConstraintArrowhead(arrowhead);
    viewer._constraintArrowheads.push(arrowhead);
    return mesh;
}

function createConstraintDiskMesh(viewer: PhysicsViewer, body: PhysicsBody, pivot: Vec3, axis: Vec3, radius: number, color: [number, number, number, number], name: string): Mesh {
    const mesh = createDisc(viewer.scene.surface.engine, { radius, tessellation: 48 });
    mesh.name = name;
    const material = createStandardMaterial();
    material.disableLighting = true;
    material.emissiveColor = [color[0], color[1], color[2]];
    material.diffuseColor = [color[0], color[1], color[2]];
    mesh.material = material;
    mesh.pickable = false;
    mesh.renderOrder = 999;
    const disk = { mesh, endpoint: { body, pivot }, axis };
    updateConstraintDisk(disk);
    viewer._constraintDisks.push(disk);
    return mesh;
}

function createConstraintLineMesh(viewer: PhysicsViewer, color: [number, number, number, number], name: string, a: ConstraintEndpoint, b: ConstraintEndpoint): Mesh {
    const positions = new Float32Array(6);
    writeEndpoint(positions, 0, a);
    writeEndpoint(positions, 3, b);
    const normals = new Float32Array(positions.length);
    const indices = new Uint32Array([0, 1]);
    const mesh = createMeshFromData(viewer.scene.surface.engine, name, positions, normals, indices);
    mesh.material = createPhysicsDebugLineMaterial(color);
    mesh.pickable = false;
    mesh.renderOrder = 1000;
    viewer._constraintLines.push({ mesh, positions, a, b });
    return mesh;
}

function updateConstraintLine(viewer: PhysicsViewer, line: ConstraintLine): void {
    writeEndpoint(line.positions, 0, line.a);
    writeEndpoint(line.positions, 3, line.b);
    updateMeshPositions(viewer.scene.surface.engine, line.mesh, line.positions);
}

let rigidScratch: Float64Array | null = null;
let rigidQuat: Quat | null = null;

/** World pose of the simulated rigid frame that Havok constraint pivots/axes are expressed in.
 *  Ordinary bodies use the node position/quaternion with unit scale (as written to Havok);
 *  thin bodies use instance 0 (carrier × instance matrix) with scale stripped. JS-only, no native calls. */
function rigidMatrix(body: PhysicsBody): Float64Array {
    const m = (rigidScratch ??= new Float64Array(16));
    const node = body.node as Mesh;
    const thin = body._world._thin?.count(body) !== undefined ? node.thinInstances : null;
    if (!thin || thin.count === 0) {
        const p = node.position;
        const q = node.rotationQuaternion;
        composeMat4IntoBuffer(m, 0, p.x, p.y, p.z, q.x, q.y, q.z, q.w, 1, 1, 1);
        return m;
    }
    multiplyMat4IntoBuffer(m, 0, node.worldMatrix as unknown as Mat4Storage, 0, thin.matrices, 0);
    for (let c = 0; c < 12; c += 4) {
        const len = Math.hypot(m[c]!, m[c + 1]!, m[c + 2]!);
        if (len > 0) {
            m[c]! /= len;
            m[c + 1]! /= len;
            m[c + 2]! /= len;
        }
    }
    const det = m[0]! * (m[5]! * m[10]! - m[6]! * m[9]!) - m[4]! * (m[1]! * m[10]! - m[2]! * m[9]!) + m[8]! * (m[1]! * m[6]! - m[2]! * m[5]!);
    if (det < 0) {
        // Mirrored carriers are represented by a negated Y scale, matching thinInstanceTransform.
        m[4] = -m[4]!;
        m[5] = -m[5]!;
        m[6] = -m[6]!;
    }
    // A nonuniform carrier × rotated instance leaves a sheared basis; recover the same normalized
    // quaternion thinInstanceTransform hands to Havok and recompose with unit scale.
    const q = _quatFromRotationBasis(m[0]!, m[4]!, m[8]!, m[1]!, m[5]!, m[9]!, m[2]!, m[6]!, m[10]!, (rigidQuat ??= { x: 0, y: 0, z: 0, w: 1 }));
    const inv = 1 / Math.hypot(q.x, q.y, q.z, q.w);
    composeMat4IntoBuffer(m, 0, m[12]!, m[13]!, m[14]!, q.x * inv, q.y * inv, q.z * inv, q.w * inv, 1, 1, 1);
    return m;
}

function updateConstraintDisk(disk: ConstraintDisk): void {
    const m = rigidMatrix(disk.endpoint.body);
    const p = localToWorld(m, disk.endpoint.pivot);
    const axis = normalize(transformDirection(m, disk.axis));
    disk.mesh.position.set(p.x, p.y, p.z);
    const q = quatFromZTo(axis);
    disk.mesh.rotationQuaternion.set(q.x, q.y, q.z, q.w);
}

function updateConstraintArrowhead(arrowhead: ConstraintArrowhead): void {
    const tip = endpointWorld(arrowhead.endpoint);
    const axis = arrowhead.endpoint.axis ? normalize(transformDirection(rigidMatrix(arrowhead.endpoint.body), arrowhead.endpoint.axis)) : { x: 0, y: 1, z: 0 };
    arrowhead.mesh.position.set(tip.x, tip.y, tip.z);
    const q = quatFromYTo(axis);
    arrowhead.mesh.rotationQuaternion.set(q.x, q.y, q.z, q.w);
}

function writeEndpoint(out: Float32Array, offset: number, endpoint: ConstraintEndpoint): void {
    const p = endpointWorld(endpoint);
    out[offset] = p.x;
    out[offset + 1] = p.y;
    out[offset + 2] = p.z;
}

function endpointWorld(endpoint: ConstraintEndpoint): Vec3 {
    const pivot = endpoint.axis
        ? {
              x: endpoint.pivot.x + endpoint.axis.x * (endpoint.axisLength ?? 1),
              y: endpoint.pivot.y + endpoint.axis.y * (endpoint.axisLength ?? 1),
              z: endpoint.pivot.z + endpoint.axis.z * (endpoint.axisLength ?? 1),
          }
        : endpoint.pivot;
    return localToWorld(rigidMatrix(endpoint.body), pivot);
}

function localToWorld(m: ArrayLike<number>, p: Vec3): Vec3 {
    return {
        x: m[0]! * p.x + m[4]! * p.y + m[8]! * p.z + m[12]!,
        y: m[1]! * p.x + m[5]! * p.y + m[9]! * p.z + m[13]!,
        z: m[2]! * p.x + m[6]! * p.y + m[10]! * p.z + m[14]!,
    };
}

function transformDirection(m: ArrayLike<number>, v: Vec3): Vec3 {
    return {
        x: m[0]! * v.x + m[4]! * v.y + m[8]! * v.z,
        y: m[1]! * v.x + m[5]! * v.y + m[9]! * v.z,
        z: m[2]! * v.x + m[6]! * v.y + m[10]! * v.z,
    };
}

function quatFromZTo(axis: Vec3): { x: number; y: number; z: number; w: number } {
    const target = normalize(axis);
    if (target.z < -0.999999) {
        return { x: 1, y: 0, z: 0, w: 0 };
    }
    const x = -target.y;
    const y = target.x;
    const z = 0;
    const w = 1 + target.z;
    const inv = 1 / Math.max(1e-8, Math.hypot(x, y, z, w));
    return { x: x * inv, y: y * inv, z: z * inv, w: w * inv };
}

function quatFromYTo(axis: Vec3): { x: number; y: number; z: number; w: number } {
    const target = normalize(axis);
    if (target.y < -0.999999) {
        return { x: 0, y: 0, z: 1, w: 0 };
    }
    const x = target.z;
    const y = 0;
    const z = -target.x;
    const w = 1 + target.y;
    const inv = 1 / Math.max(1e-8, Math.hypot(x, y, z, w));
    return { x: x * inv, y: y * inv, z: z * inv, w: w * inv };
}

function cross(a: Vec3, b: Vec3): Vec3 {
    return { x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x };
}

function normalize(v: Vec3): Vec3 {
    const inv = 1 / Math.max(1e-8, Math.hypot(v.x, v.y, v.z));
    return { x: v.x * inv, y: v.y * inv, z: v.z * inv };
}

function normalTo(axis: Vec3): Vec3 {
    const ax = Math.abs(axis.x);
    const ay = Math.abs(axis.y);
    const az = Math.abs(axis.z);
    if (ax <= ay && ax <= az) {
        return normalize({ x: 0, y: -axis.z, z: axis.y });
    }
    if (ay <= ax && ay <= az) {
        return normalize({ x: -axis.z, y: 0, z: axis.x });
    }
    return normalize({ x: -axis.y, y: axis.x, z: 0 });
}

function angularDiskAxes(type: number | undefined): readonly number[] {
    switch (type) {
        case CONSTRAINT_LOCK:
        case CONSTRAINT_PRISMATIC:
            return [];
        case CONSTRAINT_HINGE:
        case CONSTRAINT_SLIDER:
            return [0];
        case CONSTRAINT_BALL_AND_SOCKET:
        case CONSTRAINT_DISTANCE:
        case CONSTRAINT_SIX_DOF:
        default:
            return [0, 1, 2];
    }
}
