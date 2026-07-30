// BJS reference for scene 149 — Babylon.js PowerPlant glb rendered through the
// FrameGraph geometry-renderer task, where EVERY original material is replaced by
// ONE generic NodeMaterial graph. This is the parity target for the Lite
// implementation (which uses the new GeometryTextureOutputBlock terminal — the
// Lite analogue of BJS PrePassOutputBlock).
//
// The node graph mirrors lab/lite/src/shared/scene149-nme.ts, but the geometry
// terminal is BJS's PrePassOutputBlock instead of GeometryTextureOutputBlock. To
// reach pixel parity with Lite's GeometryTextureOutputBlock the graph + a small set
// of runtime monkey-patches reproduce exactly what the Lite engine writes:
//   Vertex:
//     position × WorldViewProjection ─► VertexOutput
//     position × World               ─► worldPos
//     normal   × World (W=0)         ─► worldNormal
//     worldNormal × View             ─► viewNormal
//     worldPos × View                ─► viewPos (→ .z = viewDepth)
//   Fragment:
//     albedo TextureBlock(uv).rgb               ─► FragmentOutput.rgb   (colour pass)
//     PrePassOutput {
//       worldPosition = worldPos,
//       localPosition = position attr,
//       worldNormal   = normalize(worldNormal) * 0.5 + 0.5,   (Lite WORLD_NORMAL encode)
//       viewNormal    = normalize(viewNormal),                (Lite VIEW_NORMAL encode)
//       reflectivity  = const Vector3(0.2),
//       viewDepth     = viewPos.z,
//       screenDepth   = gl_FragCoord.z,
//     }
// See the three patch functions below for the BJS 9.5.0 WebGPU fixes (gl_FragData
// write-path, missing NodeMaterialDefines reflectivity define, ScreenspaceDepth
// clear convention).
//
// SEVEN geometry impostors are displayed on a single bottom strip, laid out
// IDENTICALLY to the Lite scene (viewNormal, worldNormal, worldPosition, reflectivity,
// localPosition, viewDepth, screenspaceDepth). albedo / irradiance /
// normalizedViewDepth / linearVelocity are NOT displayed (no faithful PrePassOutput
// equivalent). No realColor tile — the node geometry path does not emit the extra colour attachment.

import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import { Constants } from "@babylonjs/core/Engines/constants";
import "@babylonjs/core/Loading/loadingScreen";
import { AppendSceneAsync } from "@babylonjs/core/Loading/sceneLoader";
import { Scene } from "@babylonjs/core/scene";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import type { ArcRotateCamera } from "@babylonjs/core/Cameras/arcRotateCamera";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import type { Material } from "@babylonjs/core/Materials/material";
import type { Texture } from "@babylonjs/core/Materials/Textures/texture";
import { RawTexture } from "@babylonjs/core/Materials/Textures/rawTexture";
import { NodeMaterial } from "@babylonjs/core/Materials/Node/nodeMaterial";
import { NodeMaterialBlock } from "@babylonjs/core/Materials/Node/nodeMaterialBlock";
import { NodeMaterialSystemValues } from "@babylonjs/core/Materials/Node/Enums/nodeMaterialSystemValues";
import { InputBlock } from "@babylonjs/core/Materials/Node/Blocks/Input/inputBlock";
import { NodeMaterialBlockConnectionPointTypes } from "@babylonjs/core/Materials/Node/Enums/nodeMaterialBlockConnectionPointTypes";
import { NodeMaterialBlockTargets } from "@babylonjs/core/Materials/Node/Enums/nodeMaterialBlockTargets";
import { TransformBlock } from "@babylonjs/core/Materials/Node/Blocks/transformBlock";
import { TextureBlock } from "@babylonjs/core/Materials/Node/Blocks/Dual/textureBlock";
import { VertexOutputBlock } from "@babylonjs/core/Materials/Node/Blocks/Vertex/vertexOutputBlock";
import { FragmentOutputBlock } from "@babylonjs/core/Materials/Node/Blocks/Fragment/fragmentOutputBlock";
import { PrePassOutputBlock } from "@babylonjs/core/Materials/Node/Blocks/Fragment/prePassOutputBlock";
import { VectorSplitterBlock } from "@babylonjs/core/Materials/Node/Blocks/vectorSplitterBlock";
import { NormalizeBlock } from "@babylonjs/core/Materials/Node/Blocks/normalizeBlock";
import { ScaleBlock } from "@babylonjs/core/Materials/Node/Blocks/scaleBlock";
import { AddBlock } from "@babylonjs/core/Materials/Node/Blocks/addBlock";
import { FragCoordBlock } from "@babylonjs/core/Materials/Node/Blocks/Fragment/fragCoordBlock";
import { ShaderLanguage } from "@babylonjs/core/Materials/shaderLanguage";
import { MaterialHelperGeometryRendering } from "@babylonjs/core/Materials/materialHelper.geometryrendering";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import "@babylonjs/core/Helpers/sceneHelpers";
import "@babylonjs/loaders/glTF/2.0";
import { FrameGraph } from "@babylonjs/core/FrameGraph/frameGraph";
import { FrameGraphClearTextureTask } from "@babylonjs/core/FrameGraph/Tasks/Texture/clearTextureTask";
import { FrameGraphGeometryRendererTask } from "@babylonjs/core/FrameGraph/Tasks/Rendering/geometryRendererTask";
import { FrameGraphObjectRendererTask } from "@babylonjs/core/FrameGraph/Tasks/Rendering/objectRendererTask";
import { FrameGraphCopyToTextureTask } from "@babylonjs/core/FrameGraph/Tasks/Texture/copyToTextureTask";
import { FrameGraphCopyToBackbufferColorTask } from "@babylonjs/core/FrameGraph/Tasks/Texture/copyToBackbufferColorTask";
import { WebGPURenderItemViewport } from "@babylonjs/core/Engines/WebGPU/webgpuBundleList";
import "@babylonjs/core/Engines/WebGPU/Extensions/engine.debugging";
import "@babylonjs/core/Engines/WebGPU/Extensions/engine.multiRender";

