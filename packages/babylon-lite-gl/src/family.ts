/**
 * Backend-neutral contract for the Lite GL backends.
 *
 * A {@link GLFamily} names the resource and data types of one backend, and
 * {@link GLOps} describes every backend-neutral operation over a family. A
 * consumer selects the operations it uses with {@link GLKit}, fills the kit with
 * a backend entry's exported functions in its composition root, and writes
 * shared code against the kit. The contract is types only and references no
 * browser or native host type.
 *
 * @packageDocumentation
 */

/** Inputs to `createEffect`: shader sources plus the uniform, sampler and
 *  attribute names the effect resolves. */
export interface GLEffectOptions {
    /** Human-readable label, surfaced in compile/link error messages. */
    name: string;
    /** GLSL ES 3.00 vertex source. */
    vertexSource: string;
    /** GLSL ES 3.00 fragment source. */
    fragmentSource: string;
    /** Declared uniform names. Portable code sets only these; native ignores
     *  undeclared names, and only some web setters resolve them lazily. */
    uniformNames: readonly string[];
    /** Declared sampler names, in texture-unit assignment order. */
    samplerNames: readonly string[];
    /** Default `["position"]`. The first attribute is bound to location 0, so
     *  shared quad geometry always feeds the same location. */
    attributeNames?: readonly string[];
    /** Optional `#define` block placed ahead of both sources. Each distinct
     *  block needs its own `createEffect` call. */
    defines?: string;
}

/** Pixel-space viewport rectangle passed to `setViewport`. */
export interface GLViewport {
    /** Lower-left X origin in physical pixels. */
    x: number;
    /** Lower-left Y origin in physical pixels. */
    y: number;
    /** Width in physical pixels. */
    w: number;
    /** Height in physical pixels. */
    h: number;
}

/** Options for `clearEngine`. */
export interface GLClearOptions {
    /** When set, clears the color buffer to this RGBA color (alpha default 1). */
    color?: { r: number; g: number; b: number; a?: number };
    /** Clear the depth buffer. */
    depth?: boolean;
    /** Clear the stencil buffer. */
    stencil?: boolean;
}

/** What backend-neutral code may read from any backend's texture. */
export interface GLFamilyTexture {
    /** Texture width in texels. */
    readonly width: number;
    /** Texture height in texels. */
    readonly height: number;
    /** Whether the texture holds its final content and is safe to sample. */
    readonly isReady: boolean;
}

/** What backend-neutral code may read from any backend's render target. */
export interface GLFamilyRenderTarget<Texture> {
    /** Color attachment width in texels. */
    readonly width: number;
    /** Color attachment height in texels. */
    readonly height: number;
    /** The color attachment, sampleable like any other texture of the family. */
    readonly texture: Texture;
}

/** The vertex attribute fields backend-neutral code may read. */
export interface GLFamilyAttributeDescriptor {
    /** Shader attribute name. */
    readonly name?: string;
    /** Number of float components, 1–4. */
    readonly size: number;
    /** Byte offset of the attribute's first element within its buffer. */
    readonly offset?: number;
    /** Per-instance divisor; `0` marks a per-vertex attribute and is listed so
     *  shared code's per-vertex literals keep that type. */
    readonly divisor?: 0 | (number & {});
}

/** A per-vertex attribute every backend accepts from backend-neutral code. */
export interface GLPortableAttributeDescriptor {
    /** Shader attribute name. */
    readonly name: string;
    /** Number of float components, 1–4. */
    readonly size: number;
    /** Byte offset of the attribute's first element within its buffer. */
    readonly offset?: number;
    /** Per-vertex. */
    readonly divisor: 0;
}

/** A vertex buffer and the attributes a mesh reads from it. */
export interface GLFamilyMeshVertexBuffer<VertexBuffer, AttributeDescriptor> {
    /** The buffer supplying the attributes. */
    buffer: VertexBuffer;
    /** The attributes read from `buffer`. */
    attributes: readonly AttributeDescriptor[];
    /** Whether the attributes are interleaved with a computed stride. */
    computeStride?: boolean;
}

