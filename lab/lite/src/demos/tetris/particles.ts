/**
 * Line-clear particle bursts.
 *
 * When a Tetris row clears, each cell in the cleared row explodes into a
 * shower of small tumbling cubes coloured like the original block. Particles
 * are integrated with gravity, rotate freely, and shrink to nothing over their
 * short life.
 *
 * Spawn point: just IN FRONT of the board (positive Z, beyond the front face
 * of the unit-scale blocks at z=0.46). This avoids the rows that have just
 * shifted down into the cleared cell from occluding the explosion. Particles
 * are also given a forward velocity bias so they fly toward the camera, away
 * from the playfield plane, where they're never depth-fought by board blocks.
 *
 * Pattern: one shared unlit vertex-colour shader material, one tiny cube mesh
 * per live particle, animated purely by transform. Per-particle meshes are
 * cheap because the shader pipeline is cached across them, and addToScene /
 * removeFromScene only churns the renderable list a handful of times per line
 * clear (an infrequent event).
 */

import {
    addToScene,
    createMeshFromData,
    createShaderMaterial,
    removeFromScene,
    setShaderFloat,
    type EngineContext,
    type Mesh,
    type SceneContext,
    type ShaderMaterial,
} from "babylon-lite";

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

const CUBE_POS = new Float32Array([
    -0.5, -0.5, -0.5, 0.5, -0.5, -0.5, 0.5, 0.5, -0.5, -0.5, 0.5, -0.5, -0.5, -0.5, 0.5, 0.5, -0.5, 0.5, 0.5, 0.5, 0.5, -0.5, 0.5, 0.5,
]);
const CUBE_IDX = new Uint32Array([
    0, 1, 2, 0, 2, 3, 1, 5, 6, 1, 6, 2, 5, 4, 7, 5, 7, 6, 4, 0, 3, 4, 3, 7, 3, 2, 6, 3, 6, 7, 4, 5, 1, 4, 1, 0,
]);
const GRAVITY = 22;

interface Particle {
    mesh: Mesh;
    vx: number;
    vy: number;
    vz: number;
    spinX: number;
    spinY: number;
    spinZ: number;
    life: number;
    maxLife: number;
    size: number;
}

export class TetrisParticles {
    private readonly engine: EngineContext;
    private readonly scene: SceneContext;
    private readonly material: ShaderMaterial;
    private readonly live: Particle[] = [];
    private counter = 0;

    constructor(engine: EngineContext, scene: SceneContext) {
        this.engine = engine;
        this.scene = scene;
        this.material = createShaderMaterial({
            name: "tetrisParticles",
            vertexSource,
            fragmentSource,
            attributes: ["position", "color"],
            uniforms: ["worldViewProjection", { name: "brightness", type: "f32", defaultValue: 1.6 }],
        });
        setShaderFloat(this.material, "brightness", 2.4);

        // Register the shader-material build group with the scene at boot time.
        // Without this, the group's deferred builder never runs (it's added to
        // _deferredBuilders post-boot when the first burst() spawns a mesh, but
        // _deferredBuilders is only drained once during buildScene). With no
        // builder run, the group's _rebuildSingle is undefined and any later
        // enqueueMaterialSwap silently skips the mesh — so particles spawn but
        // never get a renderable. A single hidden dummy mesh added now forces
        // the group to be registered + built before the scene boots.
        const dummyColors = new Float32Array(CUBE_POS.length / 3 * 4);
        const dummy = createMeshFromData(
            engine,
            "tetris_particle_seed",
            CUBE_POS,
            new Float32Array(CUBE_POS.length),
            CUBE_IDX,
            undefined,
            undefined,
            undefined,
            dummyColors,
        );
        dummy.material = this.material;
        // Park the dummy just below the floor and shrink it to nothing so it
        // can never be visible. (Renderable still gets built, which is the
        // whole point.) NOTE: keep this near the scene origin — the scene
        // auto-sizes the skybox from mesh *translation* bounds (ignoring our
        // scale=0), so parking it at a huge offset would blow the skybox up
        // past the camera far plane and clip the background away entirely.
        dummy.position.y = -2;
        dummy.scaling.x = 0;
        dummy.scaling.y = 0;
        dummy.scaling.z = 0;
        addToScene(scene, dummy);
    }

    /** Spawn a small burst of cubes at a cell centre, tinted by `color` (0..1 rgb). */
    burst(cx: number, cy: number, cz: number, color: readonly [number, number, number], count = 16): void {
        const colors = new Float32Array(8 * 4);
        for (let i = 0; i < 8; i++) {
            colors[i * 4] = color[0];
            colors[i * 4 + 1] = color[1];
            colors[i * 4 + 2] = color[2];
            colors[i * 4 + 3] = 1;
        }
        for (let i = 0; i < count; i++) {
            const mesh = createMeshFromData(
                this.engine,
                `tetris_pt_${this.counter++}`,
                CUBE_POS,
                new Float32Array(CUBE_POS.length),
                CUBE_IDX,
                undefined,
                undefined,
                undefined,
                colors,
            );
            mesh.material = this.material;
            mesh.renderOrder = 2000;
            const size = 0.14 + Math.random() * 0.16;
            mesh.position.x = cx + (Math.random() - 0.5) * 0.6;
            mesh.position.y = cy + (Math.random() - 0.5) * 0.6;
            mesh.position.z = cz + 0.55 + Math.random() * 0.35;
            mesh.scaling.x = size;
            mesh.scaling.y = size;
            mesh.scaling.z = size;
            addToScene(this.scene, mesh);
            const ang = Math.random() * Math.PI * 2;
            const speed = 3 + Math.random() * 4;
            const life = 0.85 + Math.random() * 0.55;
            this.live.push({
                mesh,
                vx: Math.cos(ang) * speed,
                vy: 3 + Math.random() * 4,
                vz: 2.5 + Math.random() * 4,
                spinX: (Math.random() - 0.5) * 18,
                spinY: (Math.random() - 0.5) * 18,
                spinZ: (Math.random() - 0.5) * 18,
                life,
                maxLife: life,
                size,
            });
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
            p.mesh.rotation.x += p.spinX * dt;
            p.mesh.rotation.y += p.spinY * dt;
            p.mesh.rotation.z += p.spinZ * dt;
            const t = p.life / p.maxLife;
            const s = p.size * (t * t);
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