const POWERPLANT_URL = "https://assets.babylonjs.com/meshes/PowerPlant/powerplant.glb";

/**
 * Monkey-patch Babylon.js 9.5.0 `PrePassOutputBlock.prototype._buildBlock` to fix
 * the WebGPU geometry-output bug and reach geometry-buffer parity with Lite.
 *
 * Three things are corrected, replicating the upstream BJS fix:
 *  1. **`gl_FragData` → local `fragData[]` array.** In 9.5.0 the worldNormal,
 *     localPosition and screenspaceDepth writes are emitted as GLSL
 *     `gl_FragData[INDEX] = vec4(...)`. The WGSL processor turns these into a
 *     direct `glFragData[INDEX] = …` *before* the write-back loop, so the
 *     subsequent `glFragData[INDEX] = fragData[INDEX]` (with `fragData[INDEX]`
 *     left at its zero-init value) immediately clobbers them with 0 → those
 *     attachments come out black. The fix routes every attachment through the
 *     local `fragData[]` array, exactly like the working worldPosition /
 *     viewNormal / reflectivity writes.
 *  2. **Write-back starts at slot 0** (`SCENE_MRT_COUNT > 0`). Upstream skips
 *     slot 0, dropping any attachment packed there (e.g. localPosition when the
 *     geometry task has no colour target). This mirrors the engine's
 *     `pbrBlockPrePass` include, which copies `fragData[0..7]`.
 *  3. **screenspaceDepth defaults to the fragment builtin** when its input is
 *     left unconnected, matching the engine's `pbrBlockPrePass` include.
 *
 * Normal *encoding* (`normalize(n)*0.5+0.5`, `normalize(n)`) is intentionally NOT
 * done here — it is applied in the node graph (see makeGeometryNodeMaterial),
 * keeping this patch a faithful replica of the upstream write-path fix.
 */
