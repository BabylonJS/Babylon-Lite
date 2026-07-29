/**
 * Babylon.js-compatible material classes over the Babylon Lite material
 * factories.
 *
 * The Lite material is plain-data props (`_lite`); assign it to a mesh via
 * `mesh.material = material`. Property setters mutate the props and mark the
 * material UBO dirty (matching Babylon.js's "mutate then it just works"
 * behaviour). Only the common property subset is mapped; rarely-used Babylon.js
 * material properties are intentionally omitted.
 */

import { createStandardMaterial, createPbrMaterial, markMaterialUboDirty, createSolidTexture2D } from "babylon-lite";
import type { StandardMaterialProps, PbrMaterialProps, ClearCoatProps, SheenProps, AnisotropyProps, IridescenceProps, Texture2D, EngineContext } from "babylon-lite";

import { Color3 } from "../math/color.js";
import type { Scene } from "../scene/scene.js";
import type { BaseTexture, CubeTexture, HDRCubeTexture } from "../textures/textures.js";

type Tuple3 = [number, number, number];
type Tuple4 = [number, number, number, number];

/** Babylon.js `Material` — base class for all materials. */
export abstract class Material {
    public name: string;
    /** Common transparency mode flag (Babylon.js `Material.transparencyMode`). */
    public transparencyMode: number | null = null;
    /** Back-face culling toggle (Babylon.js `Material.backFaceCulling`). */
    private _backFaceCulling = true;
    public get backFaceCulling(): boolean {
        return this._backFaceCulling;
    }
    public set backFaceCulling(value: boolean) {
        this._backFaceCulling = value;
        this._applyBackFaceCulling(value);
        this._markDirty();
    }
    /** @internal Per-material hook to push culling onto the Lite props (Standard vs PBR differ). */
    protected _applyBackFaceCulling(_value: boolean): void {
        // Base/NME materials: no Lite culling field to set.
    }
    /** Wireframe rendering toggle (not honoured by all Lite materials). */
    public wireframe = false;
    /** @internal Underlying Babylon Lite material props. */
    public abstract readonly _lite: StandardMaterialProps | PbrMaterialProps;

    /** @internal Owning compat scene, when constructed against one. */
    protected _scene: Scene | undefined;

    protected constructor(name: string, scene?: Scene) {
        this.name = name;
        this._scene = scene;
        scene?._registerMaterial(this);
    }

    public getClassName(): string {
        return "Material";
    }

    /**
     * Babylon.js `Material.clone(name)` — return a deep copy of this material under
     * a new name. Textures are **shared** by reference (matching Babylon.js), but the
     * clone gets its **own** Babylon Lite renderable (a fresh `_buildGroup` / UBO from
     * its factory) rather than aliasing the source's, so the two materials render and
     * dirty-track independently. Each concrete subclass copies its own property set.
     */
    public abstract clone(name: string): Material;

    /**
     * @internal Copy the shared base + Lite data-property state onto a freshly
     * constructed clone. The clone keeps the `_buildGroup`/UBO its own factory
     * created (internal `_`-prefixed fields are never copied), so only the observable
     * data properties — colours, scalars, and shared texture references — carry over.
     */
    protected _cloneBaseInto(target: Material): void {
        copyLiteMaterialData(this._lite, target._lite);
        target.transparencyMode = this.transparencyMode;
        target.wireframe = this.wireframe;
        target.backFaceCulling = this._backFaceCulling;
    }

    protected _markDirty(): void {
        markMaterialUboDirty(this._lite);
    }

    /**
     * @internal Finalize GPU-facing resources before the mesh is registered.
     * Base materials need nothing; PBR overrides this to synthesize the solid
     * textures Babylon Lite's PBR pipeline requires from factor-only materials.
     */
    public _ensureRenderable(_engine: EngineContext): void {
        // No-op for the base/standard material.
    }

    public dispose(): void {
        // No GPU resources are owned by the props object directly; textures are
        // disposed through their own handles. Drop the material from its scene's
        // `scene.materials` registry.
        this._scene?._unregisterMaterial(this);
    }
}

/** Babylon.js `PushMaterial` — intermediate base; behaves like {@link Material} here. */
export abstract class PushMaterial extends Material {
    public override getClassName(): string {
        return "PushMaterial";
    }
}

function readColor3(tuple: Tuple3 | undefined): Color3 {
    return tuple ? new Color3(tuple[0], tuple[1], tuple[2]) : new Color3(0, 0, 0);
}