/**
 * Values backend-neutral code may supply for the {@link GLFamily} slots that
 * have them. Every backend that implements a slot accepts its value here.
 */
export interface GLFamilyPortableValues {
    /** Non-instanced draws. */
    readonly instanceCount: 0;
    /** Vertex buffers created from their data alone. */
    readonly vertexBufferArgs: [];
    /** Float matrix and array uniform inputs. */
    readonly floatArray: Float32Array | number[];
    /** RGBA8 pixel data. */
    readonly rawTextureData: Uint8Array;
    /** Per-vertex attributes. */
    readonly attributeDescriptor: GLPortableAttributeDescriptor;
    /** Blend presets, numbered as Babylon's `ALPHA_DISABLE`, `ALPHA_ADD`, `ALPHA_COMBINE` and `ALPHA_PREMULTIPLIED`. */
    readonly blendMode: 0 | 1 | 2 | 7;
}

/**
 * The resource and data types of one Lite GL backend.
 *
 * A slot's getter type is the bound every backend's type must satisfy and all
 * that backend-neutral code may read from it. Its setter type is what
 * backend-neutral code may supply for it: the slot's
 * {@link GLFamilyPortableValues} member, or `never` when its values come only
 * from the backend's operations or from a composition root that knows the
 * backend. A backend maps the slots it does not implement to `never`.
 */
