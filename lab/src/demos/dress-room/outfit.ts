/** Modular fantasy outfits for the dress-room demo.
 *
 *  Unlike the original procedural gear, these are real CC0 1.0 (public-domain)
 *  modular character assets by Quaternius: a base humanoid body plus
 *  interchangeable outfit parts (Peasant / Ranger) for each body region. Every
 *  body and outfit part shares one identical 65-joint rig and bind pose with a
 *  common origin, so each part loaded as its own glTF overlays the base body
 *  perfectly — the dressing-room composition is just "show the base body, then
 *  toggle outfit parts on top".
 *
 *  Assets live (downscaled) under `lab/public/dress-room/`. Pieces are rigged
 *  but the demo shows them in the rest (bind) pose: Babylon Lite has no public
 *  animation-retargeting API, so the separate animation libraries can't drive
 *  this skeleton at runtime. */

import { addToScene, loadGltf, setSubtreeVisible } from "babylon-lite";
import type { EngineContext, Mesh, SceneContext, SceneNode } from "babylon-lite";

/** Body regions the wardrobe can dress, in display order. */
export type SlotId = "head" | "shoulders" | "body" | "arms" | "legs" | "feet";

/** A choice within a slot. `file` is undefined for the "None" (bare) option. */
export interface SlotOption {
    id: string;
    label: string;
    /** glTF filename under the asset folder; undefined leaves the bare base body. */
    file?: string;
}

/** A slot and its available options. */
export interface SlotDef {
    id: SlotId;
    label: string;
    options: SlotOption[];
}

/** A loaded, placed outfit part. Toggle `setVisible` to equip / unequip. */
export interface OutfitPart {
    /** Root nodes added to the scene. */
    roots: SceneNode[];
    /** Every renderable mesh in the part (used as shadow casters). */
    meshes: Mesh[];
    /** Show or hide the whole part. */
    setVisible(visible: boolean): void;
}

/** The base "naked" humanoid body (always visible — provides skin, face, hands). */
export const BASE_BODY_FILE = "Superhero_Male_FullBody.gltf";

/** The full modular wardrobe. Each slot leads with a "None" (bare) option. */
export function getCatalog(): SlotDef[] {
    return [
        {
            id: "head",
            label: "Head",
            options: [
                { id: "none", label: "None" },
                { id: "ranger", label: "Ranger Hood", file: "Male_Ranger_Head_Hood.gltf" },
            ],
        },
        {
            id: "shoulders",
            label: "Shoulders",
            options: [
                { id: "none", label: "None" },
                { id: "ranger", label: "Ranger Pauldron", file: "Male_Ranger_Acc_Pauldron.gltf" },
            ],
        },
        {
            id: "body",
            label: "Body",
            options: [
                { id: "none", label: "Bare" },
                { id: "peasant", label: "Peasant Tunic", file: "Male_Peasant_Body.gltf" },
                { id: "ranger", label: "Ranger Jerkin", file: "Male_Ranger_Body.gltf" },
            ],
        },
        {
            id: "arms",
            label: "Arms",
            options: [
                { id: "none", label: "Bare" },
                { id: "peasant", label: "Peasant Sleeves", file: "Male_Peasant_Arms.gltf" },
                { id: "ranger", label: "Ranger Bracers", file: "Male_Ranger_Arms.gltf" },
            ],
        },
        {
            id: "legs",
            label: "Legs",
            options: [
                { id: "none", label: "Bare" },
                { id: "peasant", label: "Peasant Trousers", file: "Male_Peasant_Legs.gltf" },
                { id: "ranger", label: "Ranger Leggings", file: "Male_Ranger_Legs.gltf" },
            ],
        },
        {
            id: "feet",
            label: "Feet",
            options: [
                { id: "none", label: "Bare" },
                { id: "peasant", label: "Peasant Shoes", file: "Male_Peasant_Feet.gltf" },
                { id: "ranger", label: "Ranger Boots", file: "Male_Ranger_Feet_Boots.gltf" },
            ],
        },
    ];
}

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

/** Load one glTF asset, add its roots to the scene, and return a toggleable part. */
export async function loadPart(engine: EngineContext, scene: SceneContext, baseUrl: string, file: string): Promise<OutfitPart> {
    const gltf = await loadGltf(engine, baseUrl + file);
    const roots: SceneNode[] = [];
    for (const entity of gltf.entities) {
        addToScene(scene, entity);
        roots.push(entity as SceneNode);
    }
    const part: OutfitPart = {
        roots,
        meshes: collectMeshes(roots),
        setVisible: (visible: boolean) => {
            for (const root of roots) {
                setSubtreeVisible(root, visible);
            }
        },
    };
    return part;
}
