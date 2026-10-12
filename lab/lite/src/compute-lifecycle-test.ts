import { ArcRotateCamera, ComputeShader, Scene, StorageBuffer, Vector3, WebGPUEngine } from "../../../packages/babylon-lite-compat/src/index.js";

interface ComputeLifecycleResults {
    ready: boolean;
    error: string | null;
    compileCount: number;
    firstDispatchValue: number | null;
    reboundDispatchValue: number | null;
    frameReadValue: number | null;
}

declare global {
    interface Window {
        __computeLifecycleTest: ComputeLifecycleResults;
    }
}

const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
const results: ComputeLifecycleResults = {
    ready: false,
    error: null,
    compileCount: 0,
    firstDispatchValue: null,
    reboundDispatchValue: null,
    frameReadValue: null,
};
window.__computeLifecycleTest = results;

function firstUint32(data: ArrayBufferView): number {
    return new Uint32Array(data.buffer, data.byteOffset, 1)[0]!;
}

async function run(): Promise<void> {
    const engine = new WebGPUEngine(canvas);
    let first: StorageBuffer | null = null;
    let second: StorageBuffer | null = null;
    try {
        await engine.initAsync();
        first = new StorageBuffer(engine, 16);
        second = new StorageBuffer(engine, 16);
        first.update(new Uint32Array([41]));
        second.update(new Uint32Array([99]));

        const shader = new ComputeShader(
            "compat-compute-lifecycle",
            engine,
            {
                computeSource: `
@group(0) @binding(0) var<storage, read_write> values: array<u32>;

@compute @workgroup_size(1)
fn main(@builtin(global_invocation_id) id: vec3u) {
    values[id.x] += 1u;
}`,
            },
            { bindingsMapping: { values: { group: 0, binding: 0 } } }
        );
        shader.onCompiled = () => {
            results.compileCount++;
        };

        shader.setStorageBuffer("values", first);
        shader.dispatch(1);
        results.firstDispatchValue = firstUint32(await first.read(0, 4, undefined, true));

        shader.setStorageBuffer("values", second);
        shader.dispatch(1);
        results.reboundDispatchValue = firstUint32(await second.read(0, 4, undefined, true));

        second.update(new Uint32Array([7]));
        const scene = new Scene(engine);
        new ArcRotateCamera("camera", 0, Math.PI / 2, 2, Vector3.Zero(), scene);
        const frameRead = new Promise<ArrayBufferView>((resolve, reject) => {
            scene.onBeforeRenderObservable.addOnce(() => {
                second!.clear();
                void second!.read().then(resolve, reject);
            });
        });
        engine.runRenderLoop(() => scene.render());
        results.frameReadValue = firstUint32(await frameRead);
        scene.dispose();
    } catch (error) {
        results.error = error instanceof Error ? error.message : String(error);
    } finally {
        first?.dispose();
        second?.dispose();
        engine.dispose();
        results.ready = true;
        canvas.dataset.ready = "true";
    }
}

void run();