export interface GLFamily {
    /** Engine context created by the backend's host operations. */
    get engine(): object;
    set engine(value: never);
    /** Compiled shader program. */
    get effect(): object;
    set effect(value: never);
    /** Fullscreen-quad effect wrapper. */
    get effectWrapper(): object;
    set effectWrapper(value: never);
    /** Sampled 2D texture. */
    get texture(): GLFamilyTexture;
    set texture(value: never);
    /** Sampled 3D texture. */
    get texture3D(): object;
    set texture3D(value: never);
    /** Offscreen color target; backend-neutral code names it {@link GLRenderTargetOf}. */
    get renderTarget(): GLFamilyRenderTarget<GLFamilyTexture>;
    set renderTarget(value: never);
    /** Float vertex storage. */
    get vertexBuffer(): object;
    set vertexBuffer(value: never);
    /** Index storage. */
    get indexBuffer(): object;
    set indexBuffer(value: never);
    /** Recorded mesh geometry. */
    get meshVao(): object;
    set meshVao(value: never);
    /** Batched sprite renderer. */
    get spriteRenderer(): object;
    set spriteRenderer(value: never);
    /** Parsed font. */
    get font(): object;
    set font(value: never);
    /** Glyph outlines and their atlases. */
    get glyphStorage(): object;
    set glyphStorage(value: never);
    /** Positioned glyph runs. */
    get textData(): object;
    set textData(value: never);
    /** Single-font text data with default layout. */
    get defaultTextData(): object;
    set defaultTextData(value: never);
    /** Positioned instance of text data. */
    get textLayer(): object;
    set textLayer(value: never);
    /** Text layer renderer. */
    get textRenderer(): object;
    set textRenderer(value: never);
    /** GPU frame-time statistics. */
    get perfCounter(): object;
    set perfCounter(value: never);
    /** Value that unbinds a sampler, or `never` when samplers cannot be unbound. */
    get noTexture(): null;
    set noTexture(value: never);
    /** Instance counts the backend's draws accept. */
    get instanceCount(): number;
    set instanceCount(value: GLFamilyPortableValues["instanceCount"]);
    /** Trailing `createVertexBuffer` arguments after the data. */
    get vertexBufferArgs(): readonly unknown[];
    set vertexBufferArgs(value: GLFamilyPortableValues["vertexBufferArgs"]);
    /** Float matrix and array uniform inputs. */
    get floatArray(): ArrayLike<number>;
    set floatArray(value: GLFamilyPortableValues["floatArray"]);
    /** Pixel data for raw texture uploads. */
    get rawTextureData(): ArrayBufferView | null;
    set rawTextureData(value: GLFamilyPortableValues["rawTextureData"]);
    /** `createRawTexture` options. */
    get rawTextureOptions(): unknown;
    set rawTextureOptions(value: never);
    /** Options shared by texture factories. */
    get textureOptions(): unknown;
    set textureOptions(value: never);
    /** `createRenderTarget` options. */
    get renderTargetOptions(): unknown;
    set renderTargetOptions(value: never);
    /** One vertex attribute read by a mesh or attribute binding. */
    get attributeDescriptor(): GLFamilyAttributeDescriptor;
    set attributeDescriptor(value: GLFamilyPortableValues["attributeDescriptor"]);
    /** Blend preset value. */
    get blendMode(): number;
    set blendMode(value: GLFamilyPortableValues["blendMode"]);
    /** `waitForEffect` options. */
    get effectWaitOptions(): unknown;
    set effectWaitOptions(value: never);
    /** `createEffectWrapper` options. */
    get effectWrapperOptions(): unknown;
    set effectWrapperOptions(value: never);
    /** Per-update texture options. */
    get textureUpdateOptions(): unknown;
    set textureUpdateOptions(value: never);
    /** `createFloatTexture` options. */
    get floatTextureOptions(): unknown;
    set floatTextureOptions(value: never);
    /** Sampling preset value. */
    get samplingMode(): number;
    set samplingMode(value: never);
    /** Filters resolved from a sampling preset. */
    get samplingFilters(): unknown;
    set samplingFilters(value: never);
    /** `createTexture3DFromPixels` options. */
    get texture3DOptions(): unknown;
    set texture3DOptions(value: never);
    /** `createFloatRenderTarget` options. */
    get floatRenderTargetOptions(): unknown;
    set floatRenderTargetOptions(value: never);
    /** `readRenderTargetPixels` options. */
    get readPixelsOptions(): unknown;
    set readPixelsOptions(value: never);
    /** Explicit blend state. */
    get blendState(): unknown;
    set blendState(value: never);
    /** Depth state. */
    get depthState(): unknown;
    set depthState(value: never);
    /** Stencil state. */
    get stencilState(): unknown;
    set stencilState(value: never);
    /** One face's stencil operations. */
    get stencilOpState(): unknown;
    set stencilOpState(value: never);
    /** `createSpriteRenderer` options. */
    get spriteRendererOptions(): unknown;
    set spriteRendererOptions(value: never);
    /** One sprite instance. */
    get sprite(): unknown;
    set sprite(value: never);
    /** One glyph's outline curves. */
    get glyphCurves(): unknown;
    set glyphCurves(value: never);
    /** One quadratic curve segment. */
    get quadCurve(): unknown;
    set quadCurve(value: never);
    /** One run of glyphs sharing a curve set. */
    get glyphRun(): unknown;
    set glyphRun(value: never);
    /** Partial update applied to text data. */
    get textDataUpdate(): unknown;
    set textDataUpdate(value: never);
    /** Text layout options. */
    get textLayoutOptions(): unknown;
    set textLayoutOptions(value: never);
    /** `createTextLayer` options. */
    get textLayerOptions(): unknown;
    set textLayerOptions(value: never);
    /** `createTextRenderer` options. */
    get textRendererOptions(): unknown;
    set textRendererOptions(value: never);
}

/**
 * Family `F`'s render target, whose color attachment is `F`'s texture.
 * Backend-neutral code names render targets with this type rather than
 * `F["renderTarget"]`, so a target's texture can be sampled through the same
 * family.
 */
export type GLRenderTargetOf<F extends GLFamily> = [F] extends [{ readonly renderTarget: infer R extends GLFamilyRenderTarget<F["texture"]> }] ? R : never;

/**
 * Every backend-neutral Lite GL operation over the family `F`.
 *
 * Each member has the semantics of the identically named export of the
 * backend entries. Instantiated with a backend's family, every member that
 * backend exports matches its exported signature exactly.
 */
