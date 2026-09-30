// s38metrics.mjs — the measurement definitions the friction dam-break studies add (s38-dambreak.mjs; FRICTION-spec
// revision 2, vault fluid/realism-2026-09/FRICTION-spec.md §4 W2b–W2e). The shared S3.4 definitions — columnScore, the
// Martin & Moyce and ETSIN 600 mm data — stay in s34metrics.mjs.

/** Lobovský et al. 2014 Fig. 12 (left), ETSIN H = 300 mm: n² = H/L = 0.5 (their 600 mm reservoir, "placed 600 mm from
 *  the lateral side", §2.3), the gate lifted at a median 3.46 m/s (§4.2); the wave-tip position X = x/H (x from the gate)
 *  against t* = t·√(g/H), t from the gate's first motion (§2.5.3). Copied by script, unchanged, from the vault's exact
 *  extraction of the PDF's vector drawing (arXiv 1308.0115) — fluid/realism-2026-09/calc/dam-break/
 *  lobovsky2014_fig12_left.json, key 'ETSIN_H0.3', 117 points (the file's sha256 a2bd3ea0e02891f121c54cb91f59ce1c
 *  6183f53034b90d88869af591d856272c; s34metrics' ETSIN600 is its 'ETSIN_H0.6'). */
export const ETSIN300 = {
  T: [-0.0003, 0.0185, 0.0376, 0.1329, 0.152, 0.1711, 0.1902, 0.2093, 0.2284, 0.2475, 0.2664, 0.3046, 0.3237, 0.3428, 0.3619, 0.3807, 0.3998, 0.4189, 0.438, 0.4571, 0.4763, 0.4954, 0.5142, 0.5333, 0.5524, 0.5715, 0.5906, 0.6097, 0.6285, 0.6477, 0.6668, 0.6859, 0.705, 0.7241, 0.7432, 0.762, 0.7811, 0.8002, 0.8193, 0.8575, 0.8764, 0.8955, 0.9337, 0.9528, 0.9719, 0.991, 1.0098, 1.0289, 1.048, 1.0863, 1.1054, 1.1242, 1.1433, 1.1624, 1.2006, 1.2197, 1.2388, 1.2577, 1.2768, 1.2959, 1.315, 1.3341, 1.3532, 1.372, 1.3911, 1.4102, 1.4293, 1.4484, 1.4675, 1.4867, 1.5055, 1.5246, 1.5437, 1.5628, 1.5819, 1.601, 1.6198, 1.639, 1.6581, 1.6772, 1.6963, 1.7154, 1.7345, 1.7533, 1.7724, 1.8106, 1.8297, 1.8488, 1.8679, 1.8868, 1.925, 1.9441, 1.9632, 1.9823, 2.0011, 2.0202, 2.0393, 2.0585, 2.0776, 2.0967, 2.1158, 2.1346, 2.1537, 2.1728, 2.1919, 2.211, 2.2301, 2.249, 2.2681, 2.2872, 2.3063, 2.3254, 2.3445, 2.3636, 2.3824, 2.4015, 2.4206],
  X: [0.0007, 0.0044, 0.0148, 0.0832, 0.0957, 0.1076, 0.118, 0.1305, 0.1497, 0.1673, 0.1849, 0.2161, 0.2404, 0.2581, 0.2877, 0.3053, 0.3245, 0.337, 0.3525, 0.3702, 0.3821, 0.4018, 0.421, 0.4381, 0.4521, 0.4698, 0.4853, 0.5045, 0.5222, 0.5398, 0.5538, 0.5694, 0.5834, 0.601, 0.6166, 0.6358, 0.6519, 0.669, 0.6903, 0.7359, 0.7567, 0.7811, 0.8267, 0.8475, 0.8776, 0.8947, 0.9196, 0.9404, 0.9736, 1.0223, 1.0436, 1.0732, 1.0996, 1.124, 1.1697, 1.1977, 1.2221, 1.248, 1.276, 1.3025, 1.3233, 1.3534, 1.3814, 1.4094, 1.4369, 1.4633, 1.4929, 1.5209, 1.551, 1.5733, 1.6034, 1.6263, 1.6543, 1.6787, 1.7046, 1.7274, 1.7658, 1.7938, 1.8271, 1.8535, 1.8795, 1.9111, 1.9407, 1.9687, 2.0003, 2.0564, 2.088, 2.114, 2.1493, 2.1773, 2.2364, 2.2681, 2.3028, 2.336, 2.3677, 2.3973, 2.4289, 2.4517, 2.4953, 2.527, 2.5602, 2.597, 2.6229, 2.6619, 2.6894, 2.7231, 2.7563, 2.7874, 2.8227, 2.8507, 2.8855, 2.9135, 2.9451, 2.9815, 3.0064, 3.0432, 3.078],
}
/** Their downstream wall, 1.01 m from the gate (§2.3): X = 1.01/0.3. */
export const ETSIN300_WALL_X = 1.01 / 0.3
/** The points before their wall (X < wall − 0.01, as s34metrics' ETSIN600_FRONT; all 117 are, max X = 3.078). */
export const ETSIN300_FRONT = (() => {
  const k = ETSIN300.X.map((x, i) => i).filter(i => ETSIN300.X[i] < ETSIN300_WALL_X - 0.01)
  return { T: k.map(i => ETSIN300.T[i]), X: k.map(i => ETSIN300.X[i]) }
})()

/** The fixed-depth front — spec W2b's "0.5 cm front", the scratch operator of FR/spec/a2_shear_p.mjs, kept verbatim: the
 *  farthest one-cell x-slab whose mean liquid depth count·V_p/(nz·h²) ≥ d0 (V_p = h³/ppc, the solver's particle volume);
 *  x_f is that slab's leading edge. At d0 = h/2 it is s34scenes' frontSlab (the r3 §1 bulk slab); a fixed d0 keeps one
 *  physical threshold across resolutions. */
export function depthFront(pos, n, h, nz, d0, ppc = 8) {
  const cnt = new Map()
  for (let q = 0; q < n; q++) { const i = Math.floor(pos[3 * q] / h); cnt.set(i, (cnt.get(i) ?? 0) + 1) }
  const need = d0 * nz * h * h / (h ** 3 / ppc)
  let best = -1
  for (const [i, c] of cnt) if (c >= need - 1e-9 && i > best) best = i
  return (best + 1) * h
}