/**
 * Copy the observable Babylon Lite material data-properties from `src` onto `dst`.
 * `_`-prefixed internal fields (`_buildGroup`, `_uboVersion`, render-feature caches)
 * are skipped so the clone keeps its own renderable state. Arrays (colour/UV tuples)
 * are copied so mutating one material's colour does not alias the other; object
 * values (texture handles) are shared by reference, matching Babylon.js clone
 * semantics. Nested config objects (PBR clearcoat/sheen/…) are re-copied per-subclass.
 */
function copyLiteMaterialData(src: object, dst: object): void {
    const s = src as Record<string, unknown>;
    const d = dst as Record<string, unknown>;
    for (const key of Object.keys(s)) {
        if (key.startsWith("_")) {
            continue;
        }
        const value = s[key];
        d[key] = Array.isArray(value) ? value.slice() : value;
    }
}

export class StandardMaterial extends PushMaterial {
    /** @internal Underlying Babylon Lite standard-material props. */
    public readonly _lite: StandardMaterialProps;

    public constructor(name: string, scene?: Scene) {
        super(name, scene);
        this._lite = createStandardMaterial();
    }

    public override getClassName(): string {
        return "StandardMaterial";
    }

    public get diffuseColor(): Color3 {
        return readColor3(this._lite.diffuseColor);
    }
    public set diffuseColor(value: Color3) {
        this._lite.diffuseColor = [value.r, value.g, value.b];
        this._markDirty();
    }

    public get specularColor(): Color3 {
        return readColor3(this._lite.specularColor);
    }
    public set specularColor(value: Color3) {
        this._lite.specularColor = [value.r, value.g, value.b];
        this._markDirty();
    }

    public get emissiveColor(): Color3 {
        return readColor3(this._lite.emissiveColor);
    }
    public set emissiveColor(value: Color3) {
        this._lite.emissiveColor = [value.r, value.g, value.b];
        this._markDirty();
    }

    public get ambientColor(): Color3 {
        return readColor3(this._lite.ambientColor);
    }
    public set ambientColor(value: Color3) {
        this._lite.ambientColor = [value.r, value.g, value.b];
        this._markDirty();
    }

    public get disableLighting(): boolean {
        return this._lite.disableLighting;
    }
    public set disableLighting(value: boolean) {
        this._lite.disableLighting = value;
        this._markDirty();
    }

    protected override _applyBackFaceCulling(value: boolean): void {
        this._lite.backFaceCulling = value;
    }

    public get alpha(): number {
        return this._lite.alpha;
    }
    public set alpha(value: number) {
        this._lite.alpha = value;
        this._markDirty();
    }

    public get diffuseTexture(): BaseTexture | null {
        return this._diffuseTexture;
    }
    public set diffuseTexture(texture: BaseTexture | null) {
        this._diffuseTexture = texture;
        this._lite.diffuseTexture = (texture?._lite as Texture2D | undefined) ?? null;
        this._markDirty();
    }

    /**
     * Babylon.js `StandardMaterial.alphaCutOff` — alpha-test threshold. Fragments
     * whose diffuse-texture alpha is below this value are discarded. Babylon Lite's
     * Standard pipeline alpha-tests against the diffuse texture's alpha when
     * `alphaCutOff > 0`, so this is wired directly.
     */
    public get alphaCutOff(): number {
        return this._lite.alphaCutOff;
    }
    public set alphaCutOff(value: number) {
        this._lite.alphaCutOff = value;
        this._markDirty();
    }

    /**
     * Babylon.js `StandardMaterial.useAlphaFromDiffuseTexture`. Babylon Lite's
     * alpha test already samples the diffuse texture's alpha (enabled via
     * `alphaCutOff`), so this is accepted for parity.
     */
    public useAlphaFromDiffuseTexture = false;

    public get bumpTexture(): BaseTexture | null {
        return this._bumpTexture;
    }
    public set bumpTexture(texture: BaseTexture | null) {
        this._bumpTexture = texture;
        this._lite.bumpTexture = (texture?._lite as Texture2D | undefined) ?? null;
        this._markDirty();
    }

    public get emissiveTexture(): BaseTexture | null {
        return this._emissiveTexture;
    }
    public set emissiveTexture(texture: BaseTexture | null) {
        this._emissiveTexture = texture;
        this._lite.emissiveTexture = (texture?._lite as Texture2D | undefined) ?? null;
        this._markDirty();
    }

    private _diffuseTexture: BaseTexture | null = null;
    private _bumpTexture: BaseTexture | null = null;
    private _emissiveTexture: BaseTexture | null = null;

