/** Light gizmo — Lite port of BJS LightGizmo.
 *
 *  Display-only gizmo that renders a light-shaped widget at the attached
 *  light's position (point / spot) and/or oriented along its direction
 *  (directional / hemispheric / spot).  The per-light-type meshes are ported
 *  as closely as possible from BJS `LightGizmo`:
 *    • PointLight       → sphere + 5-level "light lines" star
 *    • HemisphericLight → hemisphere dome + 3-level lines
 *    • SpotLight        → sphere + wide hemisphere + 2-level lines
 *    • DirectionalLight → sphere + 3 parallel arrows
 *
 *  The line geometry mirrors BJS `_CreateLightLines(levels)` — a cylinder
 *  "ray" (height 2, diameterTop 0.2, diameterBottom 0.3, tessellation 6)
 *  cloned and rotated around a pivot at increasing levels of detail. */

import type { EngineContext } from "../engine/engine.js";
import type { LightBase } from "../light/types.js";
import type { Mesh } from "../mesh/mesh.js";
import type { SceneNode } from "../scene/scene-node.js";
import type { SceneContext } from "../scene/scene-core.js";
import { addToScene, onBeforeRender } from "../scene/scene-core.js";
import { removeFromScene } from "../scene/scene-remove.js";
import { createCylinder, createSphere, createMeshFromData } from "../mesh/mesh-factories.js";
import { createTransformNode } from "../scene/transform-node.js";
import { createStandardMaterial } from "../material/standard/create-standard-material.js";
import type { StandardMaterialProps } from "../material/standard/standard-material.js";
import { directionToQuat, quatFromBjsEuler, rotateVec3ByQuat } from "./gizmo-math.js";
import type { UtilityLayer } from "./utility-layer.js";

/** BJS `LightGizmo._Scale`.  Combined with per-frame distance scaling this
 *  keeps the widget at a roughly constant on-screen size. */
const LIGHT_GIZMO_SCALE = 0.007;

/** Options for the display-only light gizmo. */
export interface LightGizmoOptions {
    /** RGB color for the light gizmo body material.  Defaults to grey. */
    color?: [number, number, number];
}

/** Display-only gizmo that visualizes an attached light using type-specific geometry. */
export interface LightGizmo {
    /** Root node — follows the attached light's position (when it has one)
     *  and orients along its direction (when it has one). */
    readonly root: SceneNode;
    readonly material: StandardMaterialProps;
    /** Currently attached light — set via `attachLightGizmoToLight`. */
    attachedLight: LightBase | null;
    /** @internal */
    _meshes: SceneNode[];
    /** @internal — builds the per-type geometry the first time a light of a
     *  given type is attached. */
    _build: (light: LightBase) => void;
    /** @internal */
    _builtType: string | null;
    /** @internal */
    _disposeFollow: () => void;
}

// ─── Geometry helpers ────────────────────────────────────────────────

/** Build a hemisphere dome (BJS `CreateHemisphere`): a half UV-sphere from the
 *  apex (+Y) down to the equator, plus a disc cap closing the base. */
function buildHemisphereMesh(engine: EngineContext, segments: number, diameter: number): Mesh {
    const r = diameter / 2;
    const rings = Math.max(3, segments);
    const radial = rings * 2;
    const positions: number[] = [];
    const normals: number[] = [];
    const uvs: number[] = [];
    const indices: number[] = [];

    // Dome — angleZ sweeps 0 (apex) → PI/2 (equator).
    for (let i = 0; i <= rings; i++) {
        const az = (i / rings) * (Math.PI / 2);
        const sinz = Math.sin(az),
            cosz = Math.cos(az);
        for (let j = 0; j <= radial; j++) {
            const ay = (j / radial) * Math.PI * 2;
            const nx = sinz * Math.cos(ay);
            const ny = cosz;
            const nz = -sinz * Math.sin(ay);
            positions.push(r * nx, r * ny, r * nz);
            normals.push(nx, ny, nz);
            uvs.push(j / radial, i / rings);
        }
    }
    const stride = radial + 1;
    for (let i = 0; i < rings; i++) {
        for (let j = 0; j < radial; j++) {
            const a = i * stride + j;
            const b = a + stride;
            indices.push(a, a + 1, b, b, a + 1, b + 1);
        }
    }

    // Base cap at the equator (y=0) facing −Y.
    const centerIdx = positions.length / 3;
    positions.push(0, 0, 0);
    normals.push(0, -1, 0);
    uvs.push(0.5, 0.5);
    const capStart = positions.length / 3;
    for (let j = 0; j <= radial; j++) {
        const ay = (j / radial) * Math.PI * 2;
        positions.push(r * Math.cos(ay), 0, -r * Math.sin(ay));
        normals.push(0, -1, 0);
        uvs.push(j / radial, 0);
    }
    for (let j = 0; j < radial; j++) {
        indices.push(centerIdx, capStart + j + 1, capStart + j);
    }

    return createMeshFromData(engine, "hemisphere", new Float32Array(positions), new Float32Array(normals), new Uint32Array(indices), new Float32Array(uvs));
}

