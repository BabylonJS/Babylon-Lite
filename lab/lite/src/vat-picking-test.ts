import {
    addToScene,
    attachVat,
    bakeVat,
    createDefaultCamera,
    createEngine,
    createGpuPicker,
    createHemisphericLight,
    createSceneContext,
    disposePicker,
    enableDetailedPicking,
    loadGltf,
    pickAsync,
    registerScene,
    setThinInstances,
    startEngine,
    stopEngine,
} from "babylon-lite";
import type { Mesh, PickingInfo, TransformNode, VatClip } from "babylon-lite";

const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;

interface VatPickResults {
    ready: boolean;
    error: string | null;
    thin: boolean;
    hit: boolean;
    meshName: string | null;
    thinInstanceIndex: number;
    faceId: number;
    detailed: boolean;
    pickedPoint: [number, number, number] | null;
}

const results: VatPickResults = {
    ready: false,
    error: null,
    thin: new URLSearchParams(location.search).has("thin"),
    hit: false,
    meshName: null,
    thinInstanceIndex: -1,
    faceId: -1,
    detailed: false,
    pickedPoint: null,
};
(window as unknown as { __vatPickTest: VatPickResults }).__vatPickTest = results;

function findSkinned(node: TransformNode): Mesh | null {
    const mesh = node as Mesh;
    if (mesh.skeleton) {
        return mesh;
    }
    for (const child of node.children as TransformNode[]) {
        const found = findSkinned(child);
        if (found) {
            return found;
        }
    }
    return null;
}

function frozenInstanceParams(clip: VatClip): Float32Array {
    return new Float32Array([clip.fromRow, clip.fromRow + clip.frameCount - 1, 60, 0]);
}

async function findVisibleVatHit(picker: ReturnType<typeof createGpuPicker>): Promise<PickingInfo> {
    const center = await pickAsync(picker, canvas.clientWidth * 0.5, canvas.clientHeight * 0.5);
    if (center.hit) {
        return center;
    }
    for (let y = 0.3; y <= 0.7; y += 0.1) {
        for (let x = 0.3; x <= 0.7; x += 0.1) {
            const info = await pickAsync(picker, canvas.clientWidth * x, canvas.clientHeight * y);
            if (info.hit) {
                return info;
            }
        }
    }
    return center;
}

async function run(): Promise<void> {
    try {
        const engine = await createEngine(canvas);
        const scene = createSceneContext(engine);
        scene.clearColor = { r: 0.14, g: 0.14, b: 0.16, a: 1 };

        const container = await loadGltf(engine, "https://models.babylonjs.com/shark.glb");
        addToScene(scene, container);
        const mesh = findSkinned(container.entities[0] as TransformNode);
        const groups = container.animationGroups ?? [];
        if (!mesh || groups.length === 0) {
            throw new Error("VAT picking test could not find the shark skeleton and animation.");
        }

        const baked = bakeVat(engine, mesh, groups);
        const handle = attachVat(engine, mesh, baked, "swimming");
        const swimming = baked.clips["swimming"];
        if (!swimming) {
            throw new Error("VAT picking test could not find the swimming clip.");
        }
        if (results.thin) {
            setThinInstances(mesh, new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]), 1);
            handle.setInstances(frozenInstanceParams(swimming));
        } else {
            handle.play("swimming", { offset: 60, fps: 0 });
        }
        handle.update(0);

        const camera = createDefaultCamera(scene);
        camera.alpha = 0;
        camera.beta = Math.PI / 2.2;
        addToScene(scene, createHemisphericLight([0, 1, 0], 1));

        await registerScene(scene);
        await startEngine(engine);
        for (let i = 0; i < 5; i++) {
            await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        }

        const picker = createGpuPicker(scene);
        enableDetailedPicking(picker);
        const info = await findVisibleVatHit(picker);
        results.hit = info.hit;
        results.meshName = info.pickedMesh?.name ?? null;
        results.thinInstanceIndex = info.thinInstanceIndex;
        results.faceId = info.faceId;
        results.detailed = info.faceId >= 0;
        results.pickedPoint = info.pickedPoint;
        disposePicker(picker);
        stopEngine(engine);
    } catch (error) {
        results.error = error instanceof Error ? error.message : String(error);
    } finally {
        results.ready = true;
        canvas.dataset.ready = "true";
    }
}

void run();
