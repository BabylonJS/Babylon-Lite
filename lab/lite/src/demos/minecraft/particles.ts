// Block-break particle burst. Spawns a handful of small tumbling cubes coloured
// like the broken block, integrated with gravity and shrinking over their short
// life, then removed. One shared unlit vertex-colour material is used for every
// particle; each particle is its own tiny cube mesh animated purely by transform
// (no per-frame vertex rebuilds). Churn is safe thanks to deferred GPU disposal
// being handled by the engine's scene removal.

import { addToScene, createMeshFromData, createShaderMaterial, removeFromScene, setShaderFloat, type EngineContext, type Mesh, type SceneContext, type ShaderMaterial } from "babylon-lite";

const vertexSource = `struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) color: vec4<f32>,
};
@vertex fn mainVertex(input: VertexInput) -> VertexOutput {
  var out: VertexOutput;
  out.position = shaderSystem.worldViewProjection * vec4<f32>(input.position, 1.0);
  out.color = input.color;
  return out;
}`;

const fragmentSource = `struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) color: vec4<f32>,
};
@fragment fn mainFragment(input: VertexOutput) -> @location(0) vec4<f32> {
  return vec4<f32>(input.color.rgb * shaderUniforms.brightness, 1.0);
}`;

// Unit cube centred on the origin (8 corners, 12 triangles). Unlit, so no normals.
const CUBE_POS = new Float32Array([
    -0.5, -0.5, -0.5, 0.5, -0.5, -0.5, 0.5, 0.5, -0.5, -0.5, 0.5, -0.5, -0.5, -0.5, 0.5, 0.5, -0.5, 0.5, 0.5, 0.5, 0.5, -0.5, 0.5, 0.5,
]);
const CUBE_IDX = new Uint32Array([
    0, 1, 2, 0, 2, 3, 1, 5, 6, 1, 6, 2, 5, 4, 7, 5, 7, 6, 4, 0, 3, 4, 3, 7, 3, 2, 6, 3, 6, 7, 4, 5, 1, 4, 1, 0,
]);
const GRAVITY = 16;

interface Particle {
    mesh: Mesh;
    vx: number;
    vy: number;
    vz: number;
    spin: number;
    life: number;
    maxLife: number;
    size: number;
}

export class ParticleSystem {
    private readonly engine: EngineContext;
    private readonly scene: SceneContext;
    private readonly material: ShaderMaterial;
    private readonly live: Particle[] = [];
    private counter = 0;

    constructor(engine: EngineContext, scene: SceneContext) {
        this.engine = engine;
        this.scene = scene;
        this.material = createShaderMaterial({
            name: "mcParticles",
            vertexSource,
            fragmentSource,
            attributes: ["position", "color"],
            uniforms: ["worldViewProjection", { name: "brightness", type: "f32", defaultValue: 1 }],
        });
        setShaderFloat(this.material, "brightness", 1);
    }

    /** Spawn a small burst of cubes at a block centre, tinted by `color` (0..1 rgb). */
    burst(cx: number, cy: number, cz: number, color: readonly [number, number, number], count = 10): void {
        const colors = new Float32Array(8 * 4);
        for (let i = 0; i < 8; i++) {
            colors[i * 4] = color[0];
            colors[i * 4 + 1] = color[1];
            colors[i * 4 + 2] = color[2];
            colors[i * 4 + 3] = 1;
        }
        for (let i = 0; i < count; i++) {
            const mesh = createMeshFromData(this.engine, `mc_pt_${this.counter++}`, CUBE_POS, new Float32Array(CUBE_POS.length), CUBE_IDX, undefined, undefined, undefined, colors);
            mesh.material = this.material;
            mesh.renderOrder = 2000;
            const size = 0.1 + Math.random() * 0.12;
            mesh.position.x = cx + (Math.random() - 0.5) * 0.6;
            mesh.position.y = cy + (Math.random() - 0.5) * 0.6;
            mesh.position.z = cz + (Math.random() - 0.5) * 0.6;
            mesh.scaling.x = size;
            mesh.scaling.y = size;
            mesh.scaling.z = size;
            addToScene(this.scene, mesh);
            this.live.push({
                mesh,
                vx: (Math.random() - 0.5) * 4,
                vy: 2 + Math.random() * 3.5,
                vz: (Math.random() - 0.5) * 4,
                spin: (Math.random() - 0.5) * 12,
                life: 0.5 + Math.random() * 0.35,
                maxLife: 0,
                size,
            });
            const p = this.live[this.live.length - 1]!;
            p.maxLife = p.life;
        }
    }

    /** Integrate all live particles; remove expired ones. Call once per frame. */
    update(dt: number): void {
        for (let i = this.live.length - 1; i >= 0; i--) {
            const p = this.live[i]!;
            p.life -= dt;
            if (p.life <= 0) {
                removeFromScene(this.scene, p.mesh);
                this.live.splice(i, 1);
                continue;
            }
            p.vy -= GRAVITY * dt;
            p.mesh.position.x += p.vx * dt;
            p.mesh.position.y += p.vy * dt;
            p.mesh.position.z += p.vz * dt;
            p.mesh.rotation.x += p.spin * dt;
            p.mesh.rotation.y += p.spin * 0.7 * dt;
            const s = p.size * (p.life / p.maxLife);
            p.mesh.scaling.x = s;
            p.mesh.scaling.y = s;
            p.mesh.scaling.z = s;
        }
    }

    dispose(): void {
        for (const p of this.live) removeFromScene(this.scene, p.mesh);
        this.live.length = 0;
    }
}
