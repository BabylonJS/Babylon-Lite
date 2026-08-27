/**
 * Antigravity Racer — every asset the source playground uses.
 *
 * The two models are CC BY 4.0 Sketchfab models (see
 * `lab/public/antigravity-racer/CREDITS.txt`, and the `asset.extras` block inside
 * each `scene.gltf`), vendored at a pinned commit by
 * `scripts/fetch-antigravity-racer.ts`. The four road sheets are Patrick Ryan's
 * track artwork, extracted from the playground's node material and committed
 * under `track/` with his permission (see that folder's CREDITS.txt). Both sets
 * are served from the demo's own asset folder — never fetched from a mutable
 * remote URL at runtime.
 *
 * The models are loaded exactly ONCE for the whole page and then kept as *templates*:
 *
 *  - Each racing mode calls {@link instantiateModel}, which `cloneTransformNode`s
 *    the template. Clones share the template's ref-counted GPU geometry, so a
 *    mode teardown releases only the clone's claim while the template keeps the
 *    buffers alive for the next mode.
 *  - glTF image uploads take no ref of their own (only a live renderable does),
 *    so {@link loadRacerAssets} takes an explicit `acquireTexture` reference on
 *    every material texture. Without it the first mode teardown would destroy
 *    the textures the template still points at.
 *
 * The net effect: switching between menu / race / editor never re-decodes the
 * ~12 MB of model textures nor the ~2 MB of road artwork.
 */

import type { AssetContainer, EngineContext, HierarchyInstancePool, SceneNode, Texture2D } from "babylon-lite";
import { acquireTexture, cloneTransformNode, createHierarchyInstancePool, getContainerMeshes, isPbrMaterial, loadGltf, loadTexture2D, releaseTexture } from "babylon-lite";

import { demoAssetUrl } from "../demo-asset-url.js";
import type { TrackTextures } from "./track-material.js";

/** Racing ship — "RHS-X" by Hassan Bassassi (alone5), CC BY 4.0. */
const SHIP_URL = demoAssetUrl("./antigravity-racer/rhs-x/scene.gltf", import.meta.url);
/** Boulder — "Obj_Nat_Rock_01" by SaschaHenrichs, CC BY 4.0. */
const ROCK_URL = demoAssetUrl("./antigravity-racer/obj_nat_rock_01/scene.gltf", import.meta.url);

/**
 * The road sheets, with the sampler state the node material gave each one.
 * `srgb: false` and `invertY: false` mirror the originals: the graph sampled the
 * raw 8-bit values with no gamma decode, and the textures were parsed with
 * `invertY = false`, so texel row 0 is the top of the image under V = 0.
 */
const TRACK_TEXTURE_SOURCES = [
    { key: "straight", file: "road-straight.png", addressModeU: "clamp-to-edge" },
    { key: "curve", file: "road-curve.png", addressModeU: "clamp-to-edge" },
    { key: "emissive", file: "road-emissive.png", addressModeU: "repeat" },
    { key: "boost", file: "boost-arrow.png", addressModeU: "repeat" },
] as const satisfies readonly { key: keyof TrackTextures; file: string; addressModeU: GPUAddressMode }[];

/** PBR texture slots these two models populate. */
const PBR_TEXTURE_FIELDS = ["baseColorTexture", "normalTexture", "ormTexture", "emissiveTexture", "occlusionTexture"] as const;

export interface RacerAssets {
    /** Template root of the ship model (never added to a scene — clone it instead). */
    readonly shipTemplate: SceneNode;
    /** Template root of the boulder model (never added to a scene — clone it instead). */
    readonly rockTemplate: SceneNode;
    /** The four road sheets the track material samples. */
    readonly trackTextures: TrackTextures;
    /** Release the page-lifetime texture references taken at load time. */
    dispose(): void;
}

function collectTextures(container: AssetContainer, out: Texture2D[]): void {
    for (const mesh of getContainerMeshes(container)) {
        const material = mesh.material;
        if (!isPbrMaterial(material)) {
            continue;
        }
        for (const field of PBR_TEXTURE_FIELDS) {
            const texture = material[field];
            if (texture && !out.includes(texture)) {
                out.push(texture);
            }
        }
    }
}

/**
 * Load the four road sheets. Rejects with a readable message if any of them
 * fails — the track is unshadeable without its artwork, so this must surface as
 * a startup error rather than silently degrade.
 */
async function loadTrackTextures(engine: EngineContext): Promise<TrackTextures> {
    const urls = TRACK_TEXTURE_SOURCES.map((source) => demoAssetUrl(`./antigravity-racer/track/${source.file}`, import.meta.url));
    let loaded: Texture2D[];
    try {
        loaded = await Promise.all(
            TRACK_TEXTURE_SOURCES.map((source, i) =>
                loadTexture2D(engine, urls[i]!, {
                    addressModeU: source.addressModeU,
                    addressModeV: "repeat",
                    invertY: false,
                    srgb: false,
                })
            )
        );
    } catch (cause) {
        throw new Error(`Antigravity Racer could not load its road artwork from ${urls.join(", ")}. Cause: ${String(cause)}`, { cause });
    }
    const textures = {} as Record<keyof TrackTextures, Texture2D>;
    for (let i = 0; i < TRACK_TEXTURE_SOURCES.length; i++) {
        textures[TRACK_TEXTURE_SOURCES[i]!.key] = loaded[i]!;
    }
    return textures;
}

/** Load the ship + boulder models and the road artwork once. Rejects with a readable message if anything fails. */
export async function loadRacerAssets(engine: EngineContext): Promise<RacerAssets> {
    let ship: AssetContainer;
    let rock: AssetContainer;
    try {
        [ship, rock] = await Promise.all([loadGltf(engine, SHIP_URL), loadGltf(engine, ROCK_URL)]);
    } catch (cause) {
        throw new Error(
            `Antigravity Racer could not load its models from ${SHIP_URL} / ${ROCK_URL}. ` +
                `Run \`pnpm fetch:antigravity-racer\` to restore them (they are gitignored). Cause: ${String(cause)}`,
            { cause }
        );
    }

    const pinned: Texture2D[] = [];
    collectTextures(ship, pinned);
    collectTextures(rock, pinned);
    // The road sheets outlive every mode too, so they are pinned the same way.
    const trackTextures = await loadTrackTextures(engine);
    for (const texture of Object.values(trackTextures) as Texture2D[]) {
        if (!pinned.includes(texture)) {
            pinned.push(texture);
        }
    }
    for (const texture of pinned) {
        acquireTexture(texture);
    }

    let disposed = false;
    return {
        shipTemplate: ship.entities[0] as SceneNode,
        rockTemplate: rock.entities[0] as SceneNode,
        trackTextures,
        dispose(): void {
            if (disposed) {
                return;
            }
            disposed = true;
            for (const texture of pinned) {
                releaseTexture(texture);
            }
        },
    };
}

/**
 * Clone a template and turn the clone into a thin-instance pool of `capacity`
 * copies. The returned pool's meshes carry the model's own materials, so all
 * copies render in one draw per source primitive.
 *
 * An instance matrix composes ON TOP of the template's world matrices (including
 * the glTF `__root__` right-to-left-handed flip), exactly like adding a parent
 * transform node above the model root.
 */
export function instantiateModel(template: SceneNode, capacity: number): { root: SceneNode; pool: HierarchyInstancePool } {
    const root = cloneTransformNode(template);
    return { root, pool: createHierarchyInstancePool(root, capacity) };
}