export interface GLOps<F extends GLFamily> {
    // Engine, render loop and frame timing
    readonly resizeGLEngine: (engine: F["engine"]) => void;
    readonly setGLEngineSize: (engine: F["engine"], width: number, height: number) => void;
    readonly wipeGLStateCache: (engine: F["engine"], bruteForce?: boolean) => void;
    readonly getRenderWidth: (engine: F["engine"]) => number;
    readonly getRenderHeight: (engine: F["engine"]) => number;
    readonly getTextureCount: (engine: F["engine"]) => number;
    readonly getCurrentRenderTarget: (engine: F["engine"]) => GLRenderTargetOf<F> | null;
    readonly getHardwareScalingLevel: (engine: F["engine"]) => number;
    readonly setHardwareScalingLevel: (engine: F["engine"], level: number) => void;
    readonly onContextLost: (engine: F["engine"], cb: () => void) => void;
    readonly offContextLost: (engine: F["engine"], cb: () => void) => void;
    readonly onContextRestored: (engine: F["engine"], cb: () => void) => void;
    readonly offContextRestored: (engine: F["engine"], cb: () => void) => void;
    readonly getAlphaToCoverage: (engine: F["engine"]) => boolean;
    readonly getCurrentSampleCount: (engine: F["engine"]) => number;
    readonly setAlphaToCoverage: (engine: F["engine"], enabled: boolean) => void;
    readonly runRenderLoop: (engine: F["engine"], fn: (dt: number) => void) => void;
    readonly stopRenderLoop: (engine: F["engine"], fn?: (dt: number) => void) => void;
    readonly beginFrame: (engine: F["engine"]) => void;
    readonly endFrame: (engine: F["engine"]) => void;
    readonly captureGPUFrameTime: (engine: F["engine"], enabled: boolean) => void;
    readonly getGPUFrameTimeCounter: (engine: F["engine"]) => F["perfCounter"];
    readonly setFramebufferValidation: (engine: F["engine"], enabled: boolean) => void;

    // Effects and the fullscreen effect renderer
    readonly createEffect: (engine: F["engine"], options: GLEffectOptions) => F["effect"];
    readonly useEffect: (effect: F["effect"]) => void;
    readonly isEffectReady: (effect: F["effect"]) => boolean;
    readonly getEffectCompilationError: (effect: F["effect"]) => string | null;
    readonly executeWhenCompiled: (effect: F["effect"], cb: (e: F["effect"]) => void) => void;
    readonly disposeEffect: (effect: F["effect"]) => void;
    readonly setEffectFloat: (effect: F["effect"], name: string, x: number) => void;
    readonly setEffectFloat2: (effect: F["effect"], name: string, x: number, y: number) => void;
    readonly setEffectFloat3: (effect: F["effect"], name: string, x: number, y: number, z: number) => void;
    readonly setEffectFloat4: (effect: F["effect"], name: string, x: number, y: number, z: number, w: number) => void;
    readonly setEffectColor3: (effect: F["effect"], name: string, c: { r: number; g: number; b: number }) => void;
    readonly setEffectColor4: (effect: F["effect"], name: string, c: { r: number; g: number; b: number; a: number }) => void;
    readonly setEffectVector2: (effect: F["effect"], name: string, v: { x: number; y: number }) => void;
    readonly setEffectDirectColor4: (effect: F["effect"], name: string, c: { r: number; g: number; b: number; a: number }) => void;
    readonly setEffectInt: (effect: F["effect"], name: string, x: number) => void;
    readonly setEffectTexture: (effect: F["effect"], samplerName: string, tex: F["texture"] | F["noTexture"]) => void;
    readonly setEffectMatrix: (effect: F["effect"], name: string, matrix: F["floatArray"]) => void;
    readonly setEffectMatrix3x3: (effect: F["effect"], name: string, matrix: F["floatArray"]) => void;
    readonly setEffectFloatArray: (effect: F["effect"], name: string, array: F["floatArray"]) => void;
    readonly setEffectFloatArray2: (effect: F["effect"], name: string, array: F["floatArray"]) => void;
    readonly setEffectFloatArray3: (effect: F["effect"], name: string, array: F["floatArray"]) => void;
    readonly setEffectFloatArray4: (effect: F["effect"], name: string, array: F["floatArray"]) => void;
    readonly setEffectIntArray: (effect: F["effect"], name: string, array: number[] | Int32Array) => void;
    readonly waitForEffect: (effect: F["effect"], options?: F["effectWaitOptions"]) => Promise<F["effect"]>;
    readonly createEffectWrapper: (engine: F["engine"], options: F["effectWrapperOptions"]) => F["effectWrapper"];
    readonly applyEffectWrapper: (wrapper: F["effectWrapper"]) => boolean;
    readonly drawEffect: (engine: F["engine"]) => void;
    readonly setViewport: (engine: F["engine"], viewport?: GLViewport) => void;
    readonly disposeEffectWrapper: (wrapper: F["effectWrapper"]) => void;