    /**
     * @internal Re-bind texture maps to the Lite material. Babylon.js `Texture`s
     * load asynchronously, so when `material.diffuseTexture = new Texture(url)` ran
     * the Lite handle was still undefined. By engine-start the scene has awaited the
     * loads, so copy the now-resolved handles (and UV tiling) onto the Lite props.
     */
    public override _ensureRenderable(_engine: EngineContext): void {
        const diff = this._diffuseTexture as { _lite?: Texture2D; uScale?: number; vScale?: number } | null;
        if (diff?._lite) {
            this._lite.diffuseTexture = diff._lite;
            if (diff.uScale !== undefined && diff.vScale !== undefined) {
                this._lite.uvScale = [diff.uScale, diff.vScale];
            }
        }
        const bump = this._bumpTexture as { _lite?: Texture2D } | null;
        if (bump?._lite) {
            this._lite.bumpTexture = bump._lite;
        }
        const emissive = this._emissiveTexture as { _lite?: Texture2D } | null;
        if (emissive?._lite) {
            this._lite.emissiveTexture = emissive._lite;
        }
        this._markDirty();
    }

    /**
     * Babylon.js `StandardMaterial.clone(name)`. Copies the diffuse/specular/emissive/
     * ambient colours and scalars, shares the diffuse/bump/emissive texture references,
     * and gives the clone its own Lite standard-material renderable.
     */
    public override clone(name: string): StandardMaterial {
        const cloned = new StandardMaterial(name, this._scene);
        this._cloneBaseInto(cloned);
        cloned.useAlphaFromDiffuseTexture = this.useAlphaFromDiffuseTexture;
        cloned._diffuseTexture = this._diffuseTexture;
        cloned._bumpTexture = this._bumpTexture;
        cloned._emissiveTexture = this._emissiveTexture;
        return cloned;
    }
}

/**
 * Babylon.js `PBRClearCoatConfiguration` — the `pbr.clearCoat` sub-object.
 * Proxies the common clearcoat fields onto a Babylon Lite `ClearCoatProps`.
 */
export class PBRClearCoatConfiguration {
    public constructor(
        private readonly _props: ClearCoatProps,
        private readonly _markDirty: () => void
    ) {}

    public get isEnabled(): boolean {
        return this._props.isEnabled ?? false;
    }
    public set isEnabled(value: boolean) {
        this._props.isEnabled = value;
        this._markDirty();
    }

    public get intensity(): number {
        return this._props.intensity ?? 1;
    }
    public set intensity(value: number) {
        this._props.intensity = value;
        this._markDirty();
    }

    public get roughness(): number {
        return this._props.roughness ?? 0;
    }
    public set roughness(value: number) {
        this._props.roughness = value;
        this._markDirty();
    }

    public get indexOfRefraction(): number {
        return this._props.indexOfRefraction ?? 1.5;
    }
    public set indexOfRefraction(value: number) {
        this._props.indexOfRefraction = value;
        this._markDirty();
    }
}

/** Babylon.js `PBRSheenConfiguration` — the `pbr.sheen` sub-object over Lite `SheenProps`. */
export class PBRSheenConfiguration {
    public constructor(
        private readonly _props: SheenProps,
        private readonly _markDirty: () => void
    ) {}

    public get isEnabled(): boolean {
        return this._props.isEnabled;
    }
    public set isEnabled(value: boolean) {
        this._props.isEnabled = value;
        this._markDirty();
    }

    public get intensity(): number {
        return this._props.intensity ?? 1;
    }
    public set intensity(value: number) {
        this._props.intensity = value;
        this._markDirty();
    }

    public get roughness(): number {
        return this._props.roughness ?? 0;
    }
    public set roughness(value: number) {
        this._props.roughness = value;
        this._markDirty();
    }

    public get color(): Color3 {
        const c = this._props.color ?? [1, 1, 1];
        return new Color3(c[0], c[1], c[2]);
    }
    public set color(value: Color3) {
        this._props.color = [value.r, value.g, value.b];
        this._markDirty();
    }

    /** Babylon.js `sheen.texture`. Binds the Lite handle if the texture has resolved. */
    public set texture(value: { _lite?: Texture2D } | null) {
        if (value?._lite) {
            this._props.texture = value._lite;
            this._markDirty();
        }
    }
}

