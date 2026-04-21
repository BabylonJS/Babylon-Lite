/** KHR_animation_pointer — JSON-pointer resolver registry.
 *  Handlers are registered incrementally (one per parity scene). Unknown
 *  pointers return null and warn once. */
import type { SceneNode } from "../scene/scene-node.js";
import { setSubtreeVisible } from "../scene/visibility.js";

export interface ResolvedPointer {
    writer: (output: Float32Array, offset: number) => void;
    arity: number;
}

export interface PointerContext {
    nodes: readonly (SceneNode | undefined)[];
}

type PointerFactory = (match: RegExpExecArray, ctx: PointerContext) => ResolvedPointer | null;

const _registry: [RegExp, PointerFactory][] = [
    // /nodes/{n}/extensions/KHR_node_visibility/visible — scalar (0 = hidden).
    // The setter cascade handles descendants per the KHR_node_visibility spec
    // and bumps the module-scoped visibility epoch so the engine invalidates
    // its cached render bundle.
    [
        /^\/nodes\/(\d+)\/extensions\/KHR_node_visibility\/visible$/,
        (m, ctx) => {
            const n = ctx.nodes[+m[1]!];
            if (!n) {
                return null;
            }
            return {
                arity: 1,
                writer: (out, off) => {
                    setSubtreeVisible(n, out[off]! !== 0);
                },
            };
        },
    ],
];

const _warned = new Set<string>();

export function resolveAnimationPointer(pointer: string, ctx: PointerContext): ResolvedPointer | null {
    for (const [rx, make] of _registry) {
        const m = rx.exec(pointer);
        if (m) {
            return make(m, ctx);
        }
    }
    if (!_warned.has(pointer)) {
        _warned.add(pointer);

        console.warn(`[babylon-lite] KHR_animation_pointer: no handler for "${pointer}"`);
    }
    return null;
}
