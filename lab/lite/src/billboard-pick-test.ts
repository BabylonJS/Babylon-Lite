/** GPU billboard-sprite picking test — a clear billboard, a billboard occluded by a box, and a
 *  miss. Picks at each billboard's projected screen position and exposes the results on
 *  `window.__bbPickTest` for the `billboard-pick.spec.ts` Playwright assertions. */
import {
    addBillboardSpriteIndex,
    addFacingBillboardSystem,
    addToScene,
    createArcRotateCamera,
    createBox,
    createEngine,
    createFacingBillboardSystem,
    createGpuPicker,
    createHemisphericLight,
    createSceneContext,
    createStandardMaterial,
    disposePicker,
    getCameraPosition,
    getViewProjectionMatrix,
    loadSpriteAtlas,
    pickAsync,
    pickBillboardSprite,
    registerScene,
    startEngine,
} from "babylon-lite";
import { getSpriteAtlasDataUrl, SPRITE_ATLAS_INFO } from "./_shared/sprite-atlas-image";

const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;

interface BillboardPickResults {
    ready: boolean;
    error: string | null;
    /** Index of the clear billboard (added first → 0). */
    idxA: number;
    /** Clear billboard pick: { spriteIndex, systemMatch }, or null on miss. */
    hitA: { spriteIndex: number; systemMatch: boolean } | null;
    /** Occluded billboard pick: should be null (a box is in front). */
    hitB: { spriteIndex: number } | null;
    /** Mesh occluding billboard B (confirms the box won the shared depth pass). */
    meshAtB: string | null;
    /** Empty-corner pick: should be null. */
    miss: { spriteIndex: number } | null;
}

const results: BillboardPickResults = { ready: false, error: null, idxA: -1, hitA: null, hitB: null, meshAtB: null, miss: null };
(window as unknown as { __bbPickTest: BillboardPickResults }).__bbPickTest = results;

/** Project a world point through `vp` (column-major) to CSS pixels on the canvas. */
function projectToCss(world: [number, number, number], vp: ArrayLike<number>, w: number, h: number): [number, number] {
    const [x, y, z] = world;
    const cx = vp[0]! * x + vp[4]! * y + vp[8]! * z + vp[12]!;
    const cy = vp[1]! * x + vp[5]! * y + vp[9]! * z + vp[13]!;
    const cw = vp[3]! * x + vp[7]! * y + vp[11]! * z + vp[15]!;
    return [((cx / cw) * 0.5 + 0.5) * w, (1 - ((cy / cw) * 0.5 + 0.5)) * h];
}

async function run(): Promise<void> {
    try {
        const engine = await createEngine(canvas);
        const scene = createSceneContext(engine);
        scene.clearColor = { r: 0.1, g: 0.12, b: 0.16, a: 1 };
        scene.camera = createArcRotateCamera(-Math.PI / 2, Math.PI / 2, 6, { x: 0, y: 0, z: 0 });
        addToScene(scene, createHemisphericLight([0, 1, 0], 1.0));

        const atlas = await loadSpriteAtlas(engine, getSpriteAtlasDataUrl(), {
            gridSize: [SPRITE_ATLAS_INFO.cellWidthPx, SPRITE_ATLAS_INFO.cellHeightPx],
            sampling: "linear",
        });
        const billboards = createFacingBillboardSystem(atlas, { capacity: 4 });
        const posA: [number, number, number] = [-1.5, 0, 0]; // clear
        const posB: [number, number, number] = [1.5, 0, 0]; // occluded by a box
        results.idxA = addBillboardSpriteIndex(billboards, { position: posA, sizeWorld: [1.2, 1.2], frame: 8 });
        addBillboardSpriteIndex(billboards, { position: posB, sizeWorld: [1.2, 1.2], frame: 13 });
        addFacingBillboardSystem(scene, billboards);

        // Occluder box on the camera→B ray, one third of the way toward the camera, so it covers B.
        const camPos = getCameraPosition(scene.camera);
        const box = createBox(engine, 1.4);
        box.name = "occluder";
        box.position.set(posB[0] + (camPos.x - posB[0]) / 3, posB[1] + (camPos.y - posB[1]) / 3, posB[2] + (camPos.z - posB[2]) / 3);
        const mat = createStandardMaterial();
        mat.diffuseColor = [0.7, 0.3, 0.3];
        box.material = mat;
        addToScene(scene, box);

        await registerScene(scene);
        await startEngine(engine);
        for (let i = 0; i < 5; i++) {
            await new Promise((r) => requestAnimationFrame(r));
        }

        const vp = getViewProjectionMatrix(scene.camera, canvas.width / canvas.height);
        const w = canvas.clientWidth;
        const h = canvas.clientHeight;
        const [ax, ay] = projectToCss(posA, vp, w, h);
        const [bx, by] = projectToCss(posB, vp, w, h);

        const hitA = await pickBillboardSprite(scene, ax, ay);
        const hitB = await pickBillboardSprite(scene, bx, by);
        const picker = createGpuPicker(scene);
        const meshAtB = await pickAsync(picker, bx, by);
        disposePicker(picker);
        const miss = await pickBillboardSprite(scene, 4, 4);

        results.hitA = hitA ? { spriteIndex: hitA.spriteIndex, systemMatch: hitA.system === billboards } : null;
        results.hitB = hitB ? { spriteIndex: hitB.spriteIndex } : null;
        results.meshAtB = meshAtB.pickedMesh ? ((meshAtB.pickedMesh as { name?: string }).name ?? "(unnamed)") : null;
        results.miss = miss ? { spriteIndex: miss.spriteIndex } : null;
        results.ready = true;
        canvas.dataset.ready = "true";
    } catch (e) {
        results.error = e instanceof Error ? e.message : String(e);
        results.ready = true;
        canvas.dataset.ready = "true";
    }
}

void run();