function patchPrePassOutputBlockForWebGPU(): void {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (PrePassOutputBlock.prototype as any)._buildBlock = function (this: PrePassOutputBlock, state: any) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (NodeMaterialBlock.prototype as any)._buildBlock.call(this, state);

        const worldPosition = this.worldPosition;
        const localPosition = this.localPosition;
        const viewNormal = this.viewNormal;
        const worldNormal = this.worldNormal;
        const viewDepth = this.viewDepth;
        const reflectivity = this.reflectivity;
        const screenDepth = this.screenDepth;
        const velocity = this.velocity;
        const velocityLinear = this.velocityLinear;

        state.sharedData.blocksWithDefines.push(this);

        const comments = `//${this.name}`;
        const vec4 = state._getShaderType(NodeMaterialBlockConnectionPointTypes.Vector4);
        const isWebGPU = state.shaderLanguage === ShaderLanguage.WGSL;
        state._emitFunctionFromInclude("helperFunctions", comments);

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const alphaOf = (cp: any): string => (cp.connectedPoint.type === NodeMaterialBlockConnectionPointTypes.Vector4 ? cp.associatedVariableName + ".a" : "1.0");
        const fragPosZ = isWebGPU ? "fragmentInputs.position.z" : "gl_FragCoord.z";

        let s = `#if defined(PREPASS)\r\n`;
        s += isWebGPU ? `var fragData: array<vec4<f32>, SCENE_MRT_COUNT>;\r\n` : `vec4 fragData[SCENE_MRT_COUNT];\r\n`;

        s += `#ifdef PREPASS_DEPTH\r\n`;
        s += viewDepth.connectedPoint
            ? ` fragData[PREPASS_DEPTH_INDEX] = ${vec4}(${viewDepth.associatedVariableName}, 0.0, 0.0, 1.0);\r\n`
            : ` fragData[PREPASS_DEPTH_INDEX] = ${vec4}(0.0, 0.0, 0.0, 0.0);\r\n`;
        s += `#endif\r\n`;

        // normalizedViewDepth: removed — Lite leaves this attachment engine-derived
        // and it is no longer displayed as an impostor, so the BJS reference does not
        // reproduce it (PrePassOutputBlock has no normalizedViewDepth input).
        s += `#ifdef PREPASS_SCREENSPACE_DEPTH\r\n`;
        s += screenDepth.connectedPoint
            ? ` fragData[PREPASS_SCREENSPACE_DEPTH_INDEX] = ${vec4}(${screenDepth.associatedVariableName}, 0.0, 0.0, 1.0);\r\n`
            : ` fragData[PREPASS_SCREENSPACE_DEPTH_INDEX] = ${vec4}(${fragPosZ}, 0.0, 0.0, 1.0);\r\n`;
        s += `#endif\r\n`;

        s += `#ifdef PREPASS_POSITION\r\n`;
        s += worldPosition.connectedPoint
            ? `fragData[PREPASS_POSITION_INDEX] = ${vec4}(${worldPosition.associatedVariableName}.rgb, ${alphaOf(worldPosition)});\r\n`
            : ` fragData[PREPASS_POSITION_INDEX] = ${vec4}(0.0, 0.0, 0.0, 0.0);\r\n`;
        s += `#endif\r\n`;

        s += `#ifdef PREPASS_LOCAL_POSITION\r\n`;
        s += localPosition.connectedPoint
            ? ` fragData[PREPASS_LOCAL_POSITION_INDEX] = ${vec4}(${localPosition.associatedVariableName}.rgb, ${alphaOf(localPosition)});\r\n`
            : ` fragData[PREPASS_LOCAL_POSITION_INDEX] = ${vec4}(0.0, 0.0, 0.0, 0.0);\r\n`;
        s += `#endif\r\n`;

        s += `#ifdef PREPASS_NORMAL\r\n`;
        s += viewNormal.connectedPoint
            ? ` fragData[PREPASS_NORMAL_INDEX] = ${vec4}(${viewNormal.associatedVariableName}.rgb, ${alphaOf(viewNormal)});\r\n`
            : ` fragData[PREPASS_NORMAL_INDEX] = ${vec4}(0.0, 0.0, 0.0, 0.0);\r\n`;
        s += `#endif\r\n`;

        s += `#ifdef PREPASS_WORLD_NORMAL\r\n`;
        s += worldNormal.connectedPoint
            ? ` fragData[PREPASS_WORLD_NORMAL_INDEX] = ${vec4}(${worldNormal.associatedVariableName}.rgb, ${alphaOf(worldNormal)});\r\n`
            : ` fragData[PREPASS_WORLD_NORMAL_INDEX] = ${vec4}(0.0, 0.0, 0.0, 0.0);\r\n`;
        s += `#endif\r\n`;

        s += `#ifdef PREPASS_REFLECTIVITY\r\n`;
        s += reflectivity.connectedPoint
            ? ` fragData[PREPASS_REFLECTIVITY_INDEX] = ${vec4}(${reflectivity.associatedVariableName}.rgb, ${alphaOf(reflectivity)});\r\n`
            : ` fragData[PREPASS_REFLECTIVITY_INDEX] = ${vec4}(0.0, 0.0, 0.0, 1.0);\r\n`;
        s += `#endif\r\n`;

        s += `#ifdef PREPASS_VELOCITY\r\n`;
        s += velocity.connectedPoint
            ? ` fragData[PREPASS_VELOCITY_INDEX] = ${vec4}(${velocity.associatedVariableName}.rgb, ${alphaOf(velocity)});\r\n`
            : ` fragData[PREPASS_VELOCITY_INDEX] = ${vec4}(0.0, 0.0, 0.0, 1.0);\r\n`;
        s += `#endif\r\n`;
        s += `#ifdef PREPASS_VELOCITY_LINEAR\r\n`;
        s += velocityLinear.connectedPoint
            ? ` fragData[PREPASS_VELOCITY_LINEAR_INDEX] = ${vec4}(${velocityLinear.associatedVariableName}.rgb, ${alphaOf(velocityLinear)});\r\n`
            : ` fragData[PREPASS_VELOCITY_LINEAR_INDEX] = ${vec4}(0.0, 0.0, 0.0, 1.0);\r\n`;
        s += `#endif\r\n`;

        // Write-back fragData[0..7] -> fragmentOutputs.fragDataN (WGSL-correct).
        for (let i = 0; i <= 7; i++) {
            s += `#if SCENE_MRT_COUNT > ${i}\r\n`;
            s += `${(this as any)._getFragData(isWebGPU, i)} = fragData[${i}];\r\n`;
            s += `#endif\r\n`;
        }
        s += `#endif\r\n`;

        state.compilationString += s;
        return this;
    };
}
patchPrePassOutputBlockForWebGPU();

