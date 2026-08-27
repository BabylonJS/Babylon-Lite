/**
 * Antigravity Racer — procedural hover-ship visual.
 *
 * No external assets: a small hierarchy of primitives (tapered hull, delta
 * wings, cockpit dome, engine glow) parented under two transform nodes that
 * mirror the original's `ShipMesh` (world placement) → `ShipTransform` (local
 * banking/wobble) split, so {@link tickShip} can drive them exactly like the
 * source PG did.
 *
 * Every child uses `setParent` (not a raw `.parent =` assignment) — that's
 * what keeps the parent's `children` array in sync, which is what `addToScene`
 * walks to discover a hierarchy's meshes. A raw `.parent =` only updates the
 * internal world-matrix link, not scene-graph traversal.
 */

import type { Color3, EngineContext, Mesh, TransformNode } from "babylon-lite";
import { createBox, createCylinder, createSphere, createStandardMaterial, createTransformNode, setParent } from "babylon-lite";

export interface ShipVisual {
    /** World placement — position + orientation quaternion driven by the simulation. */
    readonly root: TransformNode;
    /** Local banking/wobble, child of `root`. */
    readonly tilt: TransformNode;
    readonly meshes: readonly Mesh[];
    readonly hullMaterialColor: Color3;
}

/** Build one procedural hover-ship. `hue` (0..1) tints the hull/wings/cockpit glass for
 *  quick visual identification (player vs. each AI). */
export function createShipVisual(engine: EngineContext, hue: number, isPlayer: boolean): ShipVisual {
    const root = createTransformNode("ship-root");
    const tilt = createTransformNode("ship-tilt");
    setParent(tilt, root);

    const hullColor = hslToRgb(hue, 0.55, isPlayer ? 0.5 : 0.42);
    const hullMat = createStandardMaterial();
    hullMat.diffuseColor = hullColor;
    hullMat.specularColor = [0.6, 0.65, 0.7];
    hullMat.specularPower = 48;

    const glassMat = createStandardMaterial();
    glassMat.diffuseColor = [0.05, 0.08, 0.1];
    glassMat.emissiveColor = hslToRgb(hue, 0.8, 0.35);
    glassMat.specularColor = [0.9, 0.9, 0.9];

    const engineMat = createStandardMaterial();
    engineMat.diffuseColor = [0, 0, 0];
    engineMat.emissiveColor = isPlayer ? [0.3, 0.75, 1] : [1, 0.55, 0.2];
    engineMat.disableLighting = true;

    const meshes: Mesh[] = [];

    // Hull: tapered hexagonal cylinder, nose (small end) toward local +Y, then pitched
    // so +Y (nose) faces local +Z (forward).
    const hull = createCylinder(engine, { height: 2.6, diameterTop: 0.4, diameterBottom: 0.95, tessellation: 6 });
    hull.material = hullMat;
    hull.rotation.x = Math.PI / 2;
    setParent(hull, tilt);
    meshes.push(hull);

    // Cockpit dome, pushed toward the nose.
    const cockpit = createSphere(engine, { diameter: 0.55, segments: 8 });
    cockpit.material = glassMat;
    cockpit.position.set(0, 0.18, 0.55);
    cockpit.scaling.set(0.85, 0.55, 1.1);
    setParent(cockpit, tilt);
    meshes.push(cockpit);

    // Delta wings — thin boxes swept back and slightly down, mirrored left/right.
    for (const side of [-1, 1] as const) {
        const wing = createBox(engine, { width: 1.5, height: 0.06, depth: 0.9 });
        wing.material = hullMat;
        wing.position.set(side * 0.85, -0.05, -0.35);
        wing.rotation.z = side * 0.18;
        wing.rotation.y = side * -0.25;
        setParent(wing, tilt);
        meshes.push(wing);
    }

    // Engine glow at the tail.
    const engine1 = createBox(engine, { width: 0.5, height: 0.5, depth: 0.08 });
    engine1.material = engineMat;
    engine1.position.set(0, 0, -1.3);
    setParent(engine1, tilt);
    meshes.push(engine1);

    return { root, tilt, meshes, hullMaterialColor: hullMat.diffuseColor as unknown as Color3 };
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
    const a = s * Math.min(l, 1 - l);
    const f = (n: number): number => {
        const k = (n + h * 12) % 12;
        return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    };
    return [f(0), f(8), f(4)];
}