interface LineDef {
    pivotY: number;
    pivotZ: number;
    posY: number;
    sx: number;
    sy: number;
    sz: number;
}

/** Replicate BJS `_CreateLightLines(levels)` as a flat list of cylinder
 *  transforms.  Each "line" is a cylinder parented under a pivot that only
 *  rotates (no translation); the cylinder sits at local (0, posY, 0) and is
 *  scaled by (sx,sy,sz).  The whole structure is wrapped by a lines-root that
 *  is rotated +90° about X (BJS `root.rotation.x = Math.PI/2`). */
function lineDefsForLevel(levels: number): LineDef[] {
    const distFromSphere = 1.2;
    const fullPosY = 1 * 0.5 + distFromSphere; // 1.7
    const halfPosY = 0.5 * 0.5 + distFromSphere; // 1.45
    const defs: LineDef[] = [];
    // Base line (always present for levels ≥ 2).
    defs.push({ pivotY: 0, pivotZ: 0, posY: fullPosY, sx: 1, sy: 1, sz: 1 });
    // Level 2 — 4 angled half-length rays.
    for (let i = 0; i < 4; i++) {
        defs.push({ pivotY: Math.PI / 2 + (Math.PI / 2) * i, pivotZ: Math.PI / 4, posY: halfPosY, sx: 0.8, sy: 0.5, sz: 0.8 });
    }
    if (levels < 3) {
        return defs;
    }
    // Level 3 — 4 equatorial full-length rays.
    for (let i = 0; i < 4; i++) {
        defs.push({ pivotY: (Math.PI / 2) * i, pivotZ: Math.PI / 2, posY: fullPosY, sx: 1, sy: 1, sz: 1 });
    }
    if (levels < 4) {
        return defs;
    }
    // Level 4 — 4 lower angled half-length rays.
    for (let i = 0; i < 4; i++) {
        defs.push({ pivotY: Math.PI / 2 + (Math.PI / 2) * i, pivotZ: Math.PI + Math.PI / 4, posY: halfPosY, sx: 0.8, sy: 0.5, sz: 0.8 });
    }
    if (levels < 5) {
        return defs;
    }
    // Level 5 — single downward ray.
    defs.push({ pivotY: 0, pivotZ: Math.PI, posY: fullPosY, sx: 1, sy: 1, sz: 1 });
    return defs;
}

/** Build the lines-root (rotated +90° about X) with all rays for `levels`,
 *  parented to `parent`.  Returns every created node for disposal tracking. */
function buildLightLines(engine: EngineContext, scene: SceneContext, material: StandardMaterialProps, parent: SceneNode, levels: number): SceneNode[] {
    const created: SceneNode[] = [];
    const rootQ = quatFromBjsEuler(Math.PI / 2, 0, 0);
    const linesRoot = createTransformNode("lightLinesRoot", 0, 0, 0, rootQ[0], rootQ[1], rootQ[2], rootQ[3]);
    linesRoot.parent = parent;
    created.push(linesRoot as unknown as SceneNode);

    for (const def of lineDefsForLevel(levels)) {
        const q = quatFromBjsEuler(0, def.pivotY, def.pivotZ);
        const [px, py, pz] = rotateVec3ByQuat(q[0], q[1], q[2], q[3], 0, def.posY, 0);
        const line = createCylinder(engine, { height: 2, diameterTop: 0.2, diameterBottom: 0.3, tessellation: 6 });
        line.name = "lightLine";
        line.material = material;
        line.pickable = false;
        line.rotationQuaternion.set(q[0], q[1], q[2], q[3]);
        line.position.set(px, py, pz);
        line.scaling.set(def.sx, def.sy, def.sz);
        line.parent = linesRoot as unknown as SceneNode;
        addToScene(scene, line);
        created.push(line);
    }
    return created;
}

