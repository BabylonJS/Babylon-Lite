/** Scene 65 — NME with ESM shadow receive.
 *
 *  Graph is identical to scene 63 (LightBlock → FragmentOutput). The shadow
 *  contribution is applied automatically *inside* `nme_computeLighting` by
 *  multiplying per-light diffuse+specular by the factor produced by the
 *  pipeline-generated `nme_computeShadowFactors(in)` helper, which itself is
 *  only emitted when `parseNodeMaterialFromSnippet` is called with a
 *  non-empty `shadowGenerators` array.
 *
 *  The JSON proves that the *same* NME JSON renders identically with or
 *  without shadows — the shadow integration is an external concern, not a
 *  graph-level one. Scene 65 simply reuses the scene 63 graph and adds a
 *  shadow generator + ground receiver + sphere caster on the scene side.
 */
export { SCENE63_NME_JSON as SCENE65_NME_JSON } from "./scene63-nme.js";
