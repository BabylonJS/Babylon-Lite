/** Dress-Room Demo — a dressing-room showcase using real CC0 modular character art.
 *
 *  A rigged humanoid stands on a turntable pedestal under studio lighting. The
 *  control panel lets you swap the outfit piece in each body region (head,
 *  shoulders, body, arms, legs, feet) between Peasant and Ranger variants — or
 *  none, baring the underlying body — and apply a themed preset. Because all of
 *  the parts share one rig, bind pose and origin, dressing the figure is simply
 *  toggling outfit meshes on over the always-visible base body.
 *
 *  Art credit: "Universal Base Characters" and "Modular Character Outfits –
 *  Fantasy" by Quaternius (https://quaternius.com), released under CC0 1.0
 *  (public domain). Textures are downscaled copies committed under
 *  lab/public/dress-room/. The figure is shown in its rest (bind) pose: Babylon
 *  Lite exposes no animation-retargeting API, so the matching animation
 *  libraries can't drive this skeleton at runtime. */

import {
    addToScene,
    attachControl,
    createArcRotateCamera,
    createCylinder,
    createDirectionalLight,
    createEngine,
    createEsmDirectionalShadowGenerator,
    createGround,
    createHemisphericLight,
    createPbrMaterial,
    createSceneContext,
    createSolidTexture2D,
    createStandardMaterial,
    loadEnvironment,
    loadGltf,
    onBeforeRender,
    registerSceneWithShadowSupport,
    setShadowTaskCasterMeshes,
    startEngine,
} from "babylon-lite";
import type { EngineContext, Mesh, SceneContext, SceneNode } from "babylon-lite";
import { BASE_BODY_FILE, getCatalog, loadPart } from "./dress-room/outfit.js";
import type { OutfitPart, SlotId } from "./dress-room/outfit.js";
import { buildPanel } from "./dress-room/ui.js";
import type { DressRoomApi } from "./dress-room/ui.js";

/** Asset folder served by the lab (downscaled CC0 glTF parts). */
const ASSET_BASE = new URL("/dress-room/", location.href).href;

const PRESETS: Record<string, Record<SlotId, string>> = {
    Ranger: { head: "ranger", shoulders: "ranger", body: "ranger", arms: "ranger", legs: "ranger", feet: "ranger" },
    Peasant: { head: "none", shoulders: "none", body: "peasant", arms: "peasant", legs: "peasant", feet: "peasant" },
    Bare: { head: "none", shoulders: "none", body: "none", arms: "none", legs: "none", feet: "none" },
};

/** Gather every renderable mesh under a set of roots (meshes carry a `material`). */
function collectMeshes(roots: readonly SceneNode[]): Mesh[] {
    const out: Mesh[] = [];
    const stack: SceneNode[] = [...roots];
    while (stack.length) {
        const node = stack.pop()!;
        if ((node as Mesh).material) {
            out.push(node as Mesh);
        }
        if (node.children?.length) {
            stack.push(...node.children);
        }
    }
    return out;
}

