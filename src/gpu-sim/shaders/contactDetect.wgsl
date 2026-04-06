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

// ── Particle layout (64 bytes) — read-only, same as other shaders ────────
struct Particle {
    pos:             vec3<f32>,
    composition_id:  u32,
    vel:             vec3<f32>,
    temperature:     f32,
    C0:              vec2<f32>,
    C1:              vec2<f32>,
    phase:           u32,
    _pad:            vec3<f32>,
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

    // Only check j > i to avoid duplicate pairs
    for (var j: u32 = i + 1u; j < params.num_particles; j++) {
        let pj = particles[j];

        // Skip same composition
        if (pi.composition_id == pj.composition_id) { continue; }

        // Distance squared
        let diff = pi.pos - pj.pos;
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
