/**
 * Antigravity Racer — track spline math + the procedural track piece.
 *
 * A faithful port of the source playground's track pipeline:
 *
 *  1. Seven control points define a closed Hermite/Catmull-Rom loop.
 *  2. `computeTrackLength` walks the loop twice to build 256 arc-length-even
 *     sample ratios (`trackRatios`).
 *  3. `createTrackTexture` turns those into 256 orthonormal segment matrices —
 *     each one's origin is the PREVIOUS sample and its forward axis points at
 *     the current one — plus the per-row track-info channels.
 *  4. The mesh itself is the same undeformed extrusion the PG merges: one
 *     20-point cross-section duplicated at z = i and z = i + 1 for each of the
 *     256 segments (10,240 vertices / 15,360 indices / 5,120 triangles), with no
 *     UV buffer — the undeformed X/Z drive the fragment shading.
 *  5. The GPU bends that straight extrusion onto the spline (see
 *     `track-material.ts`), so editing a control point only re-uploads 256
 *     matrices instead of touching a single vertex.
 *
 * The spline itself (control points + frames) is the demo's ONE source of truth
 * ({@link TrackData}), and it is deliberately separate from the GPU-side piece
 * ({@link TrackRender}). Split-screen needs one renderer per pane — each pane's
 * material samples ITS OWN cascade array — but both must bend to the same road,
 * so every renderer subscribes to the source and re-uploads the shared frames
 * whenever the editor moves a control point.
 */

import type { EngineContext, Mesh, SceneContext, ShadowGenerator, Vec3 } from "babylon-lite";
import { addVec3, addToScene, createMeshFromData, crossVec3, dotVec3, normalizeVec3Object, scaleVec3, subVec3 } from "babylon-lite";

import {
    BOOST_LEFT_OFFSET,
    BOOST_PERIOD,
    BOOST_RIGHT_OFFSET,
    DEFAULT_CONTROL_POINTS,
    HUGE_BOUND_MAX,
    HUGE_BOUND_MIN,
    RING_COUNT,
    TRACK_CROSS_NORMALS,
    TRACK_CROSS_SECTION,
} from "./constants.js";
import { createTrackMaterial, FLOATS_PER_FRAME, type TrackMaterial, type TrackTextures } from "./track-material.js";

/** A single sampled segment: world origin + orthonormal (right, up, forward) basis. */
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

/** Sample a closed Hermite loop through `points` at loop ratio `ratio` (any real, folded into [0,1)).
 *  Mirrors the PG's `GetDescToRef`, including its `i += 1; i %= 1` fold. */
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
 *  with the PG's continuity fix so it doesn't flip sign at inflection points. */
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

/** Total loop length plus the `ringCount` arc-length-even sample ratios, reproducing the
 *  PG's two-pass `computeTrackLength` (including its 256-chord approximation and its
 *  "emit `floor(localLength / lengthPerRow)` ratios per chord" quirk). */
export function computeTrackRatios(points: readonly Vec3[], ringCount = RING_COUNT): { length: number; lengthPerRow: number; ratios: number[] } {
    let prev = sampleLoop(points, 0);
    let total = 0;
    for (let i = 1; i <= ringCount; i++) {
        const next = sampleLoop(points, i / ringCount);
        total += dist(prev, next);
        prev = next;
    }
    const lengthPerRow = total / ringCount;

    const ratios: number[] = [0];
    prev = sampleLoop(points, 0);
    let currentRatio = 0;
    let localLength = 0;
    for (let i = 0; i < ringCount; i++) {
        const nextRatio = i / ringCount;
        const next = sampleLoop(points, nextRatio);
        localLength += dist(prev, next);
        const sliceCountF = localLength / lengthPerRow;
        const sliceCount = Math.floor(sliceCountF);
        for (let s = 1; s <= sliceCount; s++) {
            ratios.push(currentRatio + ((nextRatio - currentRatio) / sliceCountF) * s);
        }
        localLength -= lengthPerRow * sliceCount;
        prev = next;
        currentRatio = nextRatio;
    }
    // Guard against a short array from floating-point edge cases (the PG would read `undefined`).
    for (let i = ratios.length; i < ringCount; i++) {
        ratios.push(i / ringCount);
    }
    return { length: total, lengthPerRow, ratios };
}