    // Textures
    readonly createRawTexture: (engine: F["engine"], data: F["rawTextureData"], width: number, height: number, options?: F["rawTextureOptions"]) => F["texture"];
    readonly createFloatTexture: (engine: F["engine"], data: ArrayBufferView | null, width: number, height: number, options?: F["floatTextureOptions"]) => F["texture"];
    readonly generateTextureMipMaps: (tex: F["texture"]) => void;
    readonly loadTexture2D: (engine: F["engine"], url: string, options?: F["textureOptions"], onLoad?: (tex: F["texture"]) => void, onError?: (err: Error) => void) => F["texture"];
    readonly bindTexture: (tex: F["texture"], unit: number) => void;
    readonly unbindTexture: (engine: F["engine"], unit: number) => void;
    readonly disposeTexture: (tex: F["texture"]) => void;
    readonly updateRawTexture: (
        tex: F["texture"],
        data: F["rawTextureData"],
        options?: F["textureUpdateOptions"] & { width?: number; height?: number; unpackAlignment?: number }
    ) => void;
    readonly updateTextureSamplingMode: (tex: F["texture"], minFilter: number, magFilter: number) => void;
    readonly updateTextureSamplingPreset: (tex: F["texture"], samplingMode: F["samplingMode"], generateMipMaps?: boolean) => void;
    readonly updateTextureWrapMode: (tex: F["texture"], wrapS: number, wrapT: number) => void;
    readonly getSamplingModeFilters: (samplingMode: F["samplingMode"], useMipMaps?: boolean) => F["samplingFilters"];
    readonly isTextureReady: (tex: F["texture"]) => boolean;
    readonly createTexture3DFromPixels: (engine: F["engine"], data: Uint8Array, width: number, height: number, depth: number, options?: F["texture3DOptions"]) => F["texture3D"];
    readonly bindTexture3D: (tex: F["texture3D"], unit: number) => void;
    readonly unbindTexture3D: (engine: F["engine"], unit: number) => void;
    readonly setEffectTexture3D: (effect: F["effect"], samplerName: string, tex: F["texture3D"] | F["noTexture"]) => void;
    readonly generateTexture3DMipMaps: (tex: F["texture3D"]) => void;
    readonly updateTexture3DSamplingMode: (tex: F["texture3D"], minFilter: number, magFilter: number) => void;
    readonly updateTexture3DWrapMode: (tex: F["texture3D"], wrapS: number, wrapT: number, wrapR: number) => void;
    readonly disposeTexture3D: (tex: F["texture3D"]) => void;
    readonly createDynamicTexture: (engine: F["engine"], width: number, height: number, options?: F["textureOptions"]) => F["texture"];

