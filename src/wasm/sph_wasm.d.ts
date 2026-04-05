/* tslint:disable */
/* eslint-disable */

export class Simulation {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Add particles with a specific starting temperature
     */
    add_particles(positions: Float32Array, mat_idx: number): number;
    /**
     * Add particles with explicit temperature (-999 = use material default)
     */
    add_particles_with_temp(positions: Float32Array, mat_idx: number, temp: number): number;
    get_count(): number;
    get_materials(): Uint8Array;
    /**
     * Get phase state per particle (0=liquid, 1=gas, 2=solid)
     */
    get_phases(): Uint8Array;
    get_positions(): Float32Array;
    /**
     * §3.0: get temperature per particle for visualization
     */
    get_temperatures(): Float32Array;
    get_velocities(): Float32Array;
    constructor();
    reset(): void;
    /**
     * Set floor temperature (simulates heated/cooled surface)
     */
    set_heat_source(_floor_temp: number): void;
    step(gravity: number, dt: number, sub_steps: number): void;
}

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_simulation_free: (a: number, b: number) => void;
    readonly simulation_add_particles: (a: number, b: number, c: number, d: number) => number;
    readonly simulation_add_particles_with_temp: (a: number, b: number, c: number, d: number, e: number) => number;
    readonly simulation_get_count: (a: number) => number;
    readonly simulation_get_materials: (a: number) => [number, number];
    readonly simulation_get_phases: (a: number) => [number, number];
    readonly simulation_get_positions: (a: number) => [number, number];
    readonly simulation_get_temperatures: (a: number) => [number, number];
    readonly simulation_get_velocities: (a: number) => [number, number];
    readonly simulation_new: () => number;
    readonly simulation_reset: (a: number) => void;
    readonly simulation_set_heat_source: (a: number, b: number) => void;
    readonly simulation_step: (a: number, b: number, c: number, d: number) => void;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
