/**
 * Antigravity Racer — the height-mapped ground.
 *
 * The playground grounds the track on the Babylon playground's own shared
 * textures:
 *
 *   CreateGroundFromHeightMap("ground", "textures/heightMap.png", 400, 400, 600, 0, 25, scene, false)
 *   groundMaterial.diffuseTexture = new Texture("textures/ground.jpg"); uScale = vScale = 6
 *   groundMaterial.specularColor = black; ground.position.y = -2.05; ground.receiveShadows = true
 *
 * This demo deliberately doubles the ground dimensions and UV tiling after the
 * fidelity port so the terrain reaches farther toward the HDR horizon without
 * stretching the ground artwork.
 *
 * Those two files are NOT redistributed with this demo — they are fetched from
 * `playground.babylonjs.com` at runtime, so the terrain is the original's relief
 * and artwork exactly. A network/decode failure is surfaced as a hard error (the
 * demo's error overlay); there is deliberately no procedural fallback, because a
 * different ground silhouette would silently break parity.
 */

import type { EngineContext, MaterialPlugin, Mesh, SceneContext } from "babylon-lite";
import { addToScene, createGroundFromHeightMap, createStandardMaterial, loadTexture2D } from "babylon-lite";

import { RACER_FOG_END, RACER_FOG_START, TERRAIN_MAX_HEIGHT, TERRAIN_MIN_HEIGHT, TERRAIN_SIZE, TERRAIN_SUBDIVISIONS, TERRAIN_UV_SCALE, TERRAIN_Y } from "./constants.js";

/** The playground's own height map — the relief the original track flies over. */
export const HEIGHTMAP_URL = "https://playground.babylonjs.com/textures/heightMap.png";
/** The playground's own ground diffuse sheet. */
export const GROUND_TEXTURE_URL = "https://playground.babylonjs.com/textures/ground.jpg";

/** Keep the ground in the transparent render phase; the shader supplies the visible distance alpha. */
export const TERRAIN_BASE_ALPHA = 0.999;

export function createTerrainDistanceFade(): MaterialPlugin {
    return {
        name: "antigrav-terrain-distance-fade",
        getCustomCode(shaderType) {
            if (shaderType !== "fragment") {
                return null;
            }
            return {
                CUSTOM_FRAGMENT_UPDATE_ALPHA: `alpha *= 1.0 - smoothstep(${RACER_FOG_START}.0, ${RACER_FOG_END}.0, distance(scene.vEyePosition.xyz, input.vp));`,
            };
        },
    };
}

/** Build the ground mesh from the playground's remote height map + diffuse texture. */
export async function createTerrain(engine: EngineContext): Promise<Mesh> {
    let mesh: Mesh;
    try {
        mesh = await createGroundFromHeightMap(engine, HEIGHTMAP_URL, {
            width: TERRAIN_SIZE,
            height: TERRAIN_SIZE,
            subdivisions: TERRAIN_SUBDIVISIONS,
            minHeight: TERRAIN_MIN_HEIGHT,
            maxHeight: TERRAIN_MAX_HEIGHT,
            uvScale: [TERRAIN_UV_SCALE, TERRAIN_UV_SCALE],
        });
    } catch (cause) {
        throw new Error(`Antigravity Racer could not load its height map from ${HEIGHTMAP_URL}. Cause: ${String(cause)}`, { cause });
    }
    mesh.name = "antigrav-terrain";
    mesh.position.y = TERRAIN_Y;
    mesh.receiveShadows = true;

    const material = createStandardMaterial();
    try {
        material.diffuseTexture = await loadTexture2D(engine, GROUND_TEXTURE_URL);
    } catch (cause) {
        throw new Error(`Antigravity Racer could not load its ground texture from ${GROUND_TEXTURE_URL}. Cause: ${String(cause)}`, { cause });
    }
    material.specularColor = [0, 0, 0];
    material.alpha = TERRAIN_BASE_ALPHA;
    material.plugins = [createTerrainDistanceFade()];
    mesh.material = material;
    return mesh;
}

export function addTerrainToScene(scene: SceneContext, terrain: Mesh): void {
    addToScene(scene, terrain);
}
