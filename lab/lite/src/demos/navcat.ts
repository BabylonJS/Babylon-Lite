import {
    createEngine,
    createSceneContext,
    createFreeCamera,
    createHemisphericLight,
    createBox,
    createSphere,
    createStandardMaterial,
    createMeshFromData,
    createLines,
    createLineSystem,
    addToScene,
    removeFromScene,
    registerScene,
    startEngine,
    createNavcatManager,
    findNavcatPath,
    setNavcatFilter,
    replaceNavcatMesh,
    disposeNavcatManager,
    createNavcatDebugGeometry,
} from "babylon-lite";
import type { Mesh, NavcatManager, Vec3 } from "babylon-lite";
import { demoAssetUrl } from "./demo-asset-url.js";

async function main(): Promise<void> {
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const status = document.getElementById("status")!;
    const startSelect = document.getElementById("start") as HTMLSelectElement;
    const endSelect = document.getElementById("end") as HTMLSelectElement;
    const filterSelect = document.getElementById("filter") as HTMLSelectElement;
    const debugToggle = document.getElementById("debug") as HTMLInputElement;
    const controls = Array.from(document.querySelectorAll<HTMLButtonElement | HTMLSelectElement | HTMLInputElement>("button, select, input"));
    const engine = await createEngine(canvas);
    const scene = createSceneContext(engine);
    scene.clearColor = { r: 0.06, g: 0.11, b: 0.17, a: 1 };
    const camera = createFreeCamera({ x: -2, y: 13, z: -11 }, { x: 0, y: 0, z: 0 });
    scene.camera = camera;
    const fitCamera = (): void => {
        const scale = canvas.clientWidth < 600 ? 1.3 : 1;
        camera.position.set(-2 * scale, 13 * scale, -11 * scale);
    };
    fitCamera();
    window.addEventListener("resize", fitCamera);
    const light = createHemisphericLight([0, 1, 0]);
    light.intensity = 0.9;
    addToScene(scene, light);
    const floorMaterial = createStandardMaterial();
    floorMaterial.diffuseColor = [0.22, 0.31, 0.4];
    for (const [x, z, width, depth] of [
        [-3.5, 0, 5, 8],
        [3.5, 0, 5, 8],
        [0, 3, 2, 2],
        [0, -3, 2, 2],
    ]) {
        const floor = createBox(engine, 1);
        floor.material = floorMaterial;
        floor.scaling.set(width!, 0.18, depth!);
        floor.position.set(x!, -0.1, z!);
        addToScene(scene, floor);
    }
    function marker(color: [number, number, number]): Mesh {
        const mesh = createSphere(engine, { diameter: 0.4, segments: 12 });
        const material = createStandardMaterial();
        material.diffuseColor = color;
        material.emissiveColor = color.map((c) => c * 0.3) as [number, number, number];
        mesh.material = material;
        addToScene(scene, mesh);
        return mesh;
    }
    const startMarker = marker([0.2, 0.95, 0.55]);
    const endMarker = marker([1, 0.35, 0.22]);
    const response = await fetch(demoAssetUrl("./navcat/demo-navmesh.json", import.meta.url));
    if (!response.ok) {
        throw new Error(`Navmesh download failed: ${response.status}`);
    }
    const json = await response.text();
    let manager: NavcatManager | null = await createNavcatManager(json);
    let overlays: Mesh[] = [];

    function clearOverlays(): void {
        for (const mesh of overlays) {
            removeFromScene(scene, mesh);
        }
        overlays = [];
    }
    async function query(): Promise<void> {
        if (!manager) {
            return;
        }
        clearOverlays();
        const start = { x: -4, y: 0, z: Number(startSelect.value) };
        const end = { x: 4, y: 0, z: Number(endSelect.value) };
        startMarker.position.set(start.x, 0.35, start.z);
        endMarker.position.set(end.x, 0.35, end.z);
        setNavcatFilter(
            manager,
            filterSelect.value === "blocked"
                ? { pass: (node) => node.area !== 2 }
                : filterSelect.value === "cost"
                  ? {
                        cost: (a, b, current) => Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z) * (current.area === 2 ? 4 : 1),
                    }
                  : null
        );
        const path = findNavcatPath(manager, start, end);
        if (path.points.length > 1) {
            const line = createLines(engine, { points: path.points.map((p) => ({ ...p.position, y: p.position.y + 0.18 })), color: { r: 1, g: 0.83, b: 0.3, a: 1 } });
            overlays.push(line);
            addToScene(scene, line);
        }
        if (debugToggle.checked) {
            const primitives = await createNavcatDebugGeometry(manager, { search: path });
            for (const primitive of primitives) {
                let mesh: Mesh;
                if (primitive.kind === "triangles") {
                    const normals = new Float32Array(primitive.positions.length);
                    for (let i = 1; i < normals.length; i += 3) {
                        normals[i] = 1;
                    }
                    mesh = createMeshFromData(engine, "navcat-debug", new Float32Array(primitive.positions), normals, primitive.indices!);
                    const material = createStandardMaterial();
                    material.diffuseColor = [0.18, 0.48, 0.8];
                    material.alpha = 0.4;
                    mesh.material = material;
                } else if (primitive.kind === "lines") {
                    const lines: Vec3[][] = [];
                    for (let i = 0; i < primitive.positions.length; i += 6) {
                        lines.push([
                            { x: primitive.positions[i]!, y: primitive.positions[i + 1]!, z: primitive.positions[i + 2]! },
                            { x: primitive.positions[i + 3]!, y: primitive.positions[i + 4]!, z: primitive.positions[i + 5]! },
                        ]);
                    }
                    if (!lines.length) {
                        continue;
                    }
                    mesh = createLineSystem(engine, { lines, color: { r: 0.4, g: 0.8, b: 1, a: 1 } });
                } else {
                    continue;
                }
                mesh.position.y = 0.03;
                overlays.push(mesh);
                addToScene(scene, mesh);
            }
        }
        canvas.dataset.navState = "ready";
        canvas.dataset.navPoints = String(path.points.length);
        status.textContent = path.success
            ? `${path.complete ? "Complete" : "Partial"} route · ${path.points.length} points. Area 2 is the lower central passage.`
            : "No route: no passing polygon near an endpoint.";
        await registerScene(scene);
    }

    async function action(operation: () => Promise<void>): Promise<void> {
        for (const control of controls) {
            control.disabled = true;
        }
        try {
            await operation();
        } catch (error) {
            status.textContent = error instanceof Error ? error.message : String(error);
        } finally {
            for (const control of controls) {
                control.disabled = false;
            }
            for (const id of ["query", "replace", "dispose"]) {
                (document.getElementById(id) as HTMLButtonElement).disabled = manager === null;
            }
        }
    }
    for (const control of [startSelect, endSelect, filterSelect, debugToggle]) {
        control.addEventListener("change", () => {
            void action(query);
        });
    }
    document.getElementById("query")!.addEventListener("click", () => {
        void action(query);
    });
    document.getElementById("replace")!.addEventListener("click", () => {
        void action(async () => {
            if (manager) {
                replaceNavcatMesh(manager, json);
                await query();
            }
        });
    });
    document.getElementById("dispose")!.addEventListener("click", () => {
        void action(async () => {
            if (manager) {
                disposeNavcatManager(manager);
                manager = null;
            }
            clearOverlays();
            await registerScene(scene);
            canvas.dataset.navState = "disposed";
            canvas.dataset.navPoints = "0";
            status.textContent = "Backend disposed. Reload to create a fresh manager.";
        });
    });
    document.getElementById("reload")!.addEventListener("click", () => {
        void action(async () => {
            if (manager) {
                disposeNavcatManager(manager);
            }
            manager = await createNavcatManager(json);
            startSelect.value = "2";
            endSelect.value = "-2";
            filterSelect.value = "default";
            await query();
        });
    });
    await query();
    await startEngine(engine);
    canvas.dataset.ready = "true";
}

void main().catch((error: unknown) => {
    console.error(error);
    document.getElementById("status")!.textContent = error instanceof Error ? error.message : String(error);
    (document.getElementById("renderCanvas") as HTMLCanvasElement).dataset.error = "true";
});