/** Build the per-light-type geometry under `parent`.  All transforms mirror
 *  the corresponding BJS `_Create*LightMesh` (minus the uniform 0.007 scale,
 *  which is folded into the gizmo root's distance scaling). */
function buildLightTypeMesh(engine: EngineContext, scene: SceneContext, material: StandardMaterialProps, parent: SceneNode, lightType: string): SceneNode[] {
    const created: SceneNode[] = [];
    const add = (m: Mesh): void => {
        m.material = material;
        m.pickable = false;
        addToScene(scene, m);
        created.push(m);
    };

    if (lightType === "directional") {
        // BJS: root → mesh(rot.z=PI/2, rot.y=PI/2) → sphere + 3 shafts + 3 heads.
        const mq = quatFromBjsEuler(0, Math.PI / 2, Math.PI / 2);
        const meshRoot = createTransformNode("directionalLight", 0, 0, 0, mq[0], mq[1], mq[2], mq[3]);
        meshRoot.parent = parent;
        created.push(meshRoot as unknown as SceneNode);

        const sphere = createSphere(engine, { diameter: 1.2, segments: 10 });
        sphere.parent = meshRoot as unknown as SceneNode;
        add(sphere);

        const makeShaft = (x: number, sy: number): void => {
            const shaft = createCylinder(engine, { height: 6, diameterTop: 0.3, diameterBottom: 0.3, tessellation: 6 });
            shaft.parent = meshRoot as unknown as SceneNode;
            shaft.position.set(x, 0, 0);
            shaft.scaling.set(1, sy, 1);
            add(shaft);
        };
        makeShaft(0, 1);
        makeShaft(1.25, 0.5);
        makeShaft(-1.25, 0.5);

        const makeHead = (x: number, y: number): void => {
            const head = createCylinder(engine, { height: 1, diameterTop: 0, diameterBottom: 0.6, tessellation: 6 });
            head.parent = meshRoot as unknown as SceneNode;
            head.position.set(x, y, 0);
            add(head);
        };
        makeHead(0, 3);
        makeHead(1.25, 1.5);
        makeHead(-1.25, 1.5);
        return created;
    }

    // point / hemispheric / spot.  BJS builds these with an outer root rotated
    // +90° about X, then OVERRIDES it with `rotationQuaternion = identity` in
    // the light setter — so the effective outer-root rotation is identity.  The
    // child meshes (sphere / hemisphere / lines-root) keep their own rotations.
    const typeRoot = createTransformNode(lightType + "Light", 0, 0, 0, 0, 0, 0, 1);
    typeRoot.parent = parent;
    created.push(typeRoot as unknown as SceneNode);

    if (lightType === "point") {
        const sphere = createSphere(engine, { diameter: 1, segments: 10 });
        const sq = quatFromBjsEuler(Math.PI / 2, 0, 0);
        sphere.rotationQuaternion.set(sq[0], sq[1], sq[2], sq[3]);
        sphere.parent = typeRoot as unknown as SceneNode;
        add(sphere);
        created.push(...buildLightLines(engine, scene, material, typeRoot as unknown as SceneNode, 5));
    } else if (lightType === "hemispheric") {
        const hemi = buildHemisphereMesh(engine, 10, 1);
        const hq = quatFromBjsEuler(Math.PI / 2, 0, 0);
        hemi.rotationQuaternion.set(hq[0], hq[1], hq[2], hq[3]);
        hemi.position.set(0, 0, -0.15);
        hemi.parent = typeRoot as unknown as SceneNode;
        add(hemi);
        created.push(...buildLightLines(engine, scene, material, typeRoot as unknown as SceneNode, 3));
    } else {
        // spot
        const sphere = createSphere(engine, { diameter: 1, segments: 10 });
        sphere.parent = typeRoot as unknown as SceneNode;
        add(sphere);
        const hemi = buildHemisphereMesh(engine, 10, 2);
        const hq = quatFromBjsEuler(-Math.PI / 2, 0, 0);
        hemi.rotationQuaternion.set(hq[0], hq[1], hq[2], hq[3]);
        hemi.parent = typeRoot as unknown as SceneNode;
        add(hemi);
        created.push(...buildLightLines(engine, scene, material, typeRoot as unknown as SceneNode, 2));
    }
    return created;
}

// ─── Public API ──────────────────────────────────────────────────────

/** Dispose a single gizmo node: render-meshes go through `removeFromScene`
 *  (which frees their GPU buffers); pure transform nodes just get unparented
 *  since they own no GPU resources. */
