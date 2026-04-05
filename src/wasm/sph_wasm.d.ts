/* tslint:disable */
/* eslint-disable */

export class Simulation {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Add particles. positions is interleaved [x,y,z, x,y,z, ...]
     */
    add_particles(positions: Float32Array, material_index: number): number;
    get_count(): number;
    /**
     * Get material indices
     */
    get_materials(): Uint8Array;
    /**
     * Get positions as interleaved Float32Array [x,y,z, x,y,z, ...]
     */
    get_positions(): Float32Array;
    /**
     * Get velocities as interleaved Float32Array
     */
    get_velocities(): Float32Array;
    constructor();
    reset(): void;
    /**
     * Run one full SPH step with sub-stepping
     */
    step(gravity: number, dt: number, sub_steps: number): void;
}

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_simulation_free: (a: number, b: number) => void;
    readonly simulation_add_particles: (a: number, b: number, c: number, d: number) => number;
    readonly simulation_get_count: (a: number) => number;
    readonly simulation_get_materials: (a: number) => [number, number];
    readonly simulation_get_positions: (a: number) => [number, number];
    readonly simulation_get_velocities: (a: number) => [number, number];
    readonly simulation_new: () => number;
    readonly simulation_reset: (a: number) => void;
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