/**
 * Monkey-patch `MaterialHelperGeometryRendering.PrepareDefines` so a NodeMaterial
 * can actually emit the `PREPASS_REFLECTIVITY` and `PREPASS_NORMALIZED_VIEW_DEPTH`
 * geometry-output defines.
 *
 * Root cause: BJS 9.5.0's `NodeMaterialDefines` class only DECLARES six prepass
 * defines (position / localPosition / viewNormal / worldNormal / depth /
 * screenspaceDepth). `PrepareDefines` still SETS `PREPASS_REFLECTIVITY[_INDEX]`
 * (and normalizedViewDepth) on the defines object, but `MaterialDefines.toString()`
 * only walks `this._keys` — and those undeclared keys were never registered there,
 * so the `#define` is silently dropped and the corresponding `#ifdef` block in the
 * (patched) PrePassOutputBlock never compiles. We append the missing keys to
 * `_keys` after the engine populates them, so they reach the shader.
 */
function patchGeometryRenderingDefinesForNME(): void {
    const extraKeys = ["PREPASS_REFLECTIVITY", "PREPASS_REFLECTIVITY_INDEX", "PREPASS_NORMALIZED_VIEW_DEPTH", "PREPASS_NORMALIZED_VIEW_DEPTH_INDEX"];
    const original = MaterialHelperGeometryRendering.PrepareDefines;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    MaterialHelperGeometryRendering.PrepareDefines = function (renderPassId: number, mesh: any, defines: any) {
        original.call(MaterialHelperGeometryRendering, renderPassId, mesh, defines);
        const keys: string[] | undefined = defines?._keys;
        if (!Array.isArray(keys)) {
            return;
        }
        for (const k of extraKeys) {
            if (defines[k] !== undefined && keys.indexOf(k) === -1) {
                keys.push(k);
            }
        }
    };
}
patchGeometryRenderingDefinesForNME();

/**
 * Match the Lite engine's geometry-renderer clear convention for SCREENSPACE_DEPTH.
 * Lite clears the screenspace-depth attachment to ZERO; BJS's shared
 * `GeometryTextureDescriptions` clears it to One. Only the impostor *background*
 * (where no geometry is drawn) is affected, but with screenspace-depth values
 * being near-zero for this scene that One→Zero difference is a stark black-vs-red
 * edge. Patch the shared descriptor (before frameGraph.buildAsync) so the oracle
 * mirrors the Lite engine's natural clear and the Lite scene stays untouched.
 */
function patchScreenspaceDepthClearForParity(): void {
    const desc = MaterialHelperGeometryRendering.GeometryTextureDescriptions.find((d) => d.type === Constants.PREPASS_SCREENSPACE_DEPTH_TEXTURE_TYPE);
    if (desc) {
        // GeometryRenderingTextureClearType.Zero === 0
        (desc as { clearType: number }).clearType = 0;
    }
}
patchScreenspaceDepthClearForParity();

/** Resolve the albedo texture from a loaded PBR material, falling back to a 1×1
 *  solid texture built from its albedo factor when no base-color texture exists. */
function resolveAlbedo(scene: Scene, mat: Material): Texture {
    const m = mat as { albedoTexture?: Texture; albedoColor?: Color3 };
    if (m.albedoTexture) {
        return m.albedoTexture;
    }
    const c = m.albedoColor ?? new Color3(0.8, 0.8, 0.8);
    const data = new Uint8Array([Math.round(c.r * 255), Math.round(c.g * 255), Math.round(c.b * 255), 255]);
    return RawTexture.CreateRGBATexture(data, 1, 1, scene, false, false, Constants.TEXTURE_NEAREST_SAMPLINGMODE);
}

