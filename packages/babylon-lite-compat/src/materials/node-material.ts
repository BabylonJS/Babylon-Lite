/**
 * Babylon.js-compatible `NodeMaterial` over Babylon Lite's NME parser.
 *
 * Babylon.js exposes a synchronous `NodeMaterial.Parse(json, scene)`, optional
 * `getBlockByName(name).texture = …` overrides, then `build()`. Babylon Lite
 * instead parses an NME graph asynchronously via `parseNodeMaterialFromSnippet`,
 * taking texture overrides up front (keyed by block name) and emitting/compiling
 * the pipeline in one shot.
 *
 * The compat wrapper bridges the two: `Parse` returns immediately with an
 * unparsed handle and records the source; `getBlockByName` returns a thin proxy
 * that captures per-block texture assignments; the real (async) parse is deferred
 * to engine start — registered with the scene so it is awaited (alongside its
 * override textures) before the scene builds. `build()` is a no-op.
 */

import { parseNodeMaterialFromSnippet } from "babylon-lite";
import type { EngineContext, Material as LiteMaterial, NodeMaterial as LiteNodeMaterial, Texture2D } from "babylon-lite";

import type { Scene } from "../scene/scene.js";

interface TextureLike {
    _lite?: Texture2D;
    whenReadyAsync?(): Promise<void>;
}

/** A thin proxy for a Babylon.js NME block, capturing texture assignments. */
class NodeMaterialBlockProxy {
    public constructor(
        private readonly _owner: NodeMaterial,
        private readonly _name: string
    ) {}

    public set texture(value: TextureLike | null) {
        this._owner._setBlockTexture(this._name, value);
    }
    public get texture(): TextureLike | null {
        return this._owner._getBlockTexture(this._name);
    }
}

export class NodeMaterial {
    public name: string;
    public backFaceCulling = true;
    /** @internal The compiled Lite node material. Undefined until the async parse resolves. */
    public _lite: LiteNodeMaterial | undefined;

    private readonly _json: object | string;
    private readonly _textureOverrides: Record<string, TextureLike> = {};
    private readonly _scene: Scene;
    private readonly _pendingBindings = new Map<{ material: LiteMaterial }, () => boolean>();
    private _parsed = false;

    public constructor(name: string, scene: Scene, json: object | string = {}) {
        this.name = name;
        this._scene = scene;
        this._json = json;
    }

    public getClassName(): string {
        return "NodeMaterial";
    }

    /**
     * Babylon.js `NodeMaterial.clone(name)`. Reuses the same NME source graph and the
     * captured per-block texture overrides (textures shared by reference, as
     * Babylon.js does), registering the clone with the scene so it parses/compiles its
     * own Lite node material (own renderable) at engine start.
     */
    public clone(name: string): NodeMaterial {
        const cloned = new NodeMaterial(name, this._scene, this._json);
        for (const [block, tex] of Object.entries(this._textureOverrides)) {
            cloned._textureOverrides[block] = tex;
        }
        cloned.backFaceCulling = this.backFaceCulling;
        // Keep assignments made immediately after clone() functional while the clone's
        // own async renderable is compiled. _parse replaces this temporary handle.
        cloned._lite = this._lite;
        this._scene._registerNodeMaterial(cloned);
        return cloned;
    }

    /** Babylon.js `getBlockByName(name)` — returns a proxy that captures texture overrides. */
    public getBlockByName(name: string): NodeMaterialBlockProxy {
        return new NodeMaterialBlockProxy(this, name);
    }

    /** @internal */
    public _setBlockTexture(name: string, value: TextureLike | null): void {
        if (value) {
            this._textureOverrides[name] = value;
        } else {
            delete this._textureOverrides[name];
        }
    }

    /** @internal */
    public _getBlockTexture(name: string): TextureLike | null {
        return this._textureOverrides[name] ?? null;
    }

    /** Babylon.js `NodeMaterial.build()` — Lite builds during parse, so this is a no-op. */
    public build(_verbose?: boolean): void {
        // Intentionally empty.
    }

    /** @internal Parse already happened via the scene-tracked promise; nothing to finalize. */
    public _ensureRenderable(_engine: EngineContext): void {
        // No-op: `_lite` is set when the tracked parse promise resolves.
    }

    /** @internal Bind a mesh immediately and refresh it if still assigned when parsing finishes. */
    public _bindMesh(mesh: { material: LiteMaterial }, isCurrent: () => boolean): void {
        if (!this._parsed) {
            this._pendingBindings.set(mesh, isCurrent);
        }
        if (this._lite) {
            mesh.material = this._lite;
        }
    }

    public dispose(): void {
        // GPU resources owned by the scene; disposed with it.
    }

    /** @internal Resolve override textures, then parse + compile the NME graph. */
    public async _parse(engine: EngineContext, shadowGenerators: readonly unknown[] = []): Promise<void> {
        // Yield once so any synchronous `getBlockByName(name).texture = …` overrides
        // set immediately after `Parse()` are recorded before we read them.
        await Promise.resolve();
        const overrides = Object.entries(this._textureOverrides);
        await Promise.all(overrides.map(([, tex]) => tex.whenReadyAsync?.() ?? Promise.resolve()));
        const textures: Record<string, Texture2D> = {};
        for (const [blockName, tex] of overrides) {
            if (tex._lite) {
                textures[blockName] = tex._lite;
            }
        }
        try {
            this._lite = await parseNodeMaterialFromSnippet(engine, "", {
                json: this._json,
                ...(overrides.length ? { textures } : {}),
                // Babylon.js wires shadows into the scene globally; Babylon Lite takes them
                // at NME parse time, so NME shadow-receiver blocks sample the scene's
                // generators (e.g. ground `receiveShadows` in scenes 65/66).
                ...(shadowGenerators.length ? { shadowGenerators: shadowGenerators as never } : {}),
            });
            this._parsed = true;
            for (const [mesh, isCurrent] of this._pendingBindings) {
                if (isCurrent()) {
                    mesh.material = this._lite;
                }
            }
        } finally {
            this._pendingBindings.clear();
        }
    }

    /**
     * Babylon.js `NodeMaterial.Parse(source, scene, rootUrl?)` — parse an NME graph
     * from inline JSON. Returns synchronously; the actual GPU compile runs async and
     * is driven by the engine (after shadow generators are built) before the scene
     * builds, so NME shadow-receiver blocks can sample the scene's shadow generators.
     */
    public static Parse(source: object | string, scene: Scene, _rootUrl?: string): NodeMaterial {
        const material = new NodeMaterial("nodeMaterial", scene, source);
        scene._registerNodeMaterial(material);
        return material;
    }
}