async function main(): Promise<void> {
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    try {
        const engine = await createEngine(canvas);
        const scene = createSceneContext(engine);
        scene.clearColor = { r: 0.07, g: 0.06, b: 0.09, a: 1.0 };

        // Turntable camera. Zoom is clamped (see the render loop) so the wheel
        // can't dolly inside the figure or pull back into empty space.
        const MIN_RADIUS = 2.2;
        const MAX_RADIUS = 7.0;
        const camera = createArcRotateCamera(Math.PI / 2, 1.2, 4.2, { x: 0, y: 1.0, z: 0 });
        camera.nearPlane = 0.1;
        camera.farPlane = 100;
        scene.camera = camera;
        attachControl(camera, canvas, scene);

        // Image-based lighting for realistic material reflections. We only want
        // the IBL textures; skip the helper's background skybox AND background
        // ground (the latter is created at ~y=0 and would z-fight our own studio
        // floor at y=-0.12 into a dark wedge sweeping across the surface).
        await loadEnvironment(scene, "https://assets.babylonjs.com/core/environments/environmentSpecular.env", {
            brdfUrl: "/brdf-lut.png",
            skipGround: true,
            skipSkybox: true,
        });

        // Studio lighting: bright ambient fill + a key directional that casts
        // shadows, plus a fill and a soft back/rim light. The CC0 fabrics are
        // quite dark, so the rig is pushed brighter than a typical scene.
        addToScene(scene, createHemisphericLight([0, 1, 0], 1.1));
        const keyLight = createDirectionalLight([-0.5, -1.0, -0.6], 2.6);
        keyLight.position.set(4, 8, 4);
        addToScene(scene, keyLight);
        addToScene(scene, createDirectionalLight([0.8, -0.4, 0.6], 1.0));
        addToScene(scene, createDirectionalLight([0.2, -0.3, -1.0], 0.7));

        // Studio floor — a plain matte Lambert plane (no specular, no reflection)
        // that reads as a clean studio backdrop and does not receive shadows (a
        // 24x24 receiver overruns the caster-sized shadow frustum, producing a
        // swimming seam; only the small pedestal under the figure receives the
        // cast shadow).
        const floorMat = createStandardMaterial();
        floorMat.diffuseColor = [0.1, 0.1, 0.13];
        floorMat.specularColor = [0, 0, 0];
        const floor = createGround(engine, { width: 24, height: 24, subdivisions: 2 });
        floor.material = floorMat;
        floor.receiveShadows = false;
        floor.position.set(0, -0.12, 0);
        addToScene(scene, floor);

        const pedestalMat = createPbrMaterial({
            baseColorTexture: createSolidTexture2D(engine, 0.13, 0.12, 0.16, 1),
            ormTexture: createSolidTexture2D(engine, 1.0, 0.7, 0.0, 1),
            usePhysicalLightFalloff: false,
        });
        const pedestal = createCylinder(engine, { height: 0.12, diameter: 2.4, tessellation: 48 });
        pedestal.material = pedestalMat;
        pedestal.position.set(0, -0.06, 0);
        pedestal.receiveShadows = true;
        addToScene(scene, pedestal);

        // Base humanoid body — always visible; the outfit parts layer over it.
        const baseGltf = await loadGltf(engine, ASSET_BASE + BASE_BODY_FILE);
        for (const entity of baseGltf.entities) {
            addToScene(scene, entity);
        }
        const baseMeshes = collectMeshes(baseGltf.entities as SceneNode[]);

        // Load every outfit part once (hidden), keyed by slot + option id.
        const wardrobe = await buildWardrobe(engine, scene);

        // Directional shadow from the key light. The caster list holds the base
        // body plus every outfit part; hidden parts are skipped automatically.
        keyLight.shadowGenerator = createEsmDirectionalShadowGenerator(engine, keyLight, {
            mapSize: 1024,
            depthScale: 50,
            bias: 0.00005,
            blurKernel: 32,
            blurScale: 2,
            darkness: 0,
            frustumEdgeFalloff: 0,
            orthoMinZ: camera.nearPlane,
            orthoMaxZ: camera.farPlane,
            forceRefreshEveryFrame: true,
        });
        const partMeshes = wardrobe.slots.flatMap((s) => [...s.parts.values()].flatMap((p) => p.meshes));
        setShadowTaskCasterMeshes(keyLight.shadowGenerator, [...baseMeshes, ...partMeshes]);

        // Default loadout.
        applyLoadout(wardrobe, PRESETS.Ranger!);

        canvas.dataset.ready = "true";

        // Turntable spin (stops on first interaction). Clamp the zoom radius
        // every frame so wheel inertia settles within the allowed range.
        let spin = true;
        canvas.addEventListener("pointerdown", () => (spin = false));
        onBeforeRender(scene, (deltaMs) => {
            if (spin) {
                camera.alpha += deltaMs * 0.0002;
            }
            if (camera.radius < MIN_RADIUS) {
                camera.radius = MIN_RADIUS;
                camera.inertialRadiusOffset = 0;
            } else if (camera.radius > MAX_RADIUS) {
                camera.radius = MAX_RADIUS;
                camera.inertialRadiusOffset = 0;
            }
        });

        await registerSceneWithShadowSupport(engine, scene);
        await startEngine(engine);

        wireUi(wardrobe);
    } catch (err) {
        canvas.dataset.error = String(err);
        console.error(err);
    }
}