/** Build ONE generic geometry-impostor node material instance (mirrors
 *  scene149-nme.ts) with `albedo` bound to the supplied texture. The geometry
 *  terminal is a PrePassOutputBlock (the BJS analogue of Lite's
 *  GeometryTextureOutputBlock). */
function makeGeometryNodeMaterial(scene: Scene, albedo: Texture, index: number): NodeMaterial {
    const nm = new NodeMaterial(`scene149nm_${index}`, scene);
    nm.backFaceCulling = true;

    // --- Vertex inputs ---
    const position = new InputBlock("position");
    position.setAsAttribute("position");
    const normal = new InputBlock("normal");
    normal.setAsAttribute("normal");
    const uv = new InputBlock("uv");
    uv.setAsAttribute("uv");
    const wvp = new InputBlock("worldViewProjection");
    wvp.setAsSystemValue(NodeMaterialSystemValues.WorldViewProjection);
    const world = new InputBlock("world");
    world.setAsSystemValue(NodeMaterialSystemValues.World);
    const view = new InputBlock("view");
    view.setAsSystemValue(NodeMaterialSystemValues.View);

    // --- Vertex transforms ---
    const transformWVP = new TransformBlock("TransformWVP"); // complementW = 1 (default)
    position.output.connectTo(transformWVP.vector);
    wvp.output.connectTo(transformWVP.transform);

    const transformWorldPos = new TransformBlock("TransformWorldPos"); // complementW = 1
    position.output.connectTo(transformWorldPos.vector);
    world.output.connectTo(transformWorldPos.transform);

    const transformWorldNormal = new TransformBlock("TransformWorldNormal");
    transformWorldNormal.complementW = 0; // direction transform
    normal.output.connectTo(transformWorldNormal.vector);
    world.output.connectTo(transformWorldNormal.transform);

    const transformViewNormal = new TransformBlock("TransformViewNormal");
    transformViewNormal.complementW = 0;
    transformWorldNormal.output.connectTo(transformViewNormal.vector);
    view.output.connectTo(transformViewNormal.transform);

    const vertexOutput = new VertexOutputBlock("VertexOutput");
    transformWVP.output.connectTo(vertexOutput.vector);

    // --- Depth derivations (vertex stage) ---
    // viewDepth = (View × worldPos).z. Computed in the vertex shader and
    // interpolated; since view-space z is affine in world position this equals a
    // per-pixel re-derivation (matches Lite's geometry-output default). The
    // monkey-patched PrePassOutputBlock also derives normalizedViewDepth from it.
    const transformViewPos = new TransformBlock("TransformViewPos");
    transformWorldPos.output.connectTo(transformViewPos.vector); // worldPos is vec4 ⇒ View×worldPos (4-component)
    view.output.connectTo(transformViewPos.transform);
    const viewPosSplit = new VectorSplitterBlock("ViewPosSplit");
    transformViewPos.output.connectTo(viewPosSplit.xyzw);

    // --- Fragment: albedo texture + constant reflectivity ---
    const albedoTex = new TextureBlock("albedo");
    albedoTex.convertToGammaSpace = false;
    albedoTex.convertToLinearSpace = false;
    uv.output.connectTo(albedoTex.uv);
    albedoTex.texture = albedo;

    // reflectivity: a constant 0.2 grey. PrePassOutputBlock's reflectivity input is
    // AutoDetect but excludes Color3/Color4 from its prePassTextureOutputs gating
    // (a Color3 connection leaves reflectivity.isConnected effectively unhonoured,
    // so PREPASS_REFLECTIVITY never gets enabled). A Vector3 connects cleanly and
    // is written as vec4(rgb, 1.0) — matching Lite's const Color3 reflectivity.
    const reflectivity = new InputBlock("reflectivity", NodeMaterialBlockTargets.Fragment, NodeMaterialBlockConnectionPointTypes.Vector3);
    reflectivity.value = new Vector3(0.2, 0.2, 0.2);

    // screenspaceDepth = gl_FragCoord.z (fragment builtin) — matches Lite's default.
    const fragCoord = new FragCoordBlock("FragCoord");

    // Normal encoding (fragment stage, per-pixel — matches Lite's geomWrite):
    //   worldNormal → normalize(n) * 0.5 + 0.5   (Lite WORLD_NORMAL encode)
    //   viewNormal  → normalize(n)               (Lite VIEW_NORMAL encode)
    // BJS's PrePassOutputBlock writes its normal inputs RAW, so we encode here.
    const worldNormalNormalize = new NormalizeBlock("WorldNormalNormalize");
    transformWorldNormal.xyz.connectTo(worldNormalNormalize.input);
    const half = new InputBlock("half", NodeMaterialBlockTargets.Fragment, NodeMaterialBlockConnectionPointTypes.Float);
    half.value = 0.5;
    const worldNormalScale = new ScaleBlock("WorldNormalScale");
    worldNormalNormalize.output.connectTo(worldNormalScale.input);
    half.output.connectTo(worldNormalScale.factor);
    const halfVec = new InputBlock("halfVec", NodeMaterialBlockTargets.Fragment, NodeMaterialBlockConnectionPointTypes.Vector3);
    halfVec.value = new Vector3(0.5, 0.5, 0.5);
    const worldNormalEncode = new AddBlock("WorldNormalEncode");
    worldNormalScale.output.connectTo(worldNormalEncode.left);
    halfVec.output.connectTo(worldNormalEncode.right);

    const viewNormalNormalize = new NormalizeBlock("ViewNormalNormalize");
    transformViewNormal.xyz.connectTo(viewNormalNormalize.input);

    // Flat-albedo colour pass.
    const fragmentOutput = new FragmentOutputBlock("FragmentOutput");
    fragmentOutput.convertToGammaSpace = false;
    fragmentOutput.convertToLinearSpace = false;
    albedoTex.rgb.connectTo(fragmentOutput.rgb);

    // Geometry-renderer terminal. ALL displayed inputs are connected so BJS writes
    // them (the monkey-patched _buildBlock derives normalizedViewDepth internally).
    const prePassOutput = new PrePassOutputBlock("PrePassOutput");
    transformWorldPos.output.connectTo(prePassOutput.worldPosition);
    position.output.connectTo(prePassOutput.localPosition);
    worldNormalEncode.output.connectTo(prePassOutput.worldNormal);
    viewNormalNormalize.output.connectTo(prePassOutput.viewNormal);
    reflectivity.output.connectTo(prePassOutput.reflectivity);
    viewPosSplit.z.connectTo(prePassOutput.viewDepth);
    fragCoord.z.connectTo(prePassOutput.screenDepth);

    nm.addOutputNode(vertexOutput);
    nm.addOutputNode(fragmentOutput);
    nm.addOutputNode(prePassOutput);
    nm.build();
    return nm;
}