/** Babylon.js `PBRAnisotropicConfiguration` — the `pbr.anisotropy` sub-object over Lite `AnisotropyProps`. */
export class PBRAnisotropicConfiguration {
    public constructor(
        private readonly _props: AnisotropyProps,
        private readonly _markDirty: () => void
    ) {}

    public get isEnabled(): boolean {
        return this._props.isEnabled;
    }
    public set isEnabled(value: boolean) {
        this._props.isEnabled = value;
        this._markDirty();
    }

    public get intensity(): number {
        return this._props.intensity ?? 1;
    }
    public set intensity(value: number) {
        this._props.intensity = value;
        this._markDirty();
    }

    public get direction(): { x: number; y: number } {
        const d = this._props.direction ?? [1, 0];
        return { x: d[0], y: d[1] };
    }
    public set direction(value: { x: number; y: number }) {
        this._props.direction = [value.x, value.y];
        this._markDirty();
    }
}

/** Babylon.js `PBRIridescenceConfiguration` — the `pbr.iridescence` sub-object over Lite `IridescenceProps`. */
export class PBRIridescenceConfiguration {
    public constructor(
        private readonly _props: IridescenceProps,
        private readonly _markDirty: () => void
    ) {}

    public get isEnabled(): boolean {
        return this._props.isEnabled ?? false;
    }
    public set isEnabled(value: boolean) {
        this._props.isEnabled = value;
        this._markDirty();
    }

    public get intensity(): number {
        return this._props.intensity ?? 1;
    }
    public set intensity(value: number) {
        this._props.intensity = value;
        this._markDirty();
    }

    public get indexOfRefraction(): number {
        return this._props.indexOfRefraction ?? 1.3;
    }
    public set indexOfRefraction(value: number) {
        this._props.indexOfRefraction = value;
        this._markDirty();
    }

    public get minimumThickness(): number {
        return this._props.minimumThickness ?? 100;
    }
    public set minimumThickness(value: number) {
        this._props.minimumThickness = value;
        this._markDirty();
    }

    public get maximumThickness(): number {
        return this._props.maximumThickness ?? 400;
    }
    public set maximumThickness(value: number) {
        this._props.maximumThickness = value;
        this._markDirty();
    }
}

export class PBRMaterial extends PushMaterial {
    /** @internal Underlying Babylon Lite PBR-material props. */
    public readonly _lite: PbrMaterialProps;

    public constructor(name: string, scene?: Scene) {
        super(name, scene);
        this._lite = createPbrMaterial();
        if (!this._lite.baseColorFactor) {
            this._lite.baseColorFactor = [1, 1, 1, 1];
        }
    }

    public override getClassName(): string {
        return "PBRMaterial";
    }

    public get albedoColor(): Color3 {
        const f = this._lite.baseColorFactor;
        return f ? new Color3(f[0], f[1], f[2]) : new Color3(1, 1, 1);
    }
    public set albedoColor(value: Color3) {
        const f: Tuple4 = this._lite.baseColorFactor ?? [1, 1, 1, 1];
        this._lite.baseColorFactor = [value.r, value.g, value.b, f[3]];
        this._markDirty();
    }

    /**
     * Babylon.js `pbr.albedoTexture` (glTF base-color map). The texture loads
     * asynchronously, so the resolved Lite handle (+ sRGB flag) is bound in
     * {@link _ensureRenderable} at engine start rather than here.
     */
    public get albedoTexture(): BaseTexture | null {
        return this._albedoTexture;
    }
    public set albedoTexture(texture: BaseTexture | null) {
        this._albedoTexture = texture;
        this._markDirty();
    }

    private _albedoTexture: BaseTexture | null = null;

    public get metallic(): number {
        return this._lite.metallicFactor ?? 1;
    }
    public set metallic(value: number) {
        this._lite.metallicFactor = value;
        this._markDirty();
    }

    public get roughness(): number {
        return this._lite.roughnessFactor ?? 1;
    }
    public set roughness(value: number) {
        this._lite.roughnessFactor = value;
        this._markDirty();
    }

    public get emissiveColor(): Color3 {
        return readColor3(this._lite.emissiveColor);
    }
    public set emissiveColor(value: Color3) {
        this._lite.emissiveColor = [value.r, value.g, value.b];
        this._markDirty();
    }

    /**
     * Babylon.js `pbr.usePhysicalLightFalloff`. When false, point/spot lights use
     * Standard-style linear range falloff instead of physical inverse-square.
     * Default true (matches Babylon.js PBRMaterial).
     */
    public get usePhysicalLightFalloff(): boolean {
        return this._lite.usePhysicalLightFalloff ?? true;
    }
    public set usePhysicalLightFalloff(value: boolean) {
        this._lite.usePhysicalLightFalloff = value;
        this._markDirty();
    }

