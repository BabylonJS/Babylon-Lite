import { onBeforeRender, addToScene, startEngine, createEngine, createSceneContext, createArcRotateCamera, createDirectionalLight, cloneTransformNode, attachControl, loadGltf, loadEnvironment, loadTexture2D, createPbrMaterial, createSolidTexture2D, goToFrame, registerScene } from "babylon-lite";
import type { TransformNode } from "babylon-lite";
import type { ArcRotateCamera } from "babylon-lite";

export async function scene12(canvas: HTMLCanvasElement): Promise<void> {
    const __initStart = performance.now();
    const engine = await createEngine(canvas);
    const scene = createSceneContext(engine);
    scene.clearColor = { r: 20 / 255, g: 20 / 255, b: 25 / 255, a: 1.0 };

    // Camera — BJS ArcRotateCamera(PI/2, PI/2, 15, (0,0,0))
    scene.camera = createArcRotateCamera(Math.PI / 2, Math.PI / 2, 15, { x: 0, y: 0, z: 0 });
    scene.camera.nearPlane = 0.1;
    attachControl(scene.camera as ArcRotateCamera, canvas, scene);

    // Directional light — direction points FROM light (BJS convention)
    const light = createDirectionalLight([0.45, -0.34, -0.83]);
    addToScene(scene, light);

    // Environment — Studio Softbox with rotationY=1.9
    await loadEnvironment(scene, "/textures/Studio_Softbox_2Umbrellas_cube_specular.env", {
        skipSkybox: true,
        skipGround: true,
        brdfUrl: "/brdf-lut.png",
    });
    scene.envRotationY = 1.9;

    // Load shader ball mesh — auto-added as middle row
    const result = await loadGltf(engine, "https://assets.babylonjs.com/meshes/Demos/pbr_mr_specular/shaderBall_rotation.glb");
    addToScene(scene, result);
    const root = result.entities[0] as TransformNode;

    // Load reflectance textures (no mipmaps — textures are small)
    const [reflectanceTex, metallicReflectanceTex] = await Promise.all([
        loadTexture2D(engine, "https://assets.babylonjs.com/meshes/Demos/pbr_mr_specular/reflectanceColorTex.png", {
            mipMaps: false,
            invertY: false,
        }),
        loadTexture2D(engine, "https://assets.babylonjs.com/meshes/Demos/pbr_mr_specular/metallicReflectanceTex.png", {
            mipMaps: false,
            invertY: false,
        }),
    ]);

    // albedoColor = Color3.FromInts(50,50,50).toLinearSpace() → pow(50/255, 2.2) ≈ 0.0313
    const albedoLinear = Math.pow(50 / 255, 2.2);
    const baseColorTex = createSolidTexture2D(engine, albedoLinear, albedoLinear, albedoLinear, 1.0);

    // ORM: metallic=0, roughness=0.15, occlusion=1
    const ormTex = createSolidTexture2D(engine, 1.0, 0.15, 0.0, 1.0);

    // metallicReflectanceColor = Color3.FromInts(255,250,250).toLinearSpace()
    const mrcR = Math.pow(255 / 255, 2.2);
    const mrcG = Math.pow(250 / 255, 2.2);
    const mrcB = Math.pow(250 / 255, 2.2);

    function makeMat(opts: { metallicReflectanceTex?: typeof metallicReflectanceTex; reflectanceTex?: typeof reflectanceTex; useOnlyMetallic?: boolean }) {
        return createPbrMaterial({
            baseColorTexture: baseColorTex,
            ormTexture: ormTex,
            occlusionStrength: 0.0,
            metallicF0Factor: 0.95,
            metallicReflectanceColor: [mrcR, mrcG, mrcB],
            metallicReflectanceTexture: opts.metallicReflectanceTex,
            reflectanceTexture: opts.reflectanceTex,
            useOnlyMetallicFromMetallicReflectanceTexture: opts.useOnlyMetallic,
        });
    }

    const matUpper = makeMat({ metallicReflectanceTex: metallicReflectanceTex });
    const matMiddle = makeMat({ reflectanceTex: reflectanceTex });
    const matLower = makeMat({
        metallicReflectanceTex: metallicReflectanceTex,
        reflectanceTex: reflectanceTex,
        useOnlyMetallic: true,
    });

    // Helper: assign material to all meshes in a TransformNode tree
    function setMaterial(node: TransformNode, mat: typeof matUpper): void {
        for (const child of node.children) {
            if ("children" in child && "rotationQuaternion" in child && !("_gpu" in child)) {
                setMaterial(child as TransformNode, mat);
            } else {
                (child as any).material = mat;
            }
        }
    }

    // Middle row: original hierarchy (already added by loadGltf)
    setMaterial(root, matMiddle);

    // Upper row: clone + offset Y
    const upper = cloneTransformNode(root);
    upper.position.y = 3;
    setMaterial(upper, matUpper);
    addToScene(scene, upper);

    // Lower row: clone + offset Y
    const lower = cloneTransformNode(root);
    lower.position.y = -3;
    setMaterial(lower, matLower);
    addToScene(scene, lower);

    // Fixed timestep for deterministic animation (matches BJS useConstantAnimationDeltaTime)
    scene.fixedDeltaMs = 16.0;

    // Freeze animation for parity tests (triggered by ?seekTime query param)
    const params = new URLSearchParams(window.location.search);
    const seekTimeParam = parseFloat(params.get("seekTime") || "");
    let frameCount = 0;
    let seekDone = false;
    onBeforeRender(scene, () => {
        frameCount++;
        if (!isNaN(seekTimeParam) && seekTimeParam > 0 && frameCount === 10 && !seekDone) {
            const seekFrame = seekTimeParam * 60;
            for (const g of scene.animationGroups) {
                goToFrame(g, seekFrame);
            }
            seekDone = true;
            canvas.dataset.animationFrozen = "true";
        }
    });

    await registerScene(engine, scene);
    await startEngine(engine);
    canvas.dataset.drawCalls = String(engine.drawCallCount);
    canvas.dataset.initMs = String(performance.now() - __initStart);
    canvas.dataset.ready = "true";
}

// Auto-run
const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
if (canvas) {
    void scene12(canvas);
}
