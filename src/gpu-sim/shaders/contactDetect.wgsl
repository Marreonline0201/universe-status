// contactDetect.wgsl — Naive O(n²) contact detection between particles
// of different compositions. Writes unique pairs (i < j) to a contact buffer.

// ── Constants ────────────────────────────────────────────────────────────────
const CONTACT_RADIUS_SQ: f32 = 0.0004;   // distance² threshold
const MAX_CONTACTS: u32      = 10000u;    // maximum number of contact pairs

// ── Uniforms ─────────────────────────────────────────────────────────────────
struct SimParams {
    dt:             f32,
    gravity:        f32,
    num_particles:  u32,
    _pad:           u32,
};

// ── Particle layout (64 bytes, scalar fields to avoid vec3 alignment gaps) ───
struct Particle {
    pos_x: f32, pos_y: f32, pos_z: f32,   // bytes  0-11
    composition_id:  u32,                   // bytes 12-15
    vel_x: f32, vel_y: f32, vel_z: f32,   // bytes 16-27
    temperature:     f32,                   // bytes 28-31
    C0:              vec2<f32>,             // bytes 32-39 (align 8, OK)
    C1:              vec2<f32>,             // bytes 40-47 (align 8, OK)
    phase:           u32,                   // bytes 48-51
    _pad0: u32,                            // bytes 52-55
    _pad1: u32, _pad2: u32,               // bytes 56-63
};

// ── Contact pair output ──────────────────────────────────────────────────────
struct ContactPair {
    particle_a: u32,
    particle_b: u32,
};

// ── Counter (atomic) ─────────────────────────────────────────────────────────
struct Counter {
    count: atomic<u32>,
};

// ── Bindings ─────────────────────────────────────────────────────────────────
@group(0) @binding(0) var<storage, read>       particles: array<Particle>;
@group(0) @binding(1) var<storage, read_write> contacts:  array<ContactPair>;
@group(0) @binding(2) var<storage, read_write> counter:   Counter;
@group(0) @binding(3) var<uniform>             params:    SimParams;

// ── Main ─────────────────────────────────────────────────────────────────────
@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
    let i = id.x;
    if (i >= params.num_particles) { return; }

    let pi = particles[i];
    let pos_i = vec3<f32>(pi.pos_x, pi.pos_y, pi.pos_z);

    // Only check j > i to avoid duplicate pairs
    for (var j: u32 = i + 1u; j < params.num_particles; j++) {
        let pj = particles[j];

        // Skip same composition
        if (pi.composition_id == pj.composition_id) { continue; }

        // Distance squared
        let pos_j = vec3<f32>(pj.pos_x, pj.pos_y, pj.pos_z);
        let diff = pos_i - pos_j;
        let dist_sq = dot(diff, diff);

        if (dist_sq < CONTACT_RADIUS_SQ) {
            // Atomically allocate a slot
            let slot = atomicAdd(&counter.count, 1u);
            if (slot >= MAX_CONTACTS) {
                // Buffer full — undo and stop
                atomicSub(&counter.count, 1u);
                return;
            }
            contacts[slot] = ContactPair(i, j);
        }
    }
}