    // Render targets
    readonly createRenderTarget: (engine: F["engine"], width: number, height: number, options?: F["renderTargetOptions"]) => GLRenderTargetOf<F>;
    readonly createFloatRenderTarget: (engine: F["engine"], width: number, height: number, options?: F["floatRenderTargetOptions"]) => GLRenderTargetOf<F>;
    readonly bindRenderTarget: (rt: GLRenderTargetOf<F>) => void;
    readonly restoreDefaultFramebuffer: (engine: F["engine"]) => void;
    readonly presentRenderTarget: (target: GLRenderTargetOf<F>) => void;
    readonly generateRenderTargetMipMaps: (rt: GLRenderTargetOf<F>) => void;
    readonly resizeRenderTarget: (rt: GLRenderTargetOf<F>, width: number, height: number) => void;
    readonly readRenderTargetPixels: (rt: GLRenderTargetOf<F>, options?: F["readPixelsOptions"]) => ArrayBufferView;
    readonly disposeRenderTarget: (rt: GLRenderTargetOf<F> | null | undefined) => void;

    // Meshes, buffers and instancing
    readonly createVertexBuffer: (engine: F["engine"], data: Float32Array, ...args: F["vertexBufferArgs"]) => F["vertexBuffer"];
    readonly updateVertexBuffer: (vb: F["vertexBuffer"], data: Float32Array, dstByteOffset?: number) => void;
    readonly createIndexBuffer: (engine: F["engine"], data: Uint16Array | Uint32Array) => F["indexBuffer"];
    readonly disposeBuffer: (buffer: F["vertexBuffer"] | F["indexBuffer"]) => void;
    readonly bindIndexBuffer: (ib: F["indexBuffer"]) => void;
    readonly bindAttributes: (vb: F["vertexBuffer"], descriptors: readonly F["attributeDescriptor"][], effect: F["effect"], computeStride?: boolean) => void;
    readonly disableAttributeByIndex: (engine: F["engine"], location: number) => void;
    readonly unbindAllAttributes: (engine: F["engine"]) => void;
    readonly unbindInstanceAttributes: (engine: F["engine"]) => void;
    readonly drawIndexed: (ib: F["indexBuffer"], indexCount: number, indexStart?: number, instanceCount?: F["instanceCount"]) => void;
    readonly createMeshVao: (
        engine: F["engine"],
        vertexBuffers: readonly GLFamilyMeshVertexBuffer<F["vertexBuffer"], F["attributeDescriptor"]>[],
        indexBuffer: F["indexBuffer"],
        effect: F["effect"]
    ) => F["meshVao"];
    readonly bindMeshVao: (vao: F["meshVao"]) => void;
    readonly drawMesh: (vao: F["meshVao"], instanceCount?: F["instanceCount"], indexStart?: number, indexCount?: number) => void;
    readonly disposeMeshVao: (vao: F["meshVao"]) => void;

    // Blend, depth, stencil, color mask, clear and scissor state
    readonly setBlendMode: (engine: F["engine"], mode: F["blendMode"]) => void;
    readonly setBlendState: (engine: F["engine"], state: F["blendState"]) => void;
    readonly disableBlend: (engine: F["engine"]) => void;
    readonly setDepthState: (engine: F["engine"], state: F["depthState"]) => void;
    readonly setCullState: (engine: F["engine"], enabled: boolean, face?: number) => void;
    readonly setStencilState: (engine: F["engine"], state: F["stencilState"]) => void;
    readonly setStencilOpSeparate: (engine: F["engine"], face: number, state: F["stencilOpState"]) => void;
    readonly setColorMask: (engine: F["engine"], r: boolean, g: boolean, b: boolean, a: boolean) => void;
    readonly clearEngine: (engine: F["engine"], options: GLClearOptions) => void;
    readonly generateRenderTargetStencil: (rt: GLRenderTargetOf<F>, options?: { depth?: boolean }) => void;
    /** Portable dimensions are nonnegative integers; a rectangle without area clips everything. */
    readonly setScissor: (engine: F["engine"], x: number, y: number, width: number, height: number) => void;
    readonly disableScissor: (engine: F["engine"]) => void;