/** Build the `ringCount` segment frames for the given control points, plus the per-row
 *  dot(prevDir, dir) curvature ratios the track-info channel is derived from.
 *  Mirrors the PG's `createTrackTexture`: frame `i`'s ORIGIN is the sample at
 *  `ratios[i - 1]` and its forward axis points at the sample at `ratios[i]`. */
export function buildTrackFrames(points: readonly Vec3[], ringCount = RING_COUNT): { frames: TrackFrame[]; curveRatios: number[] } {
    const ups = computeControlUps(points);
    const { ratios } = computeTrackRatios(points, ringCount);
    const frames: TrackFrame[] = [];
    const curveRatios: number[] = [];
    let currentPos = sampleLoop(points, ratios[ringCount - 1] ?? 0);
    let currentDir: Vec3 = { x: 0, y: 0, z: 1 };
    for (let i = 0; i < ringCount; i++) {
        const ratio = ratios[i] ?? i / ringCount;
        const nextPos = sampleLoop(points, ratio);
        const rawUp = sampleLoop(ups, ratio);
        const dir = normalizeVec3Object(subVec3(nextPos, currentPos));
        const right = normalizeVec3Object(crossVec3(dir, rawUp));
        const up = normalizeVec3Object(crossVec3(right, dir));
        curveRatios.push(dotVec3(currentDir, dir));
        frames.push({ pos: currentPos, dir, up, right });
        currentPos = nextPos;
        currentDir = dir;
    }
    return { frames, curveRatios };
}

/** Local (right, up, forward) coordinates of `worldPos` relative to a segment frame. */
export function frameLocalCoords(frame: TrackFrame, worldPos: Vec3): Vec3 {
    const rel = subVec3(worldPos, frame.pos);
    return { x: dotVec3(rel, frame.right), y: dotVec3(rel, frame.up), z: dotVec3(rel, frame.dir) };
}

/** Local (right, up, forward) coordinates of `worldPos` relative to a segment frame, writing into `out`. */
export function frameLocalCoordsToRef(frame: TrackFrame, worldPos: Vec3, out: Vec3): Vec3 {
    const rx = worldPos.x - frame.pos.x;
    const ry = worldPos.y - frame.pos.y;
    const rz = worldPos.z - frame.pos.z;
    out.x = rx * frame.right.x + ry * frame.right.y + rz * frame.right.z;
    out.y = rx * frame.up.x + ry * frame.up.y + rz * frame.up.z;
    out.z = rx * frame.dir.x + ry * frame.dir.y + rz * frame.dir.z;
    return out;
}

/** Reconstruct a world position from local (right, up, forward) coordinates at a segment frame. */
export function frameToWorld(frame: TrackFrame, local: Vec3): Vec3 {
    return addVec3(frame.pos, addVec3(scaleVec3(frame.right, local.x), addVec3(scaleVec3(frame.up, local.y), scaleVec3(frame.dir, local.z))));
}

/** Reconstruct a world position from local coordinates at a segment frame, writing into `out`. */
export function frameToWorldToRef(frame: TrackFrame, local: Vec3, out: Vec3): Vec3 {
    out.x = frame.pos.x + frame.right.x * local.x + frame.up.x * local.y + frame.dir.x * local.z;
    out.y = frame.pos.y + frame.right.y * local.x + frame.up.y * local.y + frame.dir.y * local.z;
    out.z = frame.pos.z + frame.right.z * local.x + frame.up.z * local.y + frame.dir.z * local.z;
    return out;
}

/** Advance a segment index forward while `worldPos` has crossed the next segment's plane.
 *  Capped so a bad state can't spin forever. */
export function advanceSegment(frames: readonly TrackFrame[], seg: number, worldPos: Vec3): number {
    const n = frames.length;
    for (let guard = 0; guard < n; guard++) {
        const nextSeg = (seg + 1) % n;
        const nf = frames[nextSeg]!;
        // Inline sub + dot to avoid allocating a temporary Vec3.
        const rx = worldPos.x - nf.pos.x;
        const ry = worldPos.y - nf.pos.y;
        const rz = worldPos.z - nf.pos.z;
        if (rx * nf.dir.x + ry * nf.dir.y + rz * nf.dir.z > 0) {
            seg = nextSeg;
        } else {
            break;
        }
    }
    return seg;
}

