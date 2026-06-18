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
import type { EngineContext, NodeMaterial as LiteNodeMaterial, Texture2D } from "babylon-lite";

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

    public constructor(name: string, _scene: Scene, json: object | string = {}) {
        this.name = name;
        this._json = json;
    }

    public getClassName(): string {
        return "NodeMaterial";
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
        this._lite = await parseNodeMaterialFromSnippet(engine, "", {
            json: this._json,
            ...(overrides.length ? { textures } : {}),
            // Babylon.js wires shadows into the scene globally; Babylon Lite takes them
            // at NME parse time, so NME shadow-receiver blocks sample the scene's
            // generators (e.g. ground `receiveShadows` in scenes 65/66).
            ...(shadowGenerators.length ? { shadowGenerators: shadowGenerators as never } : {}),
        });
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
