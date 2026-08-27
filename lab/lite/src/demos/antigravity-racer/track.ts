/**
 * Antigravity Racer — track spline math + procedural ribbon mesh.
 *
 * Ports the playground's closed Hermite-spline track (7 editable control
 * points → 256 sampled "rings", arc-length reparametrized so ring spacing is
 * even in world distance) but keeps everything as CPU-side plain vectors
 * instead of the original's float-texture + node-material vertex shader
 * deformation (unsupported in Lite — see GUIDANCE). The final curved geometry
 * is built directly on the CPU and uploaded once; editing a control point just
 * recomputes the rings and re-uploads positions/normals in place.
 */

import type { EngineContext, Mesh, SceneContext, Vec3 } from "babylon-lite";
import {
    addVec3,
    addToScene,
    createMeshFromData,
    createStandardMaterial,
    crossVec3,
    dotVec3,
    normalizeVec3Object,
    scaleVec3,
    subVec3,
    updateMeshNormals,
    updateMeshPositions,
} from "babylon-lite";

import { BOOST_LEFT_OFFSET, BOOST_PERIOD, BOOST_RIGHT_OFFSET, DEFAULT_CONTROL_POINTS, FLOOR_HALF_WIDTH, RING_COUNT, TRACK_PROFILE } from "./constants.js";

/** A single sampled ring: world position + orthonormal (right, up, forward) basis. */
export interface TrackFrame {
    pos: Vec3;
    dir: Vec3;
    up: Vec3;
    right: Vec3;
}