/**
 * The undeformed track piece: the 20-point cross-section duplicated at z = i and
 * z = i + 1 for each of the `RING_COUNT` segments. Exactly the geometry the PG
 * merges from 256 clones of one 40-vertex piece — 10,240 vertices, 15,360
 * indices, 5,120 triangles, and no UV buffer.
 */
export function buildTrackPiece(): { positions: Float32Array; normals: Float32Array; indices: Uint32Array } {
    const cross = TRACK_CROSS_SECTION.length; // 20
    const perSegment = cross * 2; // 40
    const positions = new Float32Array(RING_COUNT * perSegment * 3);
    const normals = new Float32Array(RING_COUNT * perSegment * 3);
    for (let seg = 0; seg < RING_COUNT; seg++) {
        const base = seg * perSegment;
        for (let row = 0; row < 2; row++) {
            for (let k = 0; k < cross; k++) {
                const v = (base + row * cross + k) * 3;
                const xy = TRACK_CROSS_SECTION[k]!;
                const n = TRACK_CROSS_NORMALS[k]!;
                positions[v] = xy[0];
                positions[v + 1] = xy[1];
                positions[v + 2] = seg + row;
                normals[v] = n[0];
                normals[v + 1] = n[1];
                normals[v + 2] = n[2];
            }
        }
    }

    // Per segment: the PG's `for (index = 0; index < cnt - 1; index += 2)` strip,
    // i.e. 10 quads (60 indices) linking row 0 to row 1.
    const indices = new Uint32Array(RING_COUNT * 60);
    let ii = 0;
    for (let seg = 0; seg < RING_COUNT; seg++) {
        const base = seg * perSegment;
        for (let index = 0; index < cross - 1; index += 2) {
            indices[ii++] = base + index;
            indices[ii++] = base + index + 1;
            indices[ii++] = base + index + cross;
            indices[ii++] = base + index + 1;
            indices[ii++] = base + index + 1 + cross;
            indices[ii++] = base + index + cross;
        }
    }
    return { positions, normals, indices };
}

/** The demo's single spline source of truth: the editable control points, the frames derived from
 *  them, and the boost rows the simulation tests. Holds NO GPU resource — the per-scene renderers
 *  ({@link TrackRender}) subscribe to it and re-upload their own buffers when it changes. */
export interface TrackData {
    readonly controlPoints: Vec3[];
    frames: TrackFrame[];
    /** Per-row `dot(prevDir, dir)`, the curvature the track-info channel is derived from. */
    curveRatios: number[];
    readonly boostRight: boolean[];
    readonly boostLeft: boolean[];
    /** Recompute the frames from the current `controlPoints` and refresh every subscribed renderer. */
    rebuild(): void;
    /** Subscribe a renderer to the frames. Invoked immediately with the current ones, then on every
     *  {@link TrackData.rebuild}. Returns an unsubscribe function. */
    onRebuild(cb: (frames: readonly TrackFrame[], curveRatios: readonly number[]) => void): () => void;
}

/** The GPU-side track for ONE scene: the undeformed piece plus the material pair that bends it.
 *  Split-screen builds one per pane, because a pane's receiver material is bound to that pane's
 *  cascade array. */
export interface TrackRender {
    readonly mesh: Mesh;
    readonly material: TrackMaterial;
    /** Release this pane's frame/info/receiver buffers and unsubscribe from the spline source.
     *  The demo never calls it — a world lives as long as the page (see `world.ts`) — but the
     *  renderer owns those resources, so it owns their release. */
    dispose(): void;
}