    // Sprites
    readonly createSpriteRenderer: (engine: F["engine"], options: F["spriteRendererOptions"]) => F["spriteRenderer"];
    readonly renderSprites: (
        renderer: F["spriteRenderer"],
        sprites: readonly F["sprite"][],
        deltaTime: number,
        viewMatrix: F["floatArray"],
        projectionMatrix: F["floatArray"]
    ) => void;
    readonly setSpriteRendererTexture: (renderer: F["spriteRenderer"], texture: F["texture"]) => void;
    readonly disposeSpriteRenderer: (renderer: F["spriteRenderer"]) => void;

    // Text
    readonly loadFont: (url: string) => Promise<F["font"]>;
    readonly createFontFromBuffer: (data: ArrayBuffer) => F["font"];
    readonly extractGlyphCurves: (font: F["font"], glyphIds: ReadonlySet<number>, target: Map<number, F["glyphCurves"]>) => void;
    readonly cubicToQuadratics: (p0x: number, p0y: number, c1x: number, c1y: number, c2x: number, c2y: number, p1x: number, p1y: number) => [F["quadCurve"], F["quadCurve"]];
    readonly createGlyphStorage: (initial?: Map<string, Map<number, F["glyphCurves"]>>) => F["glyphStorage"];
    readonly updateGlyphStorage: (storage: F["glyphStorage"], curveSetId: string, curves: ReadonlyMap<number, F["glyphCurves"]>) => void;
    readonly disposeGlyphStorage: (storage: F["glyphStorage"]) => void;
    readonly createTextData: (storage: F["glyphStorage"], runs?: readonly F["glyphRun"][]) => F["textData"];
    readonly updateTextData: (data: F["textData"], update: F["textDataUpdate"]) => void;
    readonly disposeTextData: (data: F["textData"]) => void;
    readonly createDefaultTextData: (
        font: F["font"],
        fontSizePx: number,
        text: string,
        textColor?: readonly [number, number, number, number],
        options?: F["textLayoutOptions"]
    ) => F["defaultTextData"];
    readonly updateDefaultTextData: (data: F["defaultTextData"], text: string, textColor?: readonly [number, number, number, number]) => void;
    readonly disposeDefaultTextData: (data: F["defaultTextData"]) => void;
    readonly createTextLayer: (data: F["textData"], options?: F["textLayerOptions"]) => F["textLayer"];
    readonly setTextLayerPosition: (layer: F["textLayer"], x: number, y: number) => void;
    readonly createTextRenderer: (engine: F["engine"], options: F["textRendererOptions"]) => F["textRenderer"];
    readonly renderText: (renderer: F["textRenderer"]) => number;
    readonly isTextRendererReady: (renderer: F["textRenderer"]) => boolean;
    readonly addTextRendererLayer: (renderer: F["textRenderer"], layer: F["textLayer"]) => void;
    readonly removeTextRendererLayer: (renderer: F["textRenderer"], layer: F["textLayer"]) => boolean;
    readonly registerTextRenderer: (renderer: F["textRenderer"]) => void;
    readonly unregisterTextRenderer: (renderer: F["textRenderer"]) => void;
    readonly disposeTextRenderer: (renderer: F["textRenderer"]) => void;
    readonly setFontWeightOffset: (data: F["textData"], run: number | F["glyphRun"], offset: number) => void;
}

/** Name of a backend-neutral operation. */
export type GLOpName = keyof GLOps<GLFamily>;

/** Type-only witness that lets TypeScript infer a kit's family. It is never set at runtime. */
export interface GLFamilyMarker<F extends GLFamily> {
    /** Never present at runtime. */
    readonly glFamily?: F;
}

/** The operations `K` of family `F`, as selected by a consumer and filled with a backend's exported functions. */
export type GLKit<F extends GLFamily, K extends GLOpName> = Pick<GLOps<F>, K> & GLFamilyMarker<F>;