function dist(a: Vec3, b: Vec3): number {
    const dx = a.x - b.x;
    const dy = a.y - b.y;
    const dz = a.z - b.z;
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/** Hermite basis matching the original PG exactly: tangents are the raw neighbour
 *  differences (not halved), and the h3/h4 coefficients carry the compensating 0.5 —
 *  algebraically identical to a standard Catmull-Rom spline. */
function hermite(p: Vec3, pm1: Vec3, pp1: Vec3, pp2: Vec3, t: number): Vec3 {
    const t2 = t * t;
    const t3 = t2 * t;
    const h1 = 2 * t3 - 3 * t2 + 1;
    const h2 = -2 * t3 + 3 * t2;
    const h3 = (t3 - 2 * t2 + t) * 0.5;
    const h4 = (t3 - t2) * 0.5;
    return {
        x: p.x * h1 + pp1.x * h2 + (pp1.x - pm1.x) * h3 + (pp2.x - p.x) * h4,
        y: p.y * h1 + pp1.y * h2 + (pp1.y - pm1.y) * h3 + (pp2.y - p.y) * h4,
        z: p.z * h1 + pp1.z * h2 + (pp1.z - pm1.z) * h3 + (pp2.z - p.z) * h4,
    };
}

/** Sample a closed Hermite loop through `points` at loop ratio `ratio` (any real, folded into [0,1)). */
function sampleLoop(points: readonly Vec3[], ratio: number): Vec3 {
    const l = points.length;
    let i = ratio + 1;
    i %= 1;
    const segF = i * l;
    const seg = Math.floor(segF);
    const t = segF % 1;
    return hermite(points[seg]!, points[(seg - 1 + l) % l]!, points[(seg + 1) % l]!, points[(seg + 2) % l]!, t);
}

/** Per-control-point "up" vector, derived from the loop's local curvature (banking),
 *  with a continuity fix so it doesn't flip sign at inflection points. */
function computeControlUps(points: readonly Vec3[]): Vec3[] {
    const l = points.length;
    const ups: Vec3[] = [];
    let prevUp: Vec3 | undefined;
    for (let i = 0; i < l; i++) {
        const p = points[i]!;
        const pp = points[(i - 1 + l) % l]!;
        const pn = points[(i + 1) % l]!;
        const prevDir = normalizeVec3Object(subVec3(p, pp));
        const nextDir = normalizeVec3Object(subVec3(pn, p));
        let up = crossVec3(nextDir, prevDir);
        if (prevUp && dotVec3(prevUp, up) < 0) {
            up = crossVec3(prevDir, nextDir);
        }
        up = normalizeVec3Object(up);
        ups.push(up);
        prevUp = up;
    }
    return ups;
}

/** Arc-length reparametrization: returns `ringCount` loop ratios spaced evenly by world distance
 *  (so tight corners don't bunch up rings vs. long straights). Ported from `computeTrackLength`. */
function computeArcLengthRatios(points: readonly Vec3[], ringCount: number): number[] {
    let prev = sampleLoop(points, 0);
    let total = 0;
    for (let i = 1; i <= ringCount; i++) {
        const next = sampleLoop(points, i / ringCount);
        total += dist(prev, next);
        prev = next;
    }
    const lengthPerRing = total / ringCount;

    const ratios: number[] = [0];
    prev = sampleLoop(points, 0);
    let currentRatio = 0;
    let localLength = 0;
    for (let i = 0; i < ringCount; i++) {
        const nextRatio = i / ringCount;
        const next = sampleLoop(points, nextRatio);
        localLength += dist(prev, next);
        const sliceCountF = localLength / lengthPerRing;
        const sliceCount = Math.floor(sliceCountF);
        for (let s = 1; s <= sliceCount; s++) {
            ratios.push(currentRatio + ((nextRatio - currentRatio) / sliceCountF) * s);
        }
        localLength -= lengthPerRing * sliceCount;
        prev = next;
        currentRatio = nextRatio;
    }
    // Guard against a short array from floating-point edge cases.
    for (let i = ratios.length; i < ringCount; i++) {
        ratios.push(i / ringCount);
    }
    return ratios;
}

/** Build the `ringCount` track frames (position + orthonormal basis) for the given control points. */
export function buildTrackFrames(points: readonly Vec3[], ringCount = RING_COUNT): TrackFrame[] {
    const ups = computeControlUps(points);
    const ratios = computeArcLengthRatios(points, ringCount);
    const frames: TrackFrame[] = [];
    let currentPos = sampleLoop(points, ratios[ringCount - 1] ?? 0);
    for (let i = 0; i < ringCount; i++) {
        const ratio = ratios[i] ?? i / ringCount;
        const nextPos = sampleLoop(points, ratio);
        const rawUp = sampleLoop(ups, ratio);
        const dir = normalizeVec3Object(subVec3(nextPos, currentPos));
        const right = normalizeVec3Object(crossVec3(dir, rawUp));
        const up = normalizeVec3Object(crossVec3(right, dir));
        frames.push({ pos: nextPos, dir, up, right });
        currentPos = nextPos;
    }
    return frames;
}

/** Local (right, up, forward) coordinates of `worldPos` relative to a ring frame. */
export function frameLocalCoords(frame: TrackFrame, worldPos: Vec3): Vec3 {
    const rel = subVec3(worldPos, frame.pos);
    return { x: dotVec3(rel, frame.right), y: dotVec3(rel, frame.up), z: dotVec3(rel, frame.dir) };
}

/** Reconstruct a world position from local (right, up, forward) coordinates at a ring frame. */
export function frameToWorld(frame: TrackFrame, local: Vec3): Vec3 {
    return addVec3(frame.pos, addVec3(scaleVec3(frame.right, local.x), addVec3(scaleVec3(frame.up, local.y), scaleVec3(frame.dir, local.z))));
}

/** Advance a ring index forward while `worldPos` has crossed the next ring's plane. Capped so a bad state can't spin forever. */
export function advanceSegment(frames: readonly TrackFrame[], seg: number, worldPos: Vec3): number {
    const n = frames.length;
    for (let guard = 0; guard < n; guard++) {
        const nextSeg = (seg + 1) % n;
        const rel = subVec3(worldPos, frames[nextSeg]!.pos);
        if (dotVec3(rel, frames[nextSeg]!.dir) > 0) {
            seg = nextSeg;
        } else {
            break;
        }
    }
    return seg;
}

function buildRibbonPositionsNormals(frames: readonly TrackFrame[]): { positions: Float32Array; normals: Float32Array; indices: Uint32Array; uvs: Float32Array } {
    const profileCount = TRACK_PROFILE.length;
    const ringCount = frames.length;
    const vertsPerRing = profileCount;
    const positions = new Float32Array(ringCount * vertsPerRing * 3);
    const uvs = new Float32Array(ringCount * vertsPerRing * 2);
    for (let i = 0; i < ringCount; i++) {
        const f = frames[i]!;
        for (let k = 0; k < profileCount; k++) {
            const prof = TRACK_PROFILE[k]!;
            const wx = f.pos.x + f.right.x * prof.x + f.up.x * prof.y;
            const wy = f.pos.y + f.right.y * prof.x + f.up.y * prof.y;
            const wz = f.pos.z + f.right.z * prof.x + f.up.z * prof.y;
            const vi = i * vertsPerRing + k;
            positions[vi * 3] = wx;
            positions[vi * 3 + 1] = wy;
            positions[vi * 3 + 2] = wz;
            uvs[vi * 2] = k / (profileCount - 1);
            uvs[vi * 2 + 1] = i / ringCount;
        }
    }
    // Quad strip across the profile, wrapped around the ring loop.
    const indices = new Uint32Array(ringCount * (profileCount - 1) * 6);
    let ii = 0;
    for (let i = 0; i < ringCount; i++) {
        const next = (i + 1) % ringCount;
        for (let k = 0; k < profileCount - 1; k++) {
            const a = i * vertsPerRing + k;
            const b = i * vertsPerRing + k + 1;
            const c = next * vertsPerRing + k;
            const d = next * vertsPerRing + k + 1;
            indices[ii++] = a;
            indices[ii++] = c;
            indices[ii++] = b;
            indices[ii++] = b;
            indices[ii++] = c;
            indices[ii++] = d;
        }
    }
    const normals = computeSmoothNormalsLocal(positions, indices);
    return { positions, normals, indices, uvs };
}

/** Simple area-weighted smooth-normal computation (avoids depending on an internal engine helper). */
function computeSmoothNormalsLocal(positions: Float32Array, indices: Uint32Array): Float32Array {
    const normals = new Float32Array(positions.length);
    for (let t = 0; t < indices.length; t += 3) {
        const ia = indices[t]! * 3;
        const ib = indices[t + 1]! * 3;
        const ic = indices[t + 2]! * 3;
        const ax = positions[ia]!,
            ay = positions[ia + 1]!,
            az = positions[ia + 2]!;
        const bx = positions[ib]!,
            by = positions[ib + 1]!,
            bz = positions[ib + 2]!;
        const cx = positions[ic]!,
            cy = positions[ic + 1]!,
            cz = positions[ic + 2]!;
        const e1x = bx - ax,
            e1y = by - ay,
            e1z = bz - az;
        const e2x = cx - ax,
            e2y = cy - ay,
            e2z = cz - az;
        const nx = e1y * e2z - e1z * e2y;
        const ny = e1z * e2x - e1x * e2z;
        const nz = e1x * e2y - e1y * e2x;
        normals[ia] = normals[ia]! + nx;
        normals[ia + 1] = normals[ia + 1]! + ny;
        normals[ia + 2] = normals[ia + 2]! + nz;
        normals[ib] = normals[ib]! + nx;
        normals[ib + 1] = normals[ib + 1]! + ny;
        normals[ib + 2] = normals[ib + 2]! + nz;
        normals[ic] = normals[ic]! + nx;
        normals[ic + 1] = normals[ic + 1]! + ny;
        normals[ic + 2] = normals[ic + 2]! + nz;
    }
    for (let v = 0; v < normals.length; v += 3) {
        const x = normals[v]!,
            y = normals[v + 1]!,
            z = normals[v + 2]!;
        const len = Math.sqrt(x * x + y * y + z * z) || 1;
        normals[v] = x / len;
        normals[v + 1] = y / len;
        normals[v + 2] = z / len;
    }
    return normals;
}

export interface BoostPad {
    readonly ring: number;
    readonly side: "left" | "right";
    mesh: Mesh;
}

/** Track data: the live geometry + everything simulation needs. `rebuild()` recomputes the rings from
 *  the current `controlPoints` and re-uploads geometry in place (topology never changes). */
export interface TrackData {
    readonly controlPoints: Vec3[];
    frames: TrackFrame[];
    readonly mesh: Mesh;
    readonly boostPads: BoostPad[];
    readonly boostRight: boolean[];
    readonly boostLeft: boolean[];
    rebuild(): void;
}

function basisToQuat(right: Vec3, up: Vec3, forward: Vec3): { x: number; y: number; z: number; w: number } {
    // Standard rotation-matrix→quaternion (columns = right, up, forward), trace method.
    const m00 = right.x,
        m10 = right.y,
        m20 = right.z;
    const m01 = up.x,
        m11 = up.y,
        m21 = up.z;
    const m02 = forward.x,
        m12 = forward.y,
        m22 = forward.z;
    const trace = m00 + m11 + m22;
    if (trace > 0) {
        const s = 0.5 / Math.sqrt(trace + 1);
        return { w: 0.25 / s, x: (m21 - m12) * s, y: (m02 - m20) * s, z: (m10 - m01) * s };
    } else if (m00 > m11 && m00 > m22) {
        const s = 2 * Math.sqrt(1 + m00 - m11 - m22);
        return { w: (m21 - m12) / s, x: 0.25 * s, y: (m01 + m10) / s, z: (m02 + m20) / s };
    } else if (m11 > m22) {
        const s = 2 * Math.sqrt(1 + m11 - m00 - m22);
        return { w: (m02 - m20) / s, x: (m01 + m10) / s, y: 0.25 * s, z: (m12 + m21) / s };
    } else {
        const s = 2 * Math.sqrt(1 + m22 - m00 - m11);
        return { w: (m10 - m01) / s, x: (m02 + m20) / s, y: (m12 + m21) / s, z: 0.25 * s };
    }
}

function positionBoostPad(pad: BoostPad, frames: readonly TrackFrame[]): void {
    const f = frames[pad.ring % frames.length]!;
    const side = pad.side === "right" ? 1 : -1;
    const localX = side * (FLOOR_HALF_WIDTH - 0.7);
    const world = frameToWorld(f, { x: localX, y: 0.02, z: 0 });
    pad.mesh.position.set(world.x, world.y, world.z);
    const q = basisToQuat(f.right, f.up, f.dir);
    pad.mesh.rotationQuaternion.set(q.x, q.y, q.z, q.w);
}

export function buildTrack(engine: EngineContext, controlPoints: readonly Vec3[] = DEFAULT_CONTROL_POINTS): TrackData {
    const points = controlPoints.map((p) => ({ x: p.x, y: p.y, z: p.z }));
    let frames = buildTrackFrames(points);
    const { positions, normals, indices, uvs } = buildRibbonPositionsNormals(frames);
    const mesh = createMeshFromData(engine, "antigrav-track", positions, normals, indices, uvs);
    const material = createStandardMaterial();
    material.diffuseColor = [0.16, 0.19, 0.32];
    material.emissiveColor = [0.05, 0.09, 0.16];
    material.specularColor = [0.25, 0.3, 0.4];
    material.backFaceCulling = false;
    mesh.material = material;

    const boostRight: boolean[] = new Array(RING_COUNT).fill(false);
    const boostLeft: boolean[] = new Array(RING_COUNT).fill(false);
    for (let i = 0; i < RING_COUNT; i++) {
        boostRight[i] = i % BOOST_PERIOD === BOOST_RIGHT_OFFSET;
        boostLeft[i] = i % BOOST_PERIOD === BOOST_LEFT_OFFSET;
    }

    const track: TrackData = {
        controlPoints: points,
        frames,
        mesh,
        boostPads: [],
        boostRight,
        boostLeft,
        rebuild(): void {
            frames = buildTrackFrames(track.controlPoints);
            track.frames = frames;
            const rebuilt = buildRibbonPositionsNormals(frames);
            updateMeshPositions(engine, mesh, rebuilt.positions);
            updateMeshNormals(engine, mesh, rebuilt.normals);
            for (const pad of track.boostPads) {
                positionBoostPad(pad, frames);
            }
        },
    };
    return track;
}

function makeBoostPad(engine: EngineContext, ring: number, side: "left" | "right"): BoostPad {
    const mesh = createMeshFromData(
        engine,
        `boost-${side}-${ring}`,
        new Float32Array([-0.7, 0, -1, 0.7, 0, -1, 0.7, 0, 1, -0.7, 0, 1]),
        new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0]),
        new Uint32Array([0, 1, 2, 0, 2, 3]),
        new Float32Array([0, 0, 1, 0, 1, 1, 0, 1])
    );
    const material = createStandardMaterial();
    material.diffuseColor = side === "right" ? [0.1, 0.6, 0.9] : [0.95, 0.55, 0.1];
    material.emissiveColor = side === "right" ? [0.1, 0.55, 0.85] : [0.85, 0.45, 0.05];
    material.disableLighting = true;
    material.backFaceCulling = false;
    mesh.material = material;
    return { ring, side, mesh };
}

/** Create + place the boost pad decal meshes for a built track. */
export function createBoostPads(engine: EngineContext, track: TrackData): BoostPad[] {
    const pads: BoostPad[] = [];
    for (let i = 0; i < RING_COUNT; i++) {
        if (track.boostRight[i]) {
            pads.push(makeBoostPad(engine, i, "right"));
        }
        if (track.boostLeft[i]) {
            pads.push(makeBoostPad(engine, i, "left"));
        }
    }
    for (const pad of pads) {
        positionBoostPad(pad, track.frames);
    }
    track.boostPads.push(...pads);
    return pads;
}

/** Add the track mesh and its boost pads to a scene. */
export function addTrackToScene(scene: SceneContext, track: TrackData): void {
    addToScene(scene, track.mesh);
    for (const pad of track.boostPads) {
        addToScene(scene, pad.mesh);
    }
}
