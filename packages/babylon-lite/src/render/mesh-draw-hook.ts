import type { Mesh } from "../mesh/mesh.js";
import type { DrawBinding } from "./renderable.js";

type MeshDrawWrap = (draw: DrawBinding["draw"], mesh: Mesh, colorOutput: boolean) => DrawBinding["draw"];

/** @internal Optional binding-level draw wrapper, installed only by runtime opt-ins. */
export let _meshDrawWrap: MeshDrawWrap | null = null;

/** @internal Apply previously installed wrappers first, preserving their draw contract. */
export function _installMeshDrawWrap(wrap: MeshDrawWrap): void {
    const previous = _meshDrawWrap;
    _meshDrawWrap = previous ? (draw, mesh, colorOutput) => wrap(previous(draw, mesh, colorOutput), mesh, colorOutput) : wrap;
}