    public get alpha(): number {
        return this._lite.alpha ?? 1;
    }
    public set alpha(value: number) {
        this._lite.alpha = value;
        this._markDirty();
    }

    /**
     * Babylon.js `material.forceIrradianceInFragment`. Babylon Lite computes
     * irradiance in the fragment stage already, so this is accepted for parity.
     */
    public forceIrradianceInFragment = false;

    protected override _applyBackFaceCulling(value: boolean): void {
        this._lite.doubleSided = !value;
    }

    /**
     * Babylon.js `pbr.clearCoat` sub-configuration. Lazily allocates the Lite
     * `clearCoat` props on first access and proxies the common fields
     * (`isEnabled`, `intensity`, `roughness`, `indexOfRefraction`) onto them.
     */
    public get clearCoat(): PBRClearCoatConfiguration {
        if (!this._clearCoat) {
            if (!this._lite.clearCoat) {
                this._lite.clearCoat = { isEnabled: false };
            }
            this._clearCoat = new PBRClearCoatConfiguration(this._lite.clearCoat, () => this._markDirty());
        }
        return this._clearCoat;
    }

    private _clearCoat?: PBRClearCoatConfiguration;

    /** Babylon.js `pbr.sheen` sub-configuration (Lite `SheenProps`). */
    public get sheen(): PBRSheenConfiguration {
        if (!this._sheen) {
            if (!this._lite.sheen) {
                this._lite.sheen = { isEnabled: false };
            }
            this._sheen = new PBRSheenConfiguration(this._lite.sheen, () => this._markDirty());
        }
        return this._sheen;
    }

    private _sheen?: PBRSheenConfiguration;

    /** Babylon.js `pbr.anisotropy` sub-configuration (Lite `AnisotropyProps`). */
    public get anisotropy(): PBRAnisotropicConfiguration {
        if (!this._anisotropy) {
            if (!this._lite.anisotropy) {
                this._lite.anisotropy = { isEnabled: false };
            }
            this._anisotropy = new PBRAnisotropicConfiguration(this._lite.anisotropy, () => this._markDirty());
        }
        return this._anisotropy;
    }

    private _anisotropy?: PBRAnisotropicConfiguration;

    /** Babylon.js `pbr.iridescence` sub-configuration (Lite `IridescenceProps`). */
    public get iridescence(): PBRIridescenceConfiguration {
        if (!this._iridescence) {
            if (!this._lite.iridescence) {
                this._lite.iridescence = { isEnabled: false };
            }
            this._iridescence = new PBRIridescenceConfiguration(this._lite.iridescence, () => this._markDirty());
        }
        return this._iridescence;
    }

    private _iridescence?: PBRIridescenceConfiguration;

    /**
     * Babylon.js `material.environmentTexture` / `reflectionTexture`. Babylon Lite
     * applies image-based lighting scene-wide rather than per-material, so a cube
     * environment assigned to a material is routed to the owning scene's
     * environment (the dominant single-IBL case Babylon.js scenes use).
     */
    public get environmentTexture(): CubeTexture | HDRCubeTexture | null {
        return this._scene?.environmentTexture ?? null;
    }
    public set environmentTexture(value: CubeTexture | HDRCubeTexture | null) {
        if (this._scene) {
            this._scene.environmentTexture = value;
        }
    }

    public get reflectionTexture(): CubeTexture | HDRCubeTexture | null {
        return this.environmentTexture;
    }
    public set reflectionTexture(value: CubeTexture | HDRCubeTexture | null) {
        this.environmentTexture = value;
    }