/** Fill the material's frame + info buffers from `frames`, using the original's column layout. */
function writeFrameBuffers(material: TrackMaterial, frames: readonly TrackFrame[], curveRatios: readonly number[]): void {
    const f = material.frameData;
    const info = material.infoData;
    for (let i = 0; i < frames.length; i++) {
        const { pos, dir, up, right } = frames[i]!;
        const o = i * FLOATS_PER_FRAME;
        // c0 / c1 / c2 are the segment matrix's rows (m0,m4,m8), (m1,m5,m9), (m2,m6,m10).
        f[o] = right.x;
        f[o + 1] = up.x;
        f[o + 2] = dir.x;
        f[o + 3] = 0;
        f[o + 4] = right.y;
        f[o + 5] = up.y;
        f[o + 6] = dir.y;
        f[o + 7] = 0;
        f[o + 8] = right.z;
        f[o + 9] = up.z;
        f[o + 10] = dir.z;
        f[o + 11] = 0;
        f[o + 12] = pos.x;
        f[o + 13] = pos.y;
        f[o + 14] = pos.z;
        f[o + 15] = 1;

        const io = i * 4;
        // R = tight-curve flag (blends the road sheet to the hazard-striped one),
        // G = +x boost lane, B = -x boost lane. The fragment shader stamps the
        // chevron on exactly those channels/sides, and `touchBoost` in
        // simulation.ts tests the same rows via `boostRight` / `boostLeft`, so the
        // arrow is always drawn on the pad that actually boosts.
        info[io] = (curveRatios[i] ?? 1) > 0.9996 ? 0 : 1;
        info[io + 1] = i % BOOST_PERIOD === BOOST_RIGHT_OFFSET ? 1 : 0;
        info[io + 2] = i % BOOST_PERIOD === BOOST_LEFT_OFFSET ? 1 : 0;
        info[io + 3] = 0;
    }
}

/** Create the spline source. Built once per session: the editor mutates its control points in
 *  place and every renderer follows, so an edited track survives mode switches exactly like the
 *  playground's single global track does. */
export function createTrackSource(controlPoints: readonly Vec3[] = DEFAULT_CONTROL_POINTS): TrackData {
    const points = controlPoints.map((p) => ({ x: p.x, y: p.y, z: p.z }));
    const { frames, curveRatios } = buildTrackFrames(points);

    const boostRight: boolean[] = new Array(RING_COUNT).fill(false);
    const boostLeft: boolean[] = new Array(RING_COUNT).fill(false);
    for (let i = 0; i < RING_COUNT; i++) {
        boostRight[i] = i % BOOST_PERIOD === BOOST_RIGHT_OFFSET;
        boostLeft[i] = i % BOOST_PERIOD === BOOST_LEFT_OFFSET;
    }

    const subscribers: ((frames: readonly TrackFrame[], curveRatios: readonly number[]) => void)[] = [];
    const track: TrackData = {
        controlPoints: points,
        frames,
        curveRatios,
        boostRight,
        boostLeft,
        rebuild(): void {
            const next = buildTrackFrames(track.controlPoints);
            track.frames = next.frames;
            track.curveRatios = next.curveRatios;
            for (const cb of subscribers) {
                cb(next.frames, next.curveRatios);
            }
        },
        onRebuild(cb): () => void {
            subscribers.push(cb);
            cb(track.frames, track.curveRatios);
            return () => {
                const i = subscribers.indexOf(cb);
                if (i >= 0) {
                    subscribers.splice(i, 1);
                }
            };
        },
    };
    return track;
}

/** Build one scene's track piece: the undeformed mesh plus the deformation material pair wired to
 *  `shadowGenerator`'s cascades. The mesh geometry never changes — a control-point edit only
 *  re-uploads this renderer's 256 frames (visible + caster share one buffer). */
export function buildTrackRender(engine: EngineContext, textures: TrackTextures, shadowGenerator: ShadowGenerator, track: TrackData): TrackRender {
    const { positions, normals, indices } = buildTrackPiece();
    const mesh = createMeshFromData(engine, "antigrav-track", positions, normals, indices);
    // The vertices live at the origin and are placed by the vertex shader, so the geometric
    // bounds are meaningless for culling — publish the PG's explicit huge box instead.
    mesh.boundMin = HUGE_BOUND_MIN;
    mesh.boundMax = HUGE_BOUND_MAX;
    mesh.receiveShadows = true;

    const trackMaterial = createTrackMaterial(engine, textures, shadowGenerator);
    mesh.material = trackMaterial.material;

    // Seeds the buffers now and re-uploads them on every editor edit — same buffers, same bind
    // group, so dragging a control point causes no resource churn in any pane.
    const unsubscribe = track.onRebuild((frames, curveRatios) => {
        writeFrameBuffers(trackMaterial, frames, curveRatios);
        trackMaterial.upload();
    });

    return {
        mesh,
        material: trackMaterial,
        dispose(): void {
            unsubscribe();
            trackMaterial.dispose();
        },
    };
}

/** Add a scene's track piece to that scene. */
export function addTrackToScene(scene: SceneContext, render: TrackRender): void {
    addToScene(scene, render.mesh);
}
