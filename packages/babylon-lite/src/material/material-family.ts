import type { Material } from "./material.js";
import { getMaterialSource } from "./material-view.js";

/** Public, read-only material-family discriminator.
 *
 *  Returns a stable string identifying which concrete family a material belongs
 *  to, without exposing any renderer internals or requiring callers to inspect
 *  private fields / property-shape heuristics.
 *
 *  Returns one of the core family strings:
 *  - `"pbr"`       — {@link createPbrMaterial}
 *  - `"standard"`  — {@link createStandardMaterial}
 *  - `"shader"`    — {@link createShaderMaterial} (and materials built on it, e.g. the grid material)
 *  - `"node"`      — {@link parseNodeMaterialFromSnippet}
 *
 *  Returns `undefined` when a material carries a builder that declares no family,
 *  or when the object has no builder at all — because `_buildGroup` is `@internal`
 *  and trimmed from the published `.d.ts`, a caller may legally pass a plain
 *  material-like object (e.g. `{ name, metadata }`), so this reads the builder
 *  defensively and never throws. In practice a missing family only arises for a
 *  handful of internal materials; every public factory tags its family. The material-builder surface (`_buildGroup`) is
 *  internal, so consumers of the published package cannot author their own
 *  builder — a user "custom material" is created through {@link createShaderMaterial}
 *  (reported as `"shader"`) or {@link parseNodeMaterialFromSnippet} (`"node"`), so
 *  `getMaterialFamily` will not return an arbitrary user-defined string today.
 *  The `undefined` case is deliberately discoverable from the signature so callers
 *  explicitly handle the unknown family.
 *
 *  A {@link MaterialView} reports the family of its underlying `source` material.
 *
 *  The return type is intentionally a raw `string`, not a string-literal union, so
 *  a new core family can be introduced without it being a breaking change (and so
 *  the function stays forward-compatible if a public custom-family builder API is
 *  added later — it would pass any tagged string through unchanged). Treat the
 *  values above as the documented set to match against. */
export function getMaterialFamily(material: Material): string | undefined {
    return getMaterialSource(material)._buildGroup?._materialFamily;
}