    /** @internal Bind resolved textures and synthesize the solid textures Babylon Lite's PBR pipeline requires from a factor-only material. */
    public override _ensureRenderable(engine: EngineContext): void {
        const lite = this._lite;
        // Bind a now-resolved albedo texture (Babylon.js `Texture`s load asynchronously,
        // so the Lite handle was undefined when `material.albedoTexture = …` ran). BJS
        // `PBRMaterial.albedoTexture` is sRGB/gamma space by default, so flag `gammaAlbedo`.
        const albedo = this._albedoTexture as { _lite?: Texture2D; gammaSpace?: boolean } | null;
        if (albedo?._lite) {
            lite.baseColorTexture = albedo._lite;
            lite.gammaAlbedo = albedo.gammaSpace ?? true;
        }
        // Babylon Lite's PBR pipeline samples baseColorTexture/ormTexture unconditionally,
        // so a factor-only Babylon.js PBR material (colours but no maps) must be backed by
        // 1×1 solid textures. Bake the factors into the textures and neutralize the factors
        // so each contribution is applied exactly once.
        if (!lite.baseColorTexture) {
            const f = lite.baseColorFactor ?? [1, 1, 1, 1];
            lite.baseColorTexture = createSolidTexture2D(engine, f[0], f[1], f[2], f[3]);
            lite.baseColorFactor = [1, 1, 1, 1];
        }
        if (!lite.ormTexture) {
            const rough = lite.roughnessFactor ?? 1;
            const metal = lite.metallicFactor ?? 1;
            lite.ormTexture = createSolidTexture2D(engine, 1, rough, metal);
            lite.roughnessFactor = 1;
            lite.metallicFactor = 1;
        }
    }

    /**
     * Babylon.js `PBRMaterial.clone(name)`. Copies the albedo/metallic/roughness/
     * emissive state, shares the albedo texture reference, gives the clone independent
     * clearcoat/sheen/anisotropy/iridescence sub-configurations (sharing any nested
     * texture), and a fresh Lite PBR renderable.
     */
    public override clone(name: string): PBRMaterial {
        const cloned = new PBRMaterial(name, this._scene);
        this._clonePbrInto(cloned);
        return cloned;
    }

    /**
     * @internal Copy PBR-specific compat + Lite state onto a freshly constructed PBR
     * clone (used by every `PBRMaterial` subclass so each returns its own concrete
     * type). The base `_cloneBaseInto` shares the sub-config objects by reference; this
     * re-copies them so the clone's `clearCoat`/`sheen`/… mutate independently while
     * still sharing any nested texture handle.
     */
    protected _clonePbrInto(target: PBRMaterial): void {
        this._cloneBaseInto(target);
        target.forceIrradianceInFragment = this.forceIrradianceInFragment;
        target._albedoTexture = this._albedoTexture;
        const src = this._lite;
        const dst = target._lite;
        if (src.clearCoat) {
            dst.clearCoat = { ...src.clearCoat };
        }
        if (src.sheen) {
            dst.sheen = { ...src.sheen };
        }
        if (src.anisotropy) {
            dst.anisotropy = { ...src.anisotropy };
        }
        if (src.iridescence) {
            dst.iridescence = { ...src.iridescence };
        }
    }
}

/**
 * Babylon.js `PBRMetallicRoughnessMaterial` — a simplified façade over
 * {@link PBRMaterial} exposing the metallic-roughness workflow directly.
 */
export class PBRMetallicRoughnessMaterial extends PBRMaterial {
    public override getClassName(): string {
        return "PBRMetallicRoughnessMaterial";
    }

    /** Alias of `albedoColor` (glTF "base color"). */
    public get baseColor(): Color3 {
        return this.albedoColor;
    }
    public set baseColor(value: Color3) {
        this.albedoColor = value;
    }

    public override clone(name: string): PBRMetallicRoughnessMaterial {
        const cloned = new PBRMetallicRoughnessMaterial(name, this._scene);
        this._clonePbrInto(cloned);
        return cloned;
    }
}

/**
 * Babylon.js `PBRSpecularGlossinessMaterial` — the spec/gloss workflow is
 * supported when loaded from glTF (`KHR_materials_pbrSpecularGlossiness`), but a
 * standalone manual spec/gloss material is not mapped onto Lite's metallic-roughness
 * PBR. The constructor builds a metallic-roughness PBR material and exposes a
 * `diffuseColor`/`glossiness` façade; results will not match BJS spec/gloss exactly.
 */
export class PBRSpecularGlossinessMaterial extends PBRMaterial {
    public override getClassName(): string {
        return "PBRSpecularGlossinessMaterial";
    }

    public get diffuseColor(): Color3 {
        return this.albedoColor;
    }
    public set diffuseColor(value: Color3) {
        this.albedoColor = value;
    }

    /** Maps glossiness → (1 - roughness). */
    public get glossiness(): number {
        return 1 - this.roughness;
    }
    public set glossiness(value: number) {
        this.roughness = 1 - value;
    }

    public override clone(name: string): PBRSpecularGlossinessMaterial {
        const cloned = new PBRSpecularGlossinessMaterial(name, this._scene);
        this._clonePbrInto(cloned);
        return cloned;
    }
}
