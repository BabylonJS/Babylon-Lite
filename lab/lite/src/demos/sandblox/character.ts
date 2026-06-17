/**
 * Character builder — constructs a blocky figure from box and
 * cylinder primitives with correct proportions, pivot-based limb parenting, and
 * solid-color materials.
 *
 * The builder creates meshes, generates a procedural face texture,
 * wires the hierarchy, and returns a typed data structure. No per-frame behavior.
 */

import type { EngineContext, Mesh, Texture2D, TransformNode } from "babylon-lite";
import { createBox, createCylinder, createMeshFromData, createStandardMaterial, createTexture2DFromPixels, createTransformNode } from "babylon-lite";

// ── Types ────────────────────────────────────────────────────────────────────

/** All named nodes returned by the character builder. */
export interface CharacterNodes {
    readonly root: TransformNode;
    readonly torso: Mesh;
    readonly head: Mesh;
    readonly leftArmPivot: TransformNode;
    readonly rightArmPivot: TransformNode;
    readonly leftLegPivot: TransformNode;
    readonly rightLegPivot: TransformNode;
    readonly leftArm: Mesh;
    readonly rightArm: Mesh;
    readonly leftLeg: Mesh;
    readonly rightLeg: Mesh;
    /** Flat list of every mesh for easy `addToScene` iteration. */
    readonly allMeshes: readonly Mesh[];
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Parent `child` to `p` by setting the back-reference and pushing into the children array. */
function attach(child: TransformNode, p: TransformNode): void {
    child.parent = p;
    p.children.push(child);
}

// ── Beveled cylinder ─────────────────────────────────────────────────────────

/**
 * Build a cylinder with filleted (quarter-circle) top and bottom edges.
 * Produces smooth normals throughout so the cap-to-side transition looks rounded
 */
function createBeveledCylinder(
    engine: EngineContext,
    opts: { height: number; diameter: number; edges?: number; bevelRadius?: number; bevelSegments?: number; faceUvCenter?: number; faceUvScale?: number }
): Mesh {
    const tess = Math.max(3, opts.edges ?? 36);
    const halfH = opts.height / 2;
    const R = opts.diameter / 2;
    const bevelR = Math.max(0, Math.min(opts.bevelRadius ?? Math.min(R, halfH) * 0.25, Math.min(R, halfH)));
    const bevelSegs = Math.max(1, opts.bevelSegments ?? 6);
    const uvCenterU = opts.faceUvCenter ?? 0.5;
    const uvScaleU = opts.faceUvScale ?? 1;

    if (bevelR <= 1e-6) {
        return createCylinder(engine, { height: opts.height, diameter: opts.diameter, tessellation: tess });
    }

    // Profile: 2D cross-section from bottom-center to top-center.
    // Each entry is [radius, y, normalR, normalY].
    const profile: [number, number, number, number][] = [];
    const innerR = Math.max(R - bevelR, 0);

    const pushProfilePoint = (radius: number, y: number, normalR: number, normalY: number): void => {
        const prev = profile.length > 0 ? profile[profile.length - 1]! : null;
        if (prev && Math.abs(prev[0] - radius) < 1e-6 && Math.abs(prev[1] - y) < 1e-6 && Math.abs(prev[2] - normalR) < 1e-6 && Math.abs(prev[3] - normalY) < 1e-6) {
            return;
        }
        profile.push([radius, y, normalR, normalY]);
    };

    // Bottom cap center
    pushProfilePoint(0, -halfH, 0, -1);

    // Bottom bevel arc: from cap normal (down) to side normal (out).
    for (let i = 0; i <= bevelSegs; i++) {
        const angle = (Math.PI / 2) * (i / bevelSegs);
        pushProfilePoint(innerR + bevelR * Math.sin(angle), -halfH + bevelR - bevelR * Math.cos(angle), Math.sin(angle), -Math.cos(angle));
    }

    // Straight side segment (if any).
    if (halfH - bevelR > 1e-6) {
        pushProfilePoint(R, halfH - bevelR, 1, 0);
    }

    // Top bevel arc: from side normal (out) to cap normal (up).
    for (let i = 0; i <= bevelSegs; i++) {
        const angle = (Math.PI / 2) * (i / bevelSegs);
        pushProfilePoint(innerR + bevelR * Math.cos(angle), halfH - bevelR + bevelR * Math.sin(angle), Math.cos(angle), Math.sin(angle));
    }

    // Top cap center
    pushProfilePoint(0, halfH, 0, 1);

    const ringCount = profile.length;
    const vertsPerRing = tess + 1;
    const totalVerts = ringCount * vertsPerRing;
    const positions = new Float32Array(totalVerts * 3);
    const normals = new Float32Array(totalVerts * 3);
    const uvs = new Float32Array(totalVerts * 2);
    const indicesList: number[] = [];

    for (let ring = 0; ring < ringCount; ring++) {
        const [radius, y, nr, ny] = profile[ring]!;
        const v = (y + halfH) / (2 * halfH);

        for (let j = 0; j <= tess; j++) {
            // Match Babylon/Lite cylinder winding convention so front-faces point outward.
            const angle = (-2 * Math.PI * j) / tess;
            const cos = Math.cos(angle);
            const sin = Math.sin(angle);

            const idx = ring * vertsPerRing + j;
            positions[idx * 3] = cos * radius;
            positions[idx * 3 + 1] = y;
            positions[idx * 3 + 2] = sin * radius;

            // Normal: rotate the 2D profile normal around Y
            const len = Math.sqrt(nr * nr + ny * ny) || 1;
            normals[idx * 3] = (cos * nr) / len;
            normals[idx * 3 + 1] = ny / len;
            normals[idx * 3 + 2] = (sin * nr) / len;

            // Optional U-space scaling lets us tighten face projection on the head
            // without changing the face texture drawing itself.
            const baseU = j / tess;
            uvs[idx * 2] = (baseU - uvCenterU) * uvScaleU + uvCenterU;
            uvs[idx * 2 + 1] = v;
        }
    }

    // Triangulate adjacent rings
    for (let ring = 0; ring < ringCount - 1; ring++) {
        for (let j = 0; j < tess; j++) {
            const a = ring * vertsPerRing + j;
            const b = (ring + 1) * vertsPerRing + j;
            const c = ring * vertsPerRing + (j + 1);
            const d = (ring + 1) * vertsPerRing + (j + 1);
            indicesList.push(a, b, c);
            indicesList.push(d, c, b);
        }
    }

    return createMeshFromData(engine, "beveledCylinder", positions, normals, new Uint32Array(indicesList), uvs);
}

// ── Beveled box ──────────────────────────────────────────────────────────────

interface PatchVertex {
    position: [number, number, number];
    normal: [number, number, number];
    uv: [number, number];
}

function normalize3(x: number, y: number, z: number): [number, number, number] {
    const len = Math.hypot(x, y, z);
    if (len <= 1e-8) {
        return [0, 0, 0];
    }
    return [x / len, y / len, z / len];
}

/**
 * Build a rounded/beveled box from separate face patches, edge strips, and
 * corner caps so `bevelSegments = 1` produces exactly one transition strip per edge.
 */
function createBeveledBox(engine: EngineContext, opts: { width: number; height: number; depth: number; bevelRadius?: number; bevelSegments?: number }): Mesh {
    const hx = opts.width / 2;
    const hy = opts.height / 2;
    const hz = opts.depth / 2;
    const minHalf = Math.min(hx, hy, hz);
    const bevelR = Math.max(0, Math.min(opts.bevelRadius ?? minHalf * 0.32, minHalf));
    const bevelSegs = Math.max(1, opts.bevelSegments ?? 4);

    if (bevelR <= 1e-6) {
        const box = createBox(engine);
        box.scaling.set(opts.width, opts.height, opts.depth);
        return box;
    }

    const innerX = Math.max(hx - bevelR, 0);
    const innerY = Math.max(hy - bevelR, 0);
    const innerZ = Math.max(hz - bevelR, 0);

    const positions: number[] = [];
    const normals: number[] = [];
    const uvs: number[] = [];
    const indices: number[] = [];

    const oneD = (extent: number): readonly number[] => (extent > 1e-6 ? [-extent, extent] : [0]);

    const appendRectPatch = (uCount: number, vCount: number, makeVertex: (ui: number, vi: number, uT: number, vT: number) => PatchVertex): void => {
        if (uCount < 2 || vCount < 2) {
            return;
        }
        const base = positions.length / 3;
        const patchPos: number[] = [];
        const patchNorm: number[] = [];
        const patchUv: number[] = [];

        for (let vi = 0; vi < vCount; vi++) {
            const vT = vCount > 1 ? vi / (vCount - 1) : 0;
            for (let ui = 0; ui < uCount; ui++) {
                const uT = uCount > 1 ? ui / (uCount - 1) : 0;
                const vert = makeVertex(ui, vi, uT, vT);
                patchPos.push(...vert.position);
                patchNorm.push(...vert.normal);
                patchUv.push(...vert.uv);
            }
        }

        positions.push(...patchPos);
        normals.push(...patchNorm);
        uvs.push(...patchUv);

        let flip = false;
        let decided = false;
        for (let vi = 0; vi < vCount - 1 && !decided; vi++) {
            for (let ui = 0; ui < uCount - 1; ui++) {
                const a = vi * uCount + ui;
                const b = a + 1;
                const c = a + uCount;

                const ax = patchPos[a * 3]!;
                const ay = patchPos[a * 3 + 1]!;
                const az = patchPos[a * 3 + 2]!;
                const bx = patchPos[b * 3]!;
                const by = patchPos[b * 3 + 1]!;
                const bz = patchPos[b * 3 + 2]!;
                const cx = patchPos[c * 3]!;
                const cy = patchPos[c * 3 + 1]!;
                const cz = patchPos[c * 3 + 2]!;

                const abx = bx - ax;
                const aby = by - ay;
                const abz = bz - az;
                const acx = cx - ax;
                const acy = cy - ay;
                const acz = cz - az;
                const tx = aby * acz - abz * acy;
                const ty = abz * acx - abx * acz;
                const tz = abx * acy - aby * acx;
                if (Math.hypot(tx, ty, tz) <= 1e-8) {
                    continue;
                }
                const nx = patchNorm[a * 3]!;
                const ny = patchNorm[a * 3 + 1]!;
                const nz = patchNorm[a * 3 + 2]!;
                flip = tx * nx + ty * ny + tz * nz < 0;
                decided = true;
                break;
            }
        }

        for (let vi = 0; vi < vCount - 1; vi++) {
            for (let ui = 0; ui < uCount - 1; ui++) {
                const a = base + vi * uCount + ui;
                const b = a + 1;
                const c = a + uCount;
                const d = c + 1;
                if (flip) {
                    indices.push(a, c, b);
                    indices.push(b, c, d);
                } else {
                    indices.push(a, b, c);
                    indices.push(b, d, c);
                }
            }
        }
    };

    const appendTriPatch = (segments: number, makeVertex: (i: number, j: number, k: number, segments: number) => PatchVertex): void => {
        if (segments < 1) {
            return;
        }
        const base = positions.length / 3;
        const patchPos: number[] = [];
        const patchNorm: number[] = [];
        const patchUv: number[] = [];
        const map: number[][] = [];

        for (let i = 0; i <= segments; i++) {
            map[i] = [];
            for (let j = 0; j <= segments - i; j++) {
                const k = segments - i - j;
                const vert = makeVertex(i, j, k, segments);
                map[i]![j] = patchPos.length / 3;
                patchPos.push(...vert.position);
                patchNorm.push(...vert.normal);
                patchUv.push(...vert.uv);
            }
        }

        positions.push(...patchPos);
        normals.push(...patchNorm);
        uvs.push(...patchUv);

        const localTris: number[] = [];
        for (let i = 0; i < segments; i++) {
            for (let j = 0; j <= segments - 1 - i; j++) {
                const a = map[i]![j]!;
                const b = map[i + 1]![j]!;
                const c = map[i]![j + 1]!;
                localTris.push(a, b, c);
                if (j < segments - 1 - i) {
                    const d = map[i + 1]![j + 1]!;
                    localTris.push(b, d, c);
                }
            }
        }

        let flip = false;
        for (let t = 0; t < localTris.length; t += 3) {
            const a = localTris[t]!;
            const b = localTris[t + 1]!;
            const c = localTris[t + 2]!;

            const ax = patchPos[a * 3]!;
            const ay = patchPos[a * 3 + 1]!;
            const az = patchPos[a * 3 + 2]!;
            const bx = patchPos[b * 3]!;
            const by = patchPos[b * 3 + 1]!;
            const bz = patchPos[b * 3 + 2]!;
            const cx = patchPos[c * 3]!;
            const cy = patchPos[c * 3 + 1]!;
            const cz = patchPos[c * 3 + 2]!;

            const abx = bx - ax;
            const aby = by - ay;
            const abz = bz - az;
            const acx = cx - ax;
            const acy = cy - ay;
            const acz = cz - az;
            const tx = aby * acz - abz * acy;
            const ty = abz * acx - abx * acz;
            const tz = abx * acy - aby * acx;
            if (Math.hypot(tx, ty, tz) <= 1e-8) {
                continue;
            }
            const nx = patchNorm[a * 3]!;
            const ny = patchNorm[a * 3 + 1]!;
            const nz = patchNorm[a * 3 + 2]!;
            flip = tx * nx + ty * ny + tz * nz < 0;
            break;
        }

        for (let t = 0; t < localTris.length; t += 3) {
            const a = base + localTris[t]!;
            const b = base + localTris[t + 1]!;
            const c = base + localTris[t + 2]!;
            if (flip) {
                indices.push(a, c, b);
            } else {
                indices.push(a, b, c);
            }
        }
    };

    const xVals = oneD(innerX);
    const yVals = oneD(innerY);
    const zVals = oneD(innerZ);

    // Face center patches.
    for (const sz of [1, -1] as const) {
        appendRectPatch(xVals.length, yVals.length, (ui, vi) => {
            const x = xVals[ui]!;
            const y = yVals[vi]!;
            return {
                position: [x, y, sz * hz],
                normal: [0, 0, sz],
                uv: [innerX > 1e-6 ? x / (2 * innerX) + 0.5 : 0.5, innerY > 1e-6 ? y / (2 * innerY) + 0.5 : 0.5],
            };
        });
    }
    for (const sx of [1, -1] as const) {
        appendRectPatch(zVals.length, yVals.length, (ui, vi) => {
            const z = zVals[ui]!;
            const y = yVals[vi]!;
            return {
                position: [sx * hx, y, z],
                normal: [sx, 0, 0],
                uv: [innerZ > 1e-6 ? z / (2 * innerZ) + 0.5 : 0.5, innerY > 1e-6 ? y / (2 * innerY) + 0.5 : 0.5],
            };
        });
    }
    for (const sy of [1, -1] as const) {
        appendRectPatch(xVals.length, zVals.length, (ui, vi) => {
            const x = xVals[ui]!;
            const z = zVals[vi]!;
            return {
                position: [x, sy * hy, z],
                normal: [0, sy, 0],
                uv: [innerX > 1e-6 ? x / (2 * innerX) + 0.5 : 0.5, innerZ > 1e-6 ? z / (2 * innerZ) + 0.5 : 0.5],
            };
        });
    }

    // Edge strips: one strip per edge when bevelSegs = 1.
    for (const sx of [1, -1] as const) {
        for (const sz of [1, -1] as const) {
            appendRectPatch(bevelSegs + 1, yVals.length, (ui, vi) => {
                const t = ui / bevelSegs;
                const [dx, , dz] = normalize3(t, 0, 1 - t);
                const y = yVals[vi]!;
                return {
                    position: [sx * (innerX + dx * bevelR), y, sz * (innerZ + dz * bevelR)],
                    normal: [sx * dx, 0, sz * dz],
                    uv: [t, innerY > 1e-6 ? y / (2 * innerY) + 0.5 : 0.5],
                };
            });
        }
    }
    for (const sy of [1, -1] as const) {
        for (const sz of [1, -1] as const) {
            appendRectPatch(bevelSegs + 1, xVals.length, (ui, vi) => {
                const t = ui / bevelSegs;
                const [, dy, dz] = normalize3(0, t, 1 - t);
                const x = xVals[vi]!;
                return {
                    position: [x, sy * (innerY + dy * bevelR), sz * (innerZ + dz * bevelR)],
                    normal: [0, sy * dy, sz * dz],
                    uv: [t, innerX > 1e-6 ? x / (2 * innerX) + 0.5 : 0.5],
                };
            });
        }
    }
    for (const sx of [1, -1] as const) {
        for (const sy of [1, -1] as const) {
            appendRectPatch(bevelSegs + 1, zVals.length, (ui, vi) => {
                const t = ui / bevelSegs;
                const [dx, dy] = normalize3(1 - t, t, 0);
                const z = zVals[vi]!;
                return {
                    position: [sx * (innerX + dx * bevelR), sy * (innerY + dy * bevelR), z],
                    normal: [sx * dx, sy * dy, 0],
                    uv: [t, innerZ > 1e-6 ? z / (2 * innerZ) + 0.5 : 0.5],
                };
            });
        }
    }

    // Corner caps.
    for (const sx of [1, -1] as const) {
        for (const sy of [1, -1] as const) {
            for (const sz of [1, -1] as const) {
                appendTriPatch(bevelSegs, (i, j, k, segments) => {
                    const rx = i / segments;
                    const ry = j / segments;
                    const rz = k / segments;
                    const [dx, dy, dz] = normalize3(rx, ry, rz);
                    return {
                        position: [sx * (innerX + dx * bevelR), sy * (innerY + dy * bevelR), sz * (innerZ + dz * bevelR)],
                        normal: [sx * dx, sy * dy, sz * dz],
                        uv: [rx, ry],
                    };
                });
            }
        }
    }

    // Match Lite front-face winding used by built-in primitives.
    for (let i = 0; i < indices.length; i += 3) {
        const b = indices[i + 1]!;
        indices[i + 1] = indices[i + 2]!;
        indices[i + 2] = b;
    }

    return createMeshFromData(engine, "beveledBox", new Float32Array(positions), new Float32Array(normals), new Uint32Array(indices), new Float32Array(uvs));
}

// ── Materials ────────────────────────────────────────────────────────────────

type CharacterMaterial = ReturnType<typeof createStandardMaterial>;

interface CharacterMaterialSet {
    torso: CharacterMaterial;
    head: CharacterMaterial;
    skin: CharacterMaterial;
    legs: CharacterMaterial;
}

function createRetroCharacterMaterialSet(faceTexture: Texture2D): CharacterMaterialSet {
    const makeStandard = (color: readonly [number, number, number]) => {
        const mat = createStandardMaterial();
        mat.diffuseColor = [color[0], color[1], color[2]];
        mat.specularPower = 10;
        mat.specularColor = [0.04, 0.04, 0.04];
        return mat;
    };
    // Noob-yellow skin, teal shirt, charcoal pants.
    const skin = [0.96, 0.8, 0.19] as const;
    const head = makeStandard(skin);
    head.diffuseTexture = faceTexture;
    return {
        torso: makeStandard([0.68, 0.3, 0.3]),
        head,
        skin: makeStandard(skin),
        legs: makeStandard([0.24, 0.25, 0.28]),
    };
}

/** Apply an already-created character material set to all character meshes. */
function applyCharacterMaterialSet(character: CharacterNodes, set: CharacterMaterialSet): void {
    character.torso.material = set.torso;
    character.head.material = set.head;
    character.leftArm.material = set.skin;
    character.rightArm.material = set.skin;
    character.leftLeg.material = set.legs;
    character.rightLeg.material = set.legs;
}

function createClassicSmileTexture(engine: EngineContext): Texture2D {
    const canvas = document.createElement("canvas");
    canvas.width = 128;
    canvas.height = 128;

    const ctx = canvas.getContext("2d");
    if (!ctx) {
        throw new Error("Failed to create 2D context for character face texture.");
    }

    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = "#111111";

    // Face is centered at U = 0.75 because the cylinder seam starts at +X.
    const centerX = 96;

    // Eyes
    ctx.beginPath();
    ctx.ellipse(centerX - 16, 38, 5, 10, 0, 0, Math.PI * 2);
    ctx.ellipse(centerX + 16, 38, 5, 10, 0, 0, Math.PI * 2);
    ctx.fill();

    // Smile
    ctx.lineWidth = 9;
    ctx.lineCap = "round";
    ctx.strokeStyle = "#111111";
    ctx.beginPath();
    ctx.moveTo(centerX - 24, 76);
    ctx.quadraticCurveTo(centerX, 113, centerX + 24, 76);
    ctx.stroke();

    const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    for (let i = 0; i < data.length; i += 4) {
        const r = data[i]!;
        const g = data[i + 1]!;
        const b = data[i + 2]!;
        const isWhiteBackground = r > 250 && g > 250 && b > 250;
        data[i + 3] = isWhiteBackground ? 0 : 255;
    }

    // createTexture2DFromPixels expects top-to-bottom rows; match invertY=true behavior.
    const rowBytes = canvas.width * 4;
    const flipped = new Uint8Array(data.length);
    for (let y = 0; y < canvas.height; y++) {
        const src = y * rowBytes;
        const dst = (canvas.height - 1 - y) * rowBytes;
        flipped.set(data.subarray(src, src + rowBytes), dst);
    }

    return createTexture2DFromPixels(engine, flipped, canvas.width, canvas.height, {
        minFilter: "linear",
        magFilter: "linear",
    });
}

// ── Builder ──────────────────────────────────────────────────────────────────

/**
 * Build the controllable blocky character.
 *
 * The root TransformNode sits at feet level (Y = 0 when grounded). The
 * hierarchy uses local-space offsets so that animating pivot rotations
 * produces correct limb swings.
 */
export function buildCharacter(engine: EngineContext): CharacterNodes {
    const root = createTransformNode("sandblox-root");
    const blockBevel = { bevelRadius: 0.05, bevelSegments: 1 } as const;

    // ── Torso (2×2×1, centered at Y=3) ──────────────────────────────────────
    const torso = createBeveledBox(engine, { width: 2, height: 2, depth: 1, ...blockBevel });
    torso.position.set(0, 3, 0);
    attach(torso, root);

    // ── Arms ─────────────────────────────────────────────────────────────────
    const leftArmPivot = createTransformNode("leftArmPivot", -1.5, 3.8, 0);
    attach(leftArmPivot, root);
    const leftArm = createBeveledBox(engine, { width: 1, height: 2, depth: 1, ...blockBevel });
    leftArm.position.set(0, -0.8, 0);
    attach(leftArm, leftArmPivot);

    const rightArmPivot = createTransformNode("rightArmPivot", 1.5, 3.8, 0);
    attach(rightArmPivot, root);
    const rightArm = createBeveledBox(engine, { width: 1, height: 2, depth: 1, ...blockBevel });
    rightArm.position.set(0, -0.8, 0);
    attach(rightArm, rightArmPivot);

    // ── Legs ─────────────────────────────────────────────────────────────────
    const leftLegPivot = createTransformNode("leftLegPivot", -0.5, 1.8, 0);
    attach(leftLegPivot, root);
    const leftLeg = createBeveledBox(engine, { width: 1, height: 2, depth: 1, ...blockBevel });
    leftLeg.position.set(0, -0.8, 0);
    attach(leftLeg, leftLegPivot);

    const rightLegPivot = createTransformNode("rightLegPivot", 0.5, 1.8, 0);
    attach(rightLegPivot, root);
    const rightLeg = createBeveledBox(engine, { width: 1, height: 2, depth: 1, ...blockBevel });
    rightLeg.position.set(0, -0.8, 0);
    attach(rightLeg, rightLegPivot);

    // ── Head (cylinder Ø1×1, centered at Y=4.5) ─────────────────────────────
    const head = createBeveledCylinder(engine, {
        height: 1.26,
        diameter: 1.2,
        bevelRadius: 0.33,
        bevelSegments: 8,
        edges: 36,
        faceUvCenter: 0.75,
        faceUvScale: 3.5,
    });
    head.position.set(0, 4.5, 0);
    attach(head, root);

    const allMeshes = [torso, head, leftArm, rightArm, leftLeg, rightLeg] as const;
    const nodes: CharacterNodes = {
        root,
        torso,
        head,
        leftArmPivot,
        rightArmPivot,
        leftLegPivot,
        rightLegPivot,
        leftArm,
        rightArm,
        leftLeg,
        rightLeg,
        allMeshes,
    };

    const faceTexture = createClassicSmileTexture(engine);
    applyCharacterMaterialSet(nodes, createRetroCharacterMaterialSet(faceTexture));
    return nodes;
}