// ─── Wardrobe (equipment state) ───────────────────────────────────────

interface SlotState {
    id: SlotId;
    label: string;
    optionIds: string[];
    optionLabels: Map<string, string>;
    parts: Map<string, OutfitPart>; // loaded options only ("none" absent)
    equipped: string;
}

interface Wardrobe {
    slots: SlotState[];
    byId: Map<SlotId, SlotState>;
}

async function buildWardrobe(engine: EngineContext, scene: SceneContext): Promise<Wardrobe> {
    const slots: SlotState[] = [];
    const byId = new Map<SlotId, SlotState>();
    for (const def of getCatalog()) {
        const parts = new Map<string, OutfitPart>();
        const optionLabels = new Map<string, string>();
        for (const opt of def.options) {
            optionLabels.set(opt.id, opt.label);
            if (opt.file) {
                const part = await loadPart(engine, scene, ASSET_BASE, opt.file);
                part.setVisible(false);
                parts.set(opt.id, part);
            }
        }
        const state: SlotState = {
            id: def.id,
            label: def.label,
            optionIds: def.options.map((o) => o.id),
            optionLabels,
            parts,
            equipped: "none",
        };
        slots.push(state);
        byId.set(def.id, state);
    }
    return { slots, byId };
}

function equip(slot: SlotState, optionId: string): void {
    if (slot.equipped === optionId) {
        return;
    }
    slot.parts.get(slot.equipped)?.setVisible(false);
    slot.parts.get(optionId)?.setVisible(true);
    slot.equipped = optionId;
}

function applyLoadout(wardrobe: Wardrobe, loadout: Record<SlotId, string>): void {
    for (const slot of wardrobe.slots) {
        equip(slot, loadout[slot.id] ?? "none");
    }
}

// ─── UI wiring ────────────────────────────────────────────────────────

function wireUi(wardrobe: Wardrobe): void {
    const api: DressRoomApi = {
        slots: wardrobe.slots.map((s) => ({
            id: s.id,
            label: s.label,
            options: s.optionIds.map((id) => ({ id, label: s.optionLabels.get(id) ?? id })),
        })),
        animations: [],
        presets: Object.keys(PRESETS),
        tintable: false,
        getOption: (slotId) => wardrobe.byId.get(slotId as SlotId)?.equipped ?? "none",
        setOption: (slotId, optionId) => {
            const slot = wardrobe.byId.get(slotId as SlotId);
            if (slot) {
                equip(slot, optionId);
            }
        },
        cycleOption: (slotId, dir) => {
            const slot = wardrobe.byId.get(slotId as SlotId);
            if (!slot) {
                return;
            }
            const idx = slot.optionIds.indexOf(slot.equipped);
            const nextIdx = (idx + dir + slot.optionIds.length) % slot.optionIds.length;
            equip(slot, slot.optionIds[nextIdx]!);
        },
        getAnimation: () => "",
        setAnimation: () => {},
        getTint: () => null,
        setTint: () => {},
        resetTint: () => {},
        randomize: () => {
            for (const slot of wardrobe.slots) {
                const pick = slot.optionIds[Math.floor(Math.random() * slot.optionIds.length)]!;
                equip(slot, pick);
            }
        },
        applyPreset: (name) => {
            const loadout = PRESETS[name];
            if (loadout) {
                applyLoadout(wardrobe, loadout);
            }
        },
    };
    buildPanel(api);
}

main().catch(console.error);
