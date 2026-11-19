# @babylonjs/lite-gl — agent instructions

These rules add to the repository root `AGENTS.md` and `GUIDANCE.md` for work in
`packages/babylon-lite-gl` and `tests/gl`.

## Exported functions, the backend family and the uber-kits change together

Every callable export of the web entry (`src/index.ts`) and the native entry
(`src/native/index.ts`) belongs to the backend family described in
`docs/gl/architecture/04-backend-family.md`. When you add, remove, rename or
change the signature of an exported function, update in the same change:

1. **Classification.** Add a backend-neutral operation to `GLOps` in
   `src/family.ts`, using family slots for backend types. Add an operation that
   creates or destroys an engine or exchanges data with host objects (DOM
   elements, WebGL handles, native texture handles) to that backend's host-ops
   interface instead (`WebGLHostOps` in `src/web-family.ts`, `NativeGLHostOps`
   in `src/native/family.ts`). An operation is not host-specific merely because
   one backend has not implemented it yet.
2. **Family mappings.** If the operation uses a new resource or data type, add
   a slot to `GLFamily` and map it in `WebGLFamily` and `NativeGLFamily` to the
   backend's real type, or to `never` where that backend does not implement the
   feature. Describe each backend's actual signature; do not widen or narrow an
   export, add an unused parameter, or add a runtime check to fit the contract.
   A new slot's setter is `never`, so backend-neutral code can obtain its
   values only from backend operations or a composition root. Only when every
   backend accepts a known set of values, add that set to
   `GLFamilyPortableValues` and use it as the setter type. Operations that take
   or return a render target use `GLRenderTargetOf<F>`.
3. **Uber-kits.** Add the direct export reference to `webUberKit` and/or
   `nativeUberKit` in `tests/gl/unit/gl-family-conformance.test.ts`.
4. **Docs.** Update the operation lists and slot table in
   `docs/gl/architecture/04-backend-family.md` alongside the feature's own spec.

The conformance test is the backstop: `tsc -p tests/gl/tsconfig.json` (run by
`pnpm run lint` and the CI "Lint & Type Check" job) fails while any export is
unclassified, missing from its uber-kit, or not identical to its family
signature. Fix the contract or the mapping; never exempt an export, cast a kit
member, or loosen the assertions.

A native resource type extends `NativeResource<Kind>` from
`src/native/identity.ts`, adding its kind to `NativeResourceKind`, so it stays
distinct from web resources and other native kinds once internal members are
removed from the published declarations. Extend the emitted-declaration fixture
in `tests/gl/build/public-api.test.ts` when you add one.

The family entry (`src/family.ts`) and the native entry must stay free of DOM
types and WebGL modules, and the family contract must stay types only: no
runtime kit, namespace facade or wrapper ships from the package.
