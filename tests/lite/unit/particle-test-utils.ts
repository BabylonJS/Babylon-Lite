import {
    animateParticleSystem,
    buildNodeParticleSet,
    parseNodeParticleSource,
    startParticleSystem,
    type BuildNodeParticleOptions,
    type ParticleSystem,
} from "../../../packages/babylon-lite/src/index";
import type { EngineContext } from "../../../packages/babylon-lite/src/engine/engine";
import type { SceneContext } from "../../../packages/babylon-lite/src/scene/scene";

export interface ParticleSnapshot {
    id: number;
    position: { x: number; y: number; z: number };
    direction: { x: number; y: number; z: number };
    color: { r: number; g: number; b: number; a: number };
    size: number;
    scale: { x: number; y: number };
    angle: number;
    age: number;
    lifeTime: number;
    cellIndex?: number;
}

export async function buildNodeParticleGraph(source: unknown, options: BuildNodeParticleOptions = {}, scene = {} as SceneContext): Promise<ParticleSystem> {
    const graph = parseNodeParticleSource(source);
    const set = await buildNodeParticleSet({} as EngineContext, scene, graph, options);
    return set.systems[0]!;
}

export async function simulateNodeParticleGraph(source: unknown, steps: number, options: BuildNodeParticleOptions = {}): Promise<ParticleSystem> {
    const system = await buildNodeParticleGraph(source, options);
    const previousRandom = Math.random;
    let seed = 1;
    Math.random = () => {
        const value = Math.sin(seed++) * 10000;
        return value - Math.floor(value);
    };
    try {
        startParticleSystem(system);
        for (let step = 0; step < steps; step++) {
            animateParticleSystem(system, 1);
        }
    } finally {
        Math.random = previousRandom;
    }
    return system;
}

export function snapshotParticles(system: ParticleSystem): ParticleSnapshot[] {
    const buffer = system.buffer;
    const size = buffer.size;
    const scaleX = buffer.scaleX;
    const scaleY = buffer.scaleY;
    const angle = buffer.angle;
    const colorR = buffer.colorR;
    const colorG = buffer.colorG;
    const colorB = buffer.colorB;
    const colorA = buffer.colorA;
    const cellIndex = system._spriteSheet?.cellIndex;
    const particles: ParticleSnapshot[] = [];

    for (let index = 0; index < buffer.alive; index++) {
        particles.push({
            id: buffer.id[index]!,
            position: { x: buffer.posX[index]!, y: buffer.posY[index]!, z: buffer.posZ[index]! },
            direction: { x: buffer.dirX[index]!, y: buffer.dirY[index]!, z: buffer.dirZ[index]! },
            color: { r: colorR[index]!, g: colorG[index]!, b: colorB[index]!, a: colorA[index]! },
            size: size[index]!,
            scale: { x: scaleX[index]!, y: scaleY[index]! },
            angle: angle[index]!,
            age: buffer.age[index]!,
            lifeTime: buffer.lifeTime[index]!,
            cellIndex: cellIndex?.[index],
        });
    }

    return particles.sort((left, right) => left.id - right.id);
}
