# Node Material block selection

The default Node Material loader supports arbitrary serialized graphs. For a
fixed graph, `createNodeMaterialBlockLoader` selects only the known block types,
avoiding the general registry while preserving lazy emitter loading.

## API and ownership

All exports come from `babylon-lite` / `@babylonjs/lite`, never package subpaths:

```ts
import { createNodeMaterialBlockLoader, nodeInputBlock, nodeFragmentOutputBlock, parseNodeMaterialFromSnippet } from "@babylonjs/lite";

const blockLoader = createNodeMaterialBlockLoader([nodeInputBlock, nodeFragmentOutputBlock]);
// Supply all classes in the actual graph, including disconnected blocks.
const material = await parseNodeMaterialFromSnippet(engine, "", { json, blockLoader });
```

`NodeMaterialBlock` exposes a readonly `className`. Its internal `_load` callback
is stripped from public declarations. Each callback dynamically imports one
existing emitter; importing the package root does not eagerly execute all block
implementations. There are no module-level registries or registration side effects.
The factory creates a private map per invocation, rejects malformed descriptors
and duplicate classes, and returns the existing asynchronous
`ParseNodeMaterialOptions.blockLoader` contract. Use the exported descriptor
values: constructing an object with only `className` does not provide a loader
and is rejected immediately.
An unselected class rejects explicitly; it never falls back to the full registry.

`nodePbrMetallicRoughnessBlock` is the core implementation.
`nodePbrMetallicRoughnessBlockFull` has the same class name and implements advanced
PBR inputs/specular anti-aliasing. Do not select both. The generator resolves the
same implementation as the default loader instead of duplicating its feature
detection. `nodeGeometryTextureOutputBlock` provides the opt-in geometry terminal.
Shaders, material inputs, texture updates, shadow variants and rebuild ownership
remain with the existing parser, emitter, pipeline and renderable implementations.

## Generation

`scripts/generate-node-block-catalog.ts` reads the existing base/extension
registries with the TypeScript AST and generates `node-blocks.ts` and the named
root exports. Grouped cases inherit the shared lazy import, including imports
returned by named helper functions. Generation fails if any registry case lacks
an implementation rather than silently omitting a supported block. Run it after
adding a registry entry; `--check` detects drift.

Generate a graph loader from JSON:

```powershell
pnpm exec tsx scripts\generate-node-material-loader.mts --json graph.json --output graph-block-loader.ts
```

Repository graphs can instead use `--module path.ts --export name`. A zero-argument
exported function may return the graph asynchronously; `--property json` selects
the graph when the result wraps it. Module input executes trusted build-time code.
`--package babylon-lite` chooses the workspace import name. Existing outputs are
protected by default; `--force` regenerates them and `--check` compares without
writing. Regenerate when serialized block classes or PBR feature requirements
change, not when merely updating live material uniform/texture values.

The generated module exports `createBlockLoader()`. It is **counted runtime
code**, not an excluded graph-data payload. The CLI rejects output filenames
ending in `-nme.ts` or `-npe.ts`.

## Coverage

`node-block-loader.test.ts` compares every selection with its existing registry
implementation, compares emitted shader/state for texture, full NME, PBR, loop
and geometry graphs, and covers malformed/duplicate/missing selections and
core/full PBR. It independently enumerates default-registry cases to check catalog
completeness and generates loaders for all four shared matrix block cases.
Published-declaration coverage ensures callers use only root exports and cannot
access `_load`. Default-loader controls remain part of the scoped bundle campaign.

Graph precompilation is separate: the current build state includes Maps and
feature callbacks, and geometry views re-emit from retained graph/emitters.
A safe AOT format must encode those requirements and preserve live inputs; simply
serializing `emitGraph()` would lose them. No AOT runtime or format is added here.
