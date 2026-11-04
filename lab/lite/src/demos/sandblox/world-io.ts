/**
 * World IO — the single serialization format for part worlds.
 *
 * Used by BOTH persistence (localStorage saves) and the map layer (bundled
 * default map + export/import). One schema, one parser, defensive loading:
 * a malformed entry skips that part instead of black-screening the boot
 * (lesson from a corrupted save).
 *
 * Schema (compact keys, version 1):
 *   { version: 1, parts: [{ s: [x,y,z], p: [x,y,z], q: [x,y,z,w], c: [r,g,b], sh?: 1 }] }
 *   `sh`: 0/absent = block, 1 = wedge.
 */

import type { Part, PartOptions } from "./part.js";
import type { Workspace } from "./workspace.js";

export interface WorldPartData {
    readonly s: [number, number, number];
    readonly p: [number, number, number];
    readonly q: [number, number, number, number];
    readonly c: [number, number, number];
    readonly sh?: number;
}

export interface WorldJson {
    readonly version: 1;
    readonly parts: WorldPartData[];
}

/** Serialize every UNLOCKED part (the baseplate never travels). */
export function serializeWorld(workspace: Workspace<Part>): WorldJson {
    const parts: WorldPartData[] = [];
    for (const part of workspace.parts) {
        if (part.locked) {
            continue;
        }
        const data: WorldPartData = {
            s: [...part.size] as [number, number, number],
            p: [part.position.x, part.position.y, part.position.z],
            q: [part.rotation.x, part.rotation.y, part.rotation.z, part.rotation.w],
            c: [...part.color] as [number, number, number],
            ...(part.shape === "wedge" ? { sh: 1 } : {}),
        };
        parts.push(data);
    }
    return { version: 1, parts };
}

function isVec(v: unknown, n: number): v is number[] {
    return Array.isArray(v) && v.length === n && v.every((x) => typeof x === "number" && Number.isFinite(x));
}

/**
 * Instantiate a serialized world via the part factory. Returns the number of
 * parts created. Invalid entries are skipped (warn once per load).
 */
export function loadWorld(json: unknown, createPart: (options: PartOptions) => Part): number {
    const file = json as Partial<WorldJson> | null;
    if (!file || file.version !== 1 || !Array.isArray(file.parts)) {
        return 0;
    }
    let created = 0;
    let skipped = 0;
    for (const entry of file.parts) {
        const e = entry as Partial<WorldPartData>;
        if (!isVec(e.s, 3) || !isVec(e.p, 3) || !isVec(e.q, 4) || !isVec(e.c, 3)) {
            skipped++;
            continue;
        }
        try {
            const size: [number, number, number] = [Math.max(1, e.s[0]!), Math.max(1, e.s[1]!), Math.max(1, e.s[2]!)];
            const part = createPart({
                size,
                position: { x: e.p![0]!, y: e.p![1]!, z: e.p![2]! },
                color: e.c as [number, number, number],
                shape: e.sh === 1 ? "wedge" : "block",
            });
            part.setRotation({ x: e.q![0]!, y: e.q![1]!, z: e.q![2]!, w: e.q![3]! });
            created++;
        } catch {
            skipped++;
        }
    }
    if (skipped > 0) {
        console.warn(`world-io: skipped ${skipped} invalid part(s) while loading`);
    }
    return created;
}