function disposeGizmoNode(scene: SceneContext, node: SceneNode): void {
    if ("_gpu" in (node as unknown as Record<string, unknown>)) {
        removeFromScene(scene, node as unknown as Mesh);
    } else {
        (node as unknown as { parent: SceneNode | null }).parent = null;
    }
}

/** Build a display-only light gizmo and attach it to the utility layer.  The
 *  per-light-type geometry is built lazily on the first `attachLightGizmoToLight`
 *  (since the light type isn't known until then). */
export function createLightGizmo(engine: EngineContext, layer: UtilityLayer, options: LightGizmoOptions = {}): LightGizmo {
    const color = options.color ?? [0.5, 0.5, 0.5];
    const utilityScene = layer.scene;

    const material = createStandardMaterial();
    material.diffuseColor = color;
    // Match BJS LightGizmo material exactly: lit StandardMaterial, diffuse grey
    // + low specular, no emissive (the utility layer's hemispheric light shades
    // the gizmo).  Default back-face culling.
    material.specularColor = [0.1, 0.1, 0.1];

    const root = createTransformNode("lightGizmoRoot", 0, 0, 0, 0, 0, 0, 1);
    addToScene(utilityScene, root);

    const gizmo: LightGizmo = {
        root: root as unknown as SceneNode,
        material,
        attachedLight: null,
        _meshes: [root as unknown as SceneNode],
        _builtType: null,
        _build: () => undefined,
        _disposeFollow: () => undefined,
    };

    gizmo._build = (light: LightBase): void => {
        if (gizmo._builtType === light.lightType) {
            return;
        }
        // Different type than previously built — tear down old geometry.
        if (gizmo._builtType) {
            for (const m of gizmo._meshes) {
                if (m === (root as unknown as SceneNode)) {
                    continue;
                }
                disposeGizmoNode(utilityScene, m);
            }
            gizmo._meshes = [root as unknown as SceneNode];
        }
        const built = buildLightTypeMesh(engine, utilityScene, material, root as unknown as SceneNode, light.lightType);
        gizmo._meshes.push(...built);
        gizmo._builtType = light.lightType;
    };

    let stopped = false;
    onBeforeRender(utilityScene, () => {
        if (stopped) {
            return;
        }
        const light = gizmo.attachedLight;
        if (!light) {
            return;
        }
        const pos = (light as unknown as { position?: { x: number; y: number; z: number } }).position;
        if (pos) {
            root.position.set(pos.x, pos.y, pos.z);
        }
        const dir = (light as unknown as { direction?: { x: number; y: number; z: number } }).direction;
        if (dir) {
            // Match BJS `attachedMesh.setDirection(light.direction)` exactly
            // (yaw + pitch, no roll) so roll-asymmetric gizmos like the
            // directional-light arrows orient correctly.
            const q = directionToQuat({ x: dir.x, y: dir.y, z: dir.z });
            root.rotationQuaternion.set(q[0], q[1], q[2], q[3]);
        }
        // Distance-based scaling keeps the widget a roughly constant on-screen
        // size (mirrors BJS `Gizmo._update` × `LightGizmo._Scale`).
        const camera = utilityScene.camera;
        if (camera) {
            const cw = camera.worldMatrix;
            const dist = Math.hypot(cw[12]! - root.position.x, cw[13]! - root.position.y, cw[14]! - root.position.z) * LIGHT_GIZMO_SCALE;
            root.scaling.set(dist, dist, dist);
        } else {
            root.scaling.set(LIGHT_GIZMO_SCALE, LIGHT_GIZMO_SCALE, LIGHT_GIZMO_SCALE);
        }
    });
    gizmo._disposeFollow = () => {
        stopped = true;
    };

    return gizmo;
}

/** Attach the light gizmo to a light, or detach it with `null`.
 * Type-specific geometry is built lazily when a light is first attached.
 */
export function attachLightGizmoToLight(gizmo: LightGizmo, light: LightBase | null): void {
    gizmo.attachedLight = light;
    if (light) {
        gizmo._build(light);
    }
}

/** Dispose all meshes and frame callbacks owned by the light gizmo. */
export function disposeLightGizmo(gizmo: LightGizmo, layer: UtilityLayer): void {
    gizmo._disposeFollow();
    for (const m of gizmo._meshes) {
        disposeGizmoNode(layer.scene, m);
    }
    gizmo._meshes.length = 0;
}