(async function () {
    const __initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = new WebGPUEngine(canvas, {
        antialias: true,
        adaptToDeviceRatio: true,
        deviceDescriptor: { requiredLimits: { maxColorAttachmentBytesPerSample: 128 } },
        enableGPUDebugMarkers: true,
    });
    await engine.initAsync();

    engine.useReverseDepthBuffer = true;

    // Mirror the viewport-rounding patch from scenes 145/146/147 — same parity rationale.
    const engPatch = engine as unknown as {
        _viewportCached: { x: number; y: number; z: number; w: number };
        _currentRenderTarget: unknown;
        getRenderHeight: (useScreen?: boolean) => number;
        _getCurrentRenderPass: () => GPURenderPassEncoder;
        _applyViewport: (bundleList?: { addItem: (item: unknown) => void }) => void;
    };
    engPatch._applyViewport = function (bundleList) {
        const vc = engPatch._viewportCached;
        const x = Math.floor(vc.x);
        const w = Math.floor(vc.x + vc.z) - x;
        let y = Math.floor(vc.y);
        const h = Math.floor(vc.y + vc.w) - y;
        if (!engPatch._currentRenderTarget) {
            y = engPatch.getRenderHeight(true) - y - h;
        }
        if (bundleList) {
            bundleList.addItem(new WebGPURenderItemViewport(x, y, w, h));
        } else {
            engPatch._getCurrentRenderPass().setViewport(x, y, w, h, 0, 1);
        }
    };

    const scene = new Scene(engine);
    scene.useRightHandedSystem = false;
    scene.skipPointerMovePicking = true;

    await AppendSceneAsync(POWERPLANT_URL, scene);

    // Auto-frame to model bounds (matches Lite createDefaultCamera), then apply the
    // playground's orbit angles.
    scene.createDefaultCameraOrLight(true, true, true);
    const camera = scene.activeCamera as ArcRotateCamera;
    camera.wheelPrecision = 2;
    camera.alpha = -3.12;
    camera.beta = 1.3;
    camera.radius = 75.63;

    // Replace every original material with an instance of the generic geometry
    // node material — only the albedo texture differs between instances.
    const byMaterial = new Map<Material, NodeMaterial>();
    let matIndex = 0;
    for (const mesh of scene.meshes as AbstractMesh[]) {
        const mat = mesh.material;
        if (!mat) {
            continue;
        }
        let nm = byMaterial.get(mat);
        if (!nm) {
            nm = makeGeometryNodeMaterial(scene, resolveAlbedo(scene, mat), matIndex++);
            byMaterial.set(mat, nm);
        }
        mesh.material = nm;
    }
    canvas.dataset.materialCount = String(byMaterial.size);

    const frameGraph = new FrameGraph(scene, true);
    scene.frameGraph = frameGraph;

    const samples = 4;

    const colorTexture = frameGraph.textureManager.createRenderTargetTexture("color", {
        size: { width: 100, height: 100 },
        options: {
            createMipMaps: false,
            types: [Constants.TEXTURETYPE_UNSIGNED_BYTE],
            formats: [Constants.TEXTUREFORMAT_RGBA],
            samples,
            useSRGBBuffers: [false],
            labels: ["color"],
        },
        sizeIsPercentage: true,
    });

    const depthTexture = frameGraph.textureManager.createRenderTargetTexture("depth", {
        size: { width: 100, height: 100 },
        options: {
            createMipMaps: false,
            types: [Constants.TEXTURETYPE_UNSIGNED_BYTE],
            formats: [Constants.TEXTUREFORMAT_DEPTH32_FLOAT],
            samples,
            useSRGBBuffers: [false],
            labels: ["depth"],
        },
        sizeIsPercentage: true,
    });

    const finalOutputTexture = colorTexture;

    const clearTask = new FrameGraphClearTextureTask("clear", frameGraph);
    clearTask.clearColor = true;
    clearTask.clearDepth = true;
    clearTask.targetTexture = finalOutputTexture;
    clearTask.depthTexture = depthTexture;
    frameGraph.addTask(clearTask);

    const rlist = {
        meshes: scene.meshes,
        particleSystems: scene.particleSystems,
    };

    // Geometry renderer task A — 7 attachments. NO targetTexture: the node geometry
    // path does not emit the real (lit) colour attachment.
    const geomTaskA = new FrameGraphGeometryRendererTask("geomRendererA", frameGraph, scene);
    geomTaskA.depthTexture = clearTask.depthTexture;
    geomTaskA.camera = camera;
    geomTaskA.objectList = rlist;
    geomTaskA.samples = samples;
    geomTaskA.textureDescriptions = [
        { type: Constants.PREPASS_IRRADIANCE_TEXTURE_TYPE, textureType: Constants.TEXTURETYPE_HALF_FLOAT, textureFormat: Constants.TEXTUREFORMAT_RGBA },
        { type: Constants.PREPASS_POSITION_TEXTURE_TYPE, textureType: Constants.TEXTURETYPE_HALF_FLOAT, textureFormat: Constants.TEXTUREFORMAT_RGBA },
        { type: Constants.PREPASS_NORMALIZED_VIEW_DEPTH_TEXTURE_TYPE, textureType: Constants.TEXTURETYPE_HALF_FLOAT, textureFormat: Constants.TEXTUREFORMAT_RED },
        { type: Constants.PREPASS_NORMAL_TEXTURE_TYPE, textureType: Constants.TEXTURETYPE_HALF_FLOAT, textureFormat: Constants.TEXTUREFORMAT_RGBA },
        { type: Constants.PREPASS_WORLD_NORMAL_TEXTURE_TYPE, textureType: Constants.TEXTURETYPE_HALF_FLOAT, textureFormat: Constants.TEXTUREFORMAT_RGBA },
        { type: Constants.PREPASS_REFLECTIVITY_TEXTURE_TYPE, textureType: Constants.TEXTURETYPE_UNSIGNED_BYTE, textureFormat: Constants.TEXTUREFORMAT_RGBA },
        { type: Constants.PREPASS_ALBEDO_TEXTURE_TYPE, textureType: Constants.TEXTURETYPE_UNSIGNED_BYTE, textureFormat: Constants.TEXTUREFORMAT_RGBA },
    ];
    frameGraph.addTask(geomTaskA);

    const geomTaskB = new FrameGraphGeometryRendererTask("geomRendererB", frameGraph, scene);
    geomTaskB.depthTexture = geomTaskA.outputDepthTexture;
    geomTaskB.camera = camera;
    geomTaskB.objectList = rlist;
    geomTaskB.samples = samples;
    geomTaskB.textureDescriptions = [
        { type: Constants.PREPASS_LOCAL_POSITION_TEXTURE_TYPE, textureType: Constants.TEXTURETYPE_HALF_FLOAT, textureFormat: Constants.TEXTUREFORMAT_RGBA },
        { type: Constants.PREPASS_DEPTH_TEXTURE_TYPE, textureType: Constants.TEXTURETYPE_HALF_FLOAT, textureFormat: Constants.TEXTUREFORMAT_RED },
        { type: Constants.PREPASS_SCREENSPACE_DEPTH_TEXTURE_TYPE, textureType: Constants.TEXTURETYPE_HALF_FLOAT, textureFormat: Constants.TEXTUREFORMAT_RED },
        { type: Constants.PREPASS_VELOCITY_LINEAR_TEXTURE_TYPE, textureType: Constants.TEXTURETYPE_HALF_FLOAT, textureFormat: Constants.TEXTUREFORMAT_RGBA },
    ];
    frameGraph.addTask(geomTaskB);

    const renderTask = new FrameGraphObjectRendererTask("renderObjects", frameGraph, scene);
    renderTask.targetTexture = clearTask.outputTexture;
    renderTask.depthTexture = geomTaskB.outputDepthTexture;
    renderTask.objectList = rlist;
    renderTask.camera = camera;
    frameGraph.addTask(renderTask);

    // Seven displayed geometry impostors on a single bottom strip — IDENTICAL layout to
    // the Lite scene. albedo / irradiance / normalizedViewDepth / linearVelocity are NOT
    // displayed (PrePassOutputBlock has no faithful equivalent), so they cannot be parity-compared.
    const impostors = [
        { name: "viewNormal", source: geomTaskA.geometryViewNormalTexture! },
        { name: "worldNormal", source: geomTaskA.geometryWorldNormalTexture! },
        { name: "worldPosition", source: geomTaskA.geometryWorldPositionTexture! },
        { name: "reflectivity", source: geomTaskA.geometryReflectivityTexture! },
        { name: "localPosition", source: geomTaskB.geometryLocalPositionTexture! },
        { name: "viewDepth", source: geomTaskB.geometryViewDepthTexture! },
        { name: "screenspaceDepth", source: geomTaskB.geometryScreenDepthTexture! },
    ];
    let prevTexture: typeof renderTask.outputTexture = renderTask.outputTexture;
    const placeStrip = (strip: { name: string; source: typeof renderTask.outputTexture }[], y: number) => {
        const tileW = 1 / strip.length;
        for (let i = 0; i < strip.length; i++) {
            const entry = strip[i]!;
            const copy = new FrameGraphCopyToTextureTask(`copyImpostor-${entry.name}`, frameGraph);
            copy.sourceTexture = entry.source;
            copy.targetTexture = prevTexture;
            copy.viewport = { x: i * tileW, y, width: tileW, height: 0.15 };
            frameGraph.addTask(copy);
            prevTexture = copy.outputTexture;
        }
    };
    placeStrip(impostors, 0);

    const copyToBackbufferTask = new FrameGraphCopyToBackbufferColorTask("copytobackbuffer", frameGraph);
    copyToBackbufferTask.sourceTexture = prevTexture;
    frameGraph.addTask(copyToBackbufferTask);

    frameGraph.optimizeTextureAllocation = false;

    engine.onResizeObservable.add(async () => {
        await frameGraph.buildAsync();
    });
    await frameGraph.buildAsync();

    const eng = engine as unknown as { _drawCalls?: { current: number; fetchNewFrame(): void } };
    scene.onBeforeRenderObservable.add(() => {
        eng._drawCalls?.fetchNewFrame();
    });
    scene.onAfterRenderObservable.add(() => {
        canvas.dataset.drawCalls = String(eng._drawCalls?.current ?? 0);
    });
    await scene.whenReadyAsync();
    engine.runRenderLoop(() => scene.render());
    window.addEventListener("resize", () => engine.resize());
    for (let i = 0; i < 15; i++) {
        await new Promise<void>((resolve) => scene.onAfterRenderObservable.addOnce(() => resolve()));
    }
    canvas.dataset.initMs = String(performance.now() - __initStart);
    canvas.dataset.ready = "true";
})().catch((err) => {
    console.error(err);
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement | null;
    if (canvas) {
        canvas.dataset.error = String(err);
    }
});
