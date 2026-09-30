#!/usr/bin/env node
// Gate S3.8 on the f64 CPU reference — the floor's wall shear (bed friction for the dam-break front): the off switch
// and the viscous guard (W0) and implementation fidelity against analytic answers (W1). Spec: vault
// fluid/realism-2026-09/FRICTION-spec.md, revision 2 — §4 W0–W1; the law §2.1/§2.4, the inputs §2.2, the update
// §3.2/§3.4, the placement §3.1. The stage under test: FlipRef options.wallShear (flipRef.ts applyWallShear, keuleganTau,
// and the guard in step()).
//
//   node scripts/fluid-gates/s38-ref.mjs                    (every section)
//   node scripts/fluid-gates/s38-ref.mjs --only=W1b,W1aK     (sections W0a, W0b, W0c, W1a, W1aK, W1b, W1c, W1d,
//                                                            comma-separated; s38-mutations.mjs runs the sections of
//                                                            the checks each mutant must fail)
//   node scripts/fluid-gates/s38-ref.mjs --only=W0a --w0a-pinned   (W0a plus its recorded one-time comparison against
//                                                            7b248dc4 — see W0a; any other argument is refused)
//
// Criteria fixed 2026-09-30, written here before this file's first run. Every oracle is computed HERE: the Keulegan
// constants a_s = 5.5, b = 2.5 (eq. 13–14) and the branch crossing Re_c are this file's own literals and bisection (never
// flipRef's KEULEGAN_AS / KEULEGAN_B / WALL_SHEAR_RE_CROSS), eq. 32 is solved by bisection (the stage uses Newton), floor
// cells are binned here by ⌊y/dx⌋ = 0 from the particles; from the solver the gate reads only state — particles, the
// stage's log (wallShearLog) and per-cell field (wallShearField), face labels and pressures — never a constant under test.
// Output: `PASS|FAIL <label> …`. A line `PASS ctl:<label>` is an in-file positive control that FAILED its criterion as
// required; `FAIL ctl:<label>` means the check could not see it (a gate failure); `VOID <label>` is a check whose scene
// failed its own validity check — uncertified, counted neither pass nor fail (revision below). Every must-pass case and
// every in-file control run in the same run. The controls that are defects of flipRef itself (the spec's W3 CPU table) run in
// s38-mutations.mjs: one find/replace per run on a copy of src, this gate run against the copy (FLUID_REF_SRC).
// Every stage-on check asserts non-vacuity from the stage's own log (spec §4: Σ|booked| > 0 and cells acted on > 0;
// s34-ref.mjs:143 "an unknown name would run nothing and print PASS").
// Solver options: s34-ref's (the ghost-fluid solver with the density projection, pressure 1e-6 / ψ 1e-5 unless a scene
// says otherwise; s34scenes' column() uses 1e-5 / 1e-4). The scene builders are imported from lib/s34scenes.mjs, never
// copied (spec §3.6: a copy of the harness would drift from A2g's own).
//
// W0a  off = the tree with the stage never entered [spec §4 W0a; §3.2 "bit-identical to HEAD"; the x11 gate-option
//      pattern "two scenes, 0 differing words"]. REDESIGNED 2026-09-30 (review wf_fbc58c55-116 GATE-F2; pre-registered
//      2026-09-30 before its first run): the check had compared the tree with 7b248dc4's solver, so any later arithmetic
//      change on the column or pool path turned it red with the stage untouched — and s38-mutations then scored a
//      default-on stage SURVIVED (the stale pin made the whole label unusable). Same-tree checks now, per scene, with the
//      option ABSENT: (W0a.<scene>.entered) a subclass counting applyWallShear's entries records 0, and the stage's log is
//      empty; (W0a.<scene>) every 64-bit word of the particle state (pos, vel, c, mass) equals that of the same tree
//      with its single call statement `this.applyWallShear(p, dt)` (flipRef.ts step()) replaced by a no-op: 0 differing
//      words. The strip copy is the tree under test (the src root FLUID_REF_SRC names, default src/) copied whole to a
//      temp dir — flipRef imports ../composition, which imports ../fluid-engine — and the statement must occur exactly
//      once in its flipRef.ts, else the gate aborts (no verdict, never a pass). The counting subclass runs the stage when
//      entered, as the tree does, so its run IS the tree's run. Scenes: (column) the A2 gated column — s34scenes column():
//      a = H = 0.6 m, 12 cells of 5 cm, the 72-cell run-out, the gate lifted at 4.53 m/s — for A2g's own run
//      (T ≤ 1.5767 + 0.55); (pool) a still pool at rest, 16 × 3 × 16 cells of 3.63/64 m (the P1 CPU pool,
//      FR/spec/regress_test_p.mjs: 16 × 8 × 16 grid, mulberry32(11), tolerances 1e-5 / 1e-4), 1 s at Δt = 1/120.
//      In-file control ctl:W0a.<scene> (must FAIL W0a): the option ON (keulegan1938) differs from the stripped copy in
//      ≥ 1 word AND acts (its log: cells acted on > 0 and Σ|booked| > 0) — the old control required only a difference,
//      which an unrelated edit alone supplies. The 7b248dc4 comparison (git archive 7b248dc4 src, option absent, 0
//      differing words and an empty log) is the recorded one-time certification of 227ad9bb (FR/cert/s38-ref_227ad9bb.out:
//      0 words, both scenes); it runs only with --w0a-pinned, as W0apin.<scene>, named by no mutant. Proof, pre-registered:
//      copy A — the tree with P2G's `this.mom[a][slot] += w * m * val` reassociated to `w * (m * val)`, an arithmetic
//      change unrelated to the stage (the review's copy A: 132,052 / 87,356 differing words vs 7b248dc4) — FAILS
//      W0apin.column and W0apin.pool and PASSES W0a.<scene>.entered, W0a.<scene> and ctl:W0a.<scene>; copy A plus the
//      default-on mutant (s38-mutations 'stage runs when the option is absent') FAILS W0a.<scene>.entered and W0a.<scene>
//      in both scenes.
// W0b  the viscous guard [spec §4 W0b; §3.2 "The guard"]. With the option ON: 0 differing words against the same run
//      with the option off, and the stage's log EMPTY (the stage never ran). Scene: s34scenes column() a = 4 cells of
//      5 cm, n² = 1, a 12-cell run-out, instant release (the floor liquid moves), 20 steps of A2's Δt = 3.673 ms.
//      (auto) olive oil at 20 °C (materialData: 911 kg/m³, 0.084 Pa·s — secondary data — ν = 9.2e-5 m²/s ≥
//      VISCOUS_RUN_NU = 1.06e-5; particle mass ρ·V_p, μ = viscosityDefault) with viscosity 'auto': the viscous solve
//      runs; (off) the same with viscosity 'off': only the ν rule (anyViscousLiquid) stops the stage; (force) ADDED here,
//      not in the spec's W0b: water with viscosity 'force' — the viscous solve runs whatever ν is, so only the guard's
//      first clause !(projection && viscosityRuns) stops the stage. With olive oil both clauses are true, so deleting
//      either one alone passes (auto) and (off); (force) is what sees the first clause. In-file control (must FAIL):
//      (off) with the ν rule removed — a subclass whose anyViscousLiquid() returns false: the stage runs, the state
//      differs. The whole guard removed from flipRef (the spec's control) runs in s38-mutations.
//      (drift) ADDED 2026-09-30 (fix round, prereg R-D, review INT-7; pre-registered 2026-09-30 before its first run):
//      until an immiscible floor gate exists (FRICTION open item 4: the drift's forcing excludes the wall stress, §3.5)
//      the stage does not run in a step where the immiscible drift is active — flipRef immiscibleDriftActive: options.
//      immiscible set and two of the particles' materials forming a pair whose σ is > 0, the only case in which driftFlux
//      can give a particle slip (otherwise every drift is exactly 0). Scene, fixed positions and no rng draws: the W0b
//      column's block (4 × 4 × 8 cells of 5 cm, 8 ppc) at the sub-cell centres, water at 20 °C (ρ 998.2072, μ NIST)
//      except sub-cell 7 of each floor cell (y = 0.75·dx) — mercury at 20 °C (HG_RHO_20C, μ(20 °C)), one drop per floor
//      cell — every particle carrying its μ (p.mu); immiscible { props of both, σ from interfacialTension.ts: water–
//      mercury 0.375 N/m }; instant release, 20 steps of A2's Δt. Pass W0b.drift: the option ON vs off, both with the
//      drift, 0 differing words, and the stage's log empty (the stage never ran); the drift's most dispersed particles in
//      a step are printed (reported). Sensitivity control ctl:W0b.drift (must FAIL W0b.drift's criterion): the same scene
//      with the drift off (immiscible absent) and the option ON acts — its log: cells acted on > 0 and Σ|booked| > 0.
//      The clause removed from flipRef runs in s38-mutations ('drift guard removed', named W0b.drift).
// W0c  the refusals [review wf_fbc58c55-116 M1 (CPU-F1) and M2 (CPU-F3); prereg R-M; pre-registered 2026-09-30 before
//      its first run]. Each case must throw its OWN refusal — an Error whose message is that refusal's (a throw of any
//      other kind, or no throw, fails the case) — and each line's must-run twins must run. (ctor) the constructor with
//      the stage on refuses viscosityDefault NaN, 0, −1e-3 and ∞; it constructs with the class default and with 1e-3,
//      and with the option absent even at NaN (stage-off construction untouched). (particle) applyWallShear on one water
//      floor cell of 4 row-0 particles at fixed positions (1, 0, 0.3) m/s refuses its particle 2 at μ NaN, 0, −1e-3 and
//      ∞, naming particle 2 (per particle: a μ = 0 particle in a water cell leaves ν_c > 0, so only this check sees
//      it); with every μ water's it runs and acts. (guard) step() on the same set plus one particle in row 2 refuses
//      that particle at μ NaN and ∞ through anyViscousLiquid (the prereg's rule: a non-finite μ; the binning never sees
//      row 2); with every μ water's the step runs. (tau) keuleganTau(3, 0.01, ν, 998.2072) refuses ν NaN, 0, −1e-6 and
//      ∞, and ρ NaN and 0 (ν water's); its Newton loop ending unconverged (the converged flag) is refused at U = ∞ and at
//      h = ∞; the water call runs. (law) the constructor refuses the laws 'Keulegan1938' and 'darcytest' and an absent
//      law (not in WALL_SHEAR_LAW_NAMES), darcyTest without f or with f NaN, constantTest without tau or with tau ∞, and
//      a parameter the law does not take (keulegan1938 with f, darcyTest with tau, constantTest with f); it constructs
//      keulegan1938, darcyTest f = 0.02 and f = −0.02, constantTest τ = 10 and τ = −10 Pa (no sign rule: −0.02 and −10
//      are the certified sign-flip controls). Controls (must FAIL; s38-mutations, each named W0c): μ refusal removed
//      (binning), μ refusal removed (guard), ν refusal removed (keuleganTau), law refusal removed.
// W1a  the operator, Darcy test law [spec §4 W1a; FR/revise/revise_numbers.py §4]. dx = 0.05 m, ppc 8, a 5 × 4 floor
//      (6 interior, 14 wall-adjacent cells), each cell holding n_c = 3 row-0 particles at jittered positions (h_c = 3dx/8
//      = 18.75 mm), water ρ = 998.2072; U0 = 3 m/s along x (set x) and, separately, along z (set z); darcyTest f = 0.02
//      (τ = ρ_c(f/8)U², ρ_c = M_c/V_c); Δt = (1/240)(0.05/(3.63/64)) = 3.673 ms (A2's step, s34-ref); the stage's entry
//      point applyWallShear applied N = 240 times with no transfer between. The semi-implicit update is the ODE's exact
//      recursion 1/U_{n+1} = 1/U_n + Δt(f/8)/h_c, so every particle's velocity along the flow equals U_N = 1/(1/U0 +
//      N·Δt·(f/8)/h_c) = 2.217922606925 m/s (recomputed here and checked against those printed digits, ±5e-13) to
//      ≤ 1e-12 relative (f64 rounding over 240 steps: 1.1e-15 in revise_numbers.py); the other tangential component
//      ≤ 1e-12·U_N; v_y and c bit-identical; non-vacuity: 240 log entries, each acting on > 0 cells, Σ|booked| > 0.
//      Controls (must FAIL; s38-mutations): sign flipped (+109 %), τ×2 (−21 %), explicit update (3.3e-4), Δv on every
//      second particle (+9.5 %), V_p = dx³ in V_c (+30 %: darcyTest's ρ_c).
// W1aK the production law through the stage [spec §4 W1a-K; the prototype FR/gatedesign/w1aK_oracle.mjs]. ONE
//      application of applyWallShear (keulegan1938) on a hand-built non-uniform set: the lab dx = 3.63/64 m, Δt = 1/240
//      s, ppc 8, a 6 × 4 floor, cells c = i + 6k (k-major, mulberry32(2026)): c mod 10 row-0 particles (sub-cell
//      depths; c = 9, 19 hold 9 — h_c capped at dx; c = 0, 10, 20 none) and c mod 3 particles in each of rows 1 and 2;
//      the cell's nominal speed [1e-3, 5e-3, 0.02, 0.07, 0.3, 1, 2, 3.25, 5][c mod 9] m/s (both branches) at c·45° in
//      (x, z); each particle's tangential velocity = nominal × a factor in [0.8, 1.2] plus a jitter within ±5 % of the
//      speed per component; v_y within ±0.3 m/s; every APIC c entry within ±1 /s; water at 20 °C (NIST row) except
//      cell 13 — mercury (HG_RHO_20C, μ(20 °C)), the denser liquid — and cell 2, whose two row-0 particles are water at
//      20 °C and at 60 °C (NIST rows: ρ, μ) — the μ cell, ν_c = μ_c/ρ_c from a mass-weighted μ of unequal masses; every
//      particle carries p.mu; wall-adjacent cells throughout. The oracle: bin ⌊y/dx⌋ = 0 into (⌊x/dx⌋, ⌊z/dx⌋) → M_c,
//      n_c, V_c = n_c·dx³/8, h_c = min(V_c/dx², dx), ρ_c = M_c/V_c, U_c, μ_c = Σmμ/M_c, ν_c = μ_c/ρ_c; the Re_h rule with
//      this file's crossing (Re_c = 3U⁺², U⁺ = a_s − b + b·ln(3U⁺), bisection: 428.2587154); τ = 3μ_c|U_c|/h_c below it,
//      ρ_c·u*² above, u* from eq. 32 by bisection; a_c = Δt·τ·dx²/(M_c|U_c|), Δv_c = −U_c·a_c/(1 + a_c). Asserts:
//      (1) every row-0 particle's velocity change equals Δv_c to ≤ 1e-9·|U_c| (both tangential components); (2) every
//      particle in rows ≥ 1: v and c bit-identical; (3) every particle: v_y and c bit-identical (and, stricter than the
//      spec, position and mass); (4) the log's booked impulse (impX, impZ) equals Σ M_c·Δv_c to ≤ 1e-9 relative (vector
//      norm); (5) cells acted on > 0 (the log); (6) no floor cell's tangential kinetic energy Σ½m(v_x² + v_z²) grows, to
//      1e-12 relative, cells checked > 0 (spec: moved here from P1). The 1e-9 bound (spec): > 4 decades above rounding
//      (Newton stop 1e-14; 1e-16 measured) and > 4 decades below the smallest defect's miss (6.1e-5, ρ_ref for ρ_c).
//      Controls (must FAIL; s38-mutations): h_c := dx, floor row y < dx/2, rows 0–1 binning, Δv on rows 0–1, kx2, 3-D
//      |U|, v_p *= f, ρ_ref for ρ_c, sign flipped, τ×2, constant ν (the μ cell).
//      W1aK.default ADDED 2026-09-30 (review GATE-F1; pre-registered 2026-09-30 before its first run): the set above
//      gives every particle p.mu, so it exercises only that half of μ_c's source; every dam-break and pool run takes the
//      other, viscosityDefault (makeParticles allocates no p.mu; p.mu is all-or-none — the stage tests the array). Two
//      more applications, each on a clone of the set's pre-state with p.mu REMOVED, on a fresh solver: (a)
//      viscosityDefault absent — the oracle's μ is this file's NIST 20 °C water (materialData LIQUIDS.water.viscosity(20),
//      as W20), never the solver's viscosityDefault; (b) viscosityDefault from lib/s34solver waterOpts(waterAt(
//      materialData, 25)) — the oracle's μ is LIQUIDS.water.viscosity(25). The oracle is the one above with that μ for
//      every particle. Pass, each arm: assert (1) at 1e-9·|U_c| and assert (4) at 1e-9 relative, cells acted on > 0.
//      Controls (must FAIL; s38-mutations, named W1aK.default): the fallback read as viscosityThreshold (a ν, 94× low)
//      fails both arms; the fallback as the literal 1.001596e-3 fails arm (b).
// W1b  the law [spec §4 W1b; revise_numbers.py §2–3; FR/gatedesign/w1b_extra_point.out]: keuleganTau(U, h, ν, ρ) alone,
//      water at 20 °C (ρ = 998.2072, μ = 1.001596e-3: NIST, materialData.ts:88), ν = μ/ρ. (resid) on the turbulent
//      branch by this file's rule (Re_h ≥ Re_c) of the grid U ∈ [1e-3, 5] m/s (41 geometric) × h ∈ [1 mm, 0.0567 m] (21
//      geometric): |U − u*(3.0 + 2.5·ln(h u*/ν))|/U ≤ 1e-12 with the returned u*, ≥ 1 point (on the laminar branch the
//      stage returns √(τ_lam/ρ), no root of eq. 32). (ref) u*(3.25 m/s, 0.01 m) = 0.152471658971 m/s, τ = 23.20592848
//      Pa; u*(4.17 m/s, 0.0567 m) = 0.1616324490019 m/s, τ = 26.07821158 Pa — each within half a unit of its last
//      printed digit (a 40-digit mpmath check puts every true value ≥ 0.17 of a unit inside that boundary — the
//      tightest: τ(4.17) by 1.7e-9 Pa, u*(4.17) by 2.4e-14 m/s — far above f64 error).
//      (lam) τ(1 mm/s, 1 mm) = 3.004788e-3 Pa and τ(0.03 m/s, 0.01 m) = 9.014364e-3 Pa (Re_h 299; the h⁺ < 11.5 switch
//      gives 7.150187e-3 there), each within 5e-10 Pa. (zero) τ(0, h) = 0 at the scan's depths. (scan) at h ∈ {1, 2,
//      6.25, 7.09 (= dx/8), 10, 25, 50, 56.7} mm, U from 1e-7 to 5 m/s, 4001 geometric points: τ never decreases
//      (exactly: the step is 0.44 % in U, the law's precision 1e-14); τ/τ_lam = 1 at U = 1e-7 to 1e-12 (τ(0⁺) = 0;
//      max() gives 303× there); continuity at the crossing: at Re_h = Re_c(1 ∓ 1e-6) τ equals this file's branch value
//      (the film below, eq. 32 by bisection above) to 1e-9 relative — so a switch misplaced by more than 1e-6 of Re_c
//      fails, the branches differing there by 0.654e-6 — and the two sides differ by ≤ 1e-5 relative (smooth branches:
//      (1 + 1.654e-6) − (1 − 1e-6) = 2.65e-6, d ln τ_turb/d ln U = 2U⁺/(U⁺ + b) = 1.654 at the crossing). Controls
//      (must FAIL; s38-mutations): the h⁺ < 11.5 switch, kx2, max() in place of the rule, the laminar branch dropped,
//      b = 5.75 with ln, ν := μ. Refusals (2026-09-30, fix round; pre-registered 2026-09-30 before its first run): since
//      keuleganTau refuses (throws) a Newton loop that ends unconverged, a law whose Newton runs where its start lies
//      below the monotone range (the laminar branch removed: Re_h < 2.77) refuses those VALID inputs; W1b counts such a
//      refusal as that point's failure — its τ and u* are NaN, which fails every W1b criterion — instead of crashing the
//      gate, and the line appends the refusals' count and first message. No criterion changes; with no refusal every
//      line prints as before.
// W1c  the sheet [spec §4 W1c; FR/spec/sheet_test_p.mjs/.out]: a one-cell sheet — s34scenes block() over the first row
//      of a 400 × 8 × 4 tank of 5 cm cells (20 m), 8 ppc, mulberry32(7) — at u0 = 2 m/s along x, and the same sheet
//      along z (4 × 8 × 400); s34-ref's solver at tolerances 1e-5 / 1e-4, gravity −y, Δt = 3.673 ms, the full step,
//      t ≤ 1 s; darcyTest f = 0.02. Measured: the mean flow-axis velocity of the particles inside the fixed window
//      [9, 11] m, the stage run against the control run (option absent). Pass, x and z: at the steps nearest t = 0.25,
//      0.5 and 1 s the loss (control − stage) within 3 %† of u0 − u0/(1 + (f/8)·u0·t/h), h = the sheet's depth N·V_p/area
//      (5 cm); validity: the control's drift |ū/u0 − 1| ≤ 0.2 %† at every step t ≤ 1 s; non-vacuity: every step's log
//      acts on > 0 cells and Σ|booked| > 0. († spec: the 3 % was set after seeing ≈ 1 % and resolves the sign and scale
//      mutants, no defect below 3 %; the 0.2 % is the first bound, restored for t ≤ 1 s.) In-file controls (each must
//      FAIL the 3 % at ≥ 1 of the three times): τ×2 (f = 0.04 against the f = 0.02 reference; spec +85 to +95 %), sign
//      flipped (f = −0.02; −205 to −223 %), stage skipped (the control run itself: −100 %). z ignored (−100 % on the z
//      sheet) and the option ignored run in s38-mutations. REPORTED: the keulegan1938 sheet (x) against its own ODE
//      dū/dt = −τ(ū, h)/(ρh), τ this file's law, RK4 (spec: 1.1–2.1 %).
// W1d  the placement audit [spec §4 W1d, §3.1; FR/gatedesign/w1d_prod.mjs, w1d_prod_T2/_T3.out]: the A2 gated column
//      (s34scenes column(), 12 cells of 5 cm, 4.53 m/s) run to step N = round(T·t_unit/Δt) (135 at T = 2, 202 at T = 3)
//      by the control (option absent) and by each variant (the option on, the stage disarmed by a subclass until step
//      N — its particle state at step N compared word by word with the control's: 0 differing words, i.e. lockstep);
//      at step N + 1 each variant's stage runs once (constantTest τ = 10 Pa), the control's never. The target is binned
//      HERE from the stage's own input (the particles as the stage receives them, after that step's density
//      correction): T⃗ = −Σ τ·dx²·Δt·Û_c over the wetted floor cells, a_c = Δt·τ·dx²/(M_c|U_c|). Front band: cells,
//      faces and particles with i ≥ i_B = round(x_f/dx) − 2, x_f the control's bulk front (s34scenes frontSlab) at
//      step N. Pass at both T: (i) the front booking B⃗_f·T⃗_f/|T⃗_f|² within [1/(1 + a_max), 1] (a_max over the band's
//      cells; each cell books τ·dx²·Δt/(1 + a_c)); (ii) global (ΔP_x − ΔI_wall)/B_x within 3 %† (ΔP_x = Σ m(v_x −
//      v_x,ctrl) after step N + 1; ΔI_wall = the change of the x− wall's pressure impulse, Σ p·dx²·Δt over its LIQUID
//      cells, the prototype's estimator; B_x the log's impX); (iii) front ΔP_x/B_x,f within 5 %† (particles with
//      x ≥ i_B·dx at step N; B_f from the stage's field); (setup) lockstep (0 differing words at N for every variant)
//      and non-vacuity (the stage's log at N + 1: cells > 0, Σ|booked| > 0), both T. († spec: set after seeing P's
//      values; the probe's G1 missed by 8–47 %, the rows 0–1 control by 73–89 %; the ghost-row loss uses ≈ 2 of (ii)'s
//      3 %.) In-file controls (each must FAIL (i), (ii) or (iii) at T = 2 or 3): G1 — the physics memo's grid stage
//      (template FR/spec/src/sim-ref/flipRef.ts applyFloorShear: on u* after gridUpdate, every FLUID floor x- and
//      z-face with first-cell particle mass — hat weights, side ghosts folded in — scaled by 1/(1 + Δt·τ·dx²/(M·u_t)),
//      constant τ), a subclass HERE (p2g/gridUpdate hooks) so flipRef carries no gate-only placement code; Δv on rows 0
//      and 1 (a subclass adds the stage's per-cell Δv to row-1 particles); sign flipped (τ = −10 Pa); τ×2 (τ = 20 Pa).
//      REPORTED: W1d-t, the transfer-only split — the stage's Δv alone (every other velocity 0, c = 0) through one P2G →
//      gridUpdate (g = 0) → extrapolate → solid faces → G2P at the stage's input positions, no projection: kept ÷
//      booked (x), global and front (spec §3.5: 0.978–0.984 under deeper liquid).
// Revision 2026-09-30, after the first run (no bound, seed, window, tolerance or statistic changed): the first run
//      passed every check except W1c's validity on the z sheet — the stage-off control's window-mean drift 0.280 % at
//      t = 0.555 s (bound 0.2 %), 0.253 % already at the spec's checkpoint t = 0.5 s. Print form since: each sheet's
//      validity prints on its own line, W1cvalid.x / W1cvalid.z (a FAIL is counted); a sheet whose validity fails
//      prints its loss line VOID — uncertified, counted neither pass nor fail (the gate still fails on the validity
//      line). W1c.z is VOID. W1c.x passes as pre-registered (mulberry32(7)), and that pass belongs to one realization:
//      4 of 8 x seeds exceed the same bound. The lead's pre-registered study (D1–D3, FR/impl/A/w1c_drift_study.out; the
//      control in W1c's scene): the solver is x/z-symmetric to f64 rounding, not bit-exact — each seed-7 set run
//      transposed on the other grid reproduces its native drift (x7 −0.1666 %, z7 +0.2796 %): the max drift to 2.2e-14
//      pp, the t = 1 s Lagrangian drift to 5.8e-10 pp, the window-mean series to ≤ 4.4e-9 pp at every step (corrected
//      2026-09-30, review REC-F2: the "≤ 6e-10 pp" printed here was the largest of five checkpoints, and the twins'
//      particle states differ from step 1) — and tolerance-independent (at the
//      class defaults 1e-9 / 1e-9: z7 +0.2796 %, x7 −0.1668 %). Seeds 1–8: max |drift| 0.057–0.552 % (x) and
//      0.196–0.488 % (z), > 0.2 % in 11 of 16; the Lagrangian drift at t = 1 s is positive in 13 of 16 (mean ≈ +0.18 %;
//      x +0.08 %, 5/8; z +0.28 %, 8/8) — a realization spread plus a common positive gain, whose candidate (untested) is
//      the spec's open item 7.3, the thin-film momentum gain. The spec's "restored" 0.2 % rested on one realization
//      read at four checkpoints (z only at t = 1 s).
import { spawnSync } from 'node:child_process'
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { loadTsModules, REPO } from './lib/loadTs.mjs'
import { s34Scenes, mulberry32, G, DX, RHO } from './lib/s34scenes.mjs'
import { ETSIN600_FRONT } from './lib/s34metrics.mjs'
import { waterAt, waterOpts } from './lib/s34solver.mjs'

const SECTIONS = ['W0a', 'W0b', 'W0c', 'W1a', 'W1aK', 'W1b', 'W1c', 'W1d']
const ARGS = process.argv.slice(2)
// a misspelt argument would silently skip what it names: every argument is --only=… or --w0a-pinned
for (const a of ARGS) if (!a.startsWith('--only=') && a !== '--w0a-pinned') throw new Error(`unknown argument "${a}" (accepted: --only=<sections>, --w0a-pinned)`)
const ONLY = ARGS.find(a => a.startsWith('--only='))?.slice(7).split(',') ?? null
// an unknown name would run nothing and print PASS (s34-ref.mjs review 2026-09-29): refuse it
for (const s of ONLY ?? []) if (!SECTIONS.includes(s)) throw new Error(`--only: unknown section "${s}" (${SECTIONS.join(', ')})`)
const run = name => !ONLY || ONLY.includes(name)
const PINNED = ARGS.includes('--w0a-pinned')
if (PINNED && !run('W0a')) throw new Error('--w0a-pinned: the pinned comparison is part of W0a, which this run does not include')
const SRC = process.env.FLUID_REF_SRC ?? 'src'
const { gridLayout, flipRef, mat, it } = await loadTsModules({ gridLayout: `${SRC}/sim-ref/gridLayout.ts`, flipRef: `${SRC}/sim-ref/flipRef.ts`, mat: `${SRC}/composition/materialData.ts`, it: `${SRC}/composition/interfacialTension.ts` })
const { GridLayout, FaceType } = gridLayout
const { FlipRef, makeParticles, keuleganTau, CellLabel } = flipRef
const TREE = { FlipRef, GridLayout, FaceType, makeParticles }

let fails = 0, voids = 0
const check = (ok, label, msg) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${label} ${msg}`); if (!ok) fails++ }
/** A check whose scene failed its own validity check (that line is the counted FAIL): neither pass nor fail. */
const voidCheck = (label, msg) => { console.log(`VOID ${label} ${msg} (uncertified: its control failed the validity check)`); voids++ }
/** An in-file positive control: `failed` = it failed its criterion, as required. */
const control = (failed, label, msg) => { console.log(`${failed ? 'PASS' : 'FAIL'} ctl:${label} ${msg}`); if (!failed) fails++ }
const info = (label, msg) => console.log(`INFO ${label} ${msg}`)
const t0 = Date.now()
const gvec = [0, -G, 0]
// s34-ref's solver (s34-ref.mjs opts): the ghost-fluid surface with the density projection
const opts = (extra = {}) => ({ gravity: gvec, density: RHO, projection: true, densityProjection: true, freeSurface: 'ghost', pressureTolerance: 1e-6, psiTolerance: 1e-5, ...extra })
const scenes = (M = TREE) => s34Scenes(M, opts)
const SHEAR_ON = { wall: 'y-', law: 'keulegan1938' }
const DT_A2 = (1 / 240) * (0.05 / DX)                        // A2's step at 5 cm cells (s34scenes column())
const f4 = x => x.toFixed(4), e2 = x => x.toExponential(2)

// ── state comparison: every 64-bit word of the particle state ────────────────────────────────────────────────────
const snap = p => ({ pos: Float64Array.from(p.pos), vel: Float64Array.from(p.vel), c: p.c.map(a => Float64Array.from(a)), mass: Float64Array.from(p.mass) })
const words = a => new BigUint64Array(a.buffer, a.byteOffset, a.length)
function diffWords(a, b) {
  let n = 0
  for (const [x, y] of [[a.pos, b.pos], [a.vel, b.vel], [a.c[0], b.c[0]], [a.c[1], b.c[1]], [a.c[2], b.c[2]], [a.mass, b.mass]]) {
    if (x.length !== y.length) return Infinity
    const X = words(x), Y = words(y)
    for (let i = 0; i < X.length; i++) if (X[i] !== Y[i]) n++
  }
  return n
}

// ── the independent law: this file's constants, crossing and eq. 32 root ─────────────────────────────────────────────
const AS = 5.5, BK = 2.5   // Keulegan 1938 eq. 13–14: a_s, b = 1/κ (κ = 0.40) — this file's own literals
// eq. 32, U/u* = a_s − b + b·ln(R·u*/ν), for u* by bisection on its monotone branch (R·u*/ν > e^(−(a_s − b)/b), U⁺ > 0)
function ustarBisect(U, R, nu) {
  let lo = nu / R * Math.exp(-(AS - BK) / BK), hi = U + 1
  const g = us => us * (AS - BK + BK * Math.log(R * us / nu)) - U
  for (let it = 0; it < 400 && hi - lo > 1e-17 * hi; it++) { const mid = 0.5 * (lo + hi); if (g(mid) > 0) hi = mid; else lo = mid }
  return 0.5 * (lo + hi)
}
/** The crossing of the film τ = 3μU/h (h⁺ = 3U⁺) and eq. 32: U⁺ = a_s − b + b·ln(3U⁺), its upper root by bisection on
 *  [5, 30]; Re_c = U⁺·h⁺ = 3U⁺² (spec §2.4: 428.26). */
const RE_C = (() => {
  let lo = 5, hi = 30
  const F = x => x - (AS - BK) - BK * Math.log(3 * x)
  for (let it = 0; it < 200; it++) { const mid = 0.5 * (lo + hi); if (F(mid) < 0) lo = mid; else hi = mid }
  return 3 * (0.5 * (lo + hi)) ** 2
})()
/** The spec's law (§2.4): the film 3μU/h below Re_c, ρu*² (eq. 32) above. */
const tauOracle = (U, h, nu, rho) => (!(U > 0) ? 0 : U * h / nu < RE_C ? 3 * rho * nu * U / h : rho * ustarBisect(U, h, nu) ** 2)

// ── W0a: off = the tree with the stage never entered ─────────────────────────────────────────────────────────────────
if (run('W0a')) {
  const modulesAt = async root => {
    const r = root.replaceAll('\\', '/'), m = await loadTsModules({ gridLayout: `${r}/sim-ref/gridLayout.ts`, flipRef: `${r}/sim-ref/flipRef.ts` })
    return { FlipRef: m.flipRef.FlipRef, GridLayout: m.gridLayout.GridLayout, FaceType: m.gridLayout.FaceType, makeParticles: m.flipRef.makeParticles }
  }
  // the strip copy: the tree under test copied whole (flipRef imports ../composition, which imports ../fluid-engine), its
  // one call statement of the stage replaced by a no-op — exactly one occurrence, or the gate aborts (no verdict)
  const CALL = 'this.applyWallShear(p, dt)'
  const stripDir = mkdtempSync(join(tmpdir(), 's38-strip-'))
  let STRIP
  try {
    cpSync(resolve(REPO, SRC), join(stripDir, 'src'), { recursive: true })
    const f = join(stripDir, 'src', 'sim-ref', 'flipRef.ts'), text = readFileSync(f, 'utf8'), n = text.split(CALL).length - 1
    if (n !== 1) throw new Error(`W0a: the stage's call statement "${CALL}" occurs ${n}× in ${SRC}/sim-ref/flipRef.ts (exactly 1 required) — no strip copy, no verdict`)
    writeFileSync(f, text.replace(CALL, () => '{ /* W0a: stripped */ }'))
    STRIP = await modulesAt(join(stripDir, 'src'))
  } finally { rmSync(stripDir, { recursive: true, force: true }) }
  // --w0a-pinned: the recorded one-time certification of 227ad9bb against 7b248dc4, the stage's parent (the pre-stage solver)
  const HEAD_SHA = '7b248dc4'
  let HEAD = null
  if (PINNED) {
    const dir = mkdtempSync(join(tmpdir(), 's38-head-'))
    try {
      const a = spawnSync('git', ['archive', '--format=tar', '-o', join(dir, 'head.tar'), HEAD_SHA, 'src'], { cwd: REPO, encoding: 'utf8' })
      if (a.status !== 0) throw new Error(`W0a: git archive ${HEAD_SHA} src failed (${a.status}): ${a.stderr}`)
      const t = spawnSync('tar', ['-xf', 'head.tar'], { cwd: dir, encoding: 'utf8' })
      if (t.status !== 0) throw new Error(`W0a: tar -xf failed (${t.status}): ${t.stderr ?? t.error}`)
      HEAD = await modulesAt(join(dir, 'src'))
    } finally { rmSync(dir, { recursive: true, force: true }) }
  }
  /** The tree's solver counting applyWallShear's entries. Entered, it runs the stage as the tree does — so its run IS the
   *  tree's run — except that with the option absent it only counts (the tree would fail on the missing option). */
  class Entered extends FlipRef {
    entries = 0
    applyWallShear(p, dt) { this.entries++; if (this.wallShear) super.applyWallShear(p, dt) }
  }
  const tauEnd = ETSIN600_FRONT.T.at(-1) + 0.55   // A2g's own run (s34-ref A2g)
  const column = (M, extra) => { const r = scenes(M).column({ aCells: 12, n2: 1, h: 0.05, nx: 72, tauEnd, gate: 4.53, extra }); return { p: r.p, steps: r.ts.length, sim: r.sim } }
  const pool = (M, extra) => {
    const L = new M.GridLayout({ nx: 16, ny: 8, nz: 16, dx: DX })
    const sim = new M.FlipRef(L, opts({ pressureTolerance: 1e-5, psiTolerance: 1e-4, ...extra }))
    const p = scenes(M).block([0, 0, 0], [15, 2, 15], mulberry32(11))
    let steps = 0
    for (let s = 1; s * (1 / 120) <= 1 + 1e-9; s++) { sim.step(p, 1 / 120); steps++ }
    return { p, steps, sim }
  }
  for (const [name, desc, scene] of [['column', 'the A2 gated column (12 cells of 5 cm, gate 4.53 m/s, A2g\'s run)', column], ['pool', 'the still pool (16 × 3 × 16 cells of 3.63/64 m, 1 s at 1/120)', pool]]) {
    const ref = snap(scene(STRIP, {}).p)
    const off = scene({ ...TREE, FlipRef: Entered }, {}), offLog = off.sim.wallShearLog, dOff = diffWords(snap(off.p), ref)
    check(off.sim.entries === 0 && offLog.length === 0, `W0a.${name}.entered`, `the stage never entered, option absent: ${desc}, ${off.steps} steps, ${off.p.n} particles: applyWallShear entries ${off.sim.entries} (0); stage log entries ${offLog.length} (0)`)
    check(dOff === 0, `W0a.${name}`, `off = the same tree with its call statement ${CALL} stripped (a no-op): ${desc}, option absent: ${dOff} differing words of the particle state (0)`)
    const on = scene(TREE, { wallShear: SHEAR_ON }), dOn = diffWords(snap(on.p), ref), onLog = on.sim.wallShearLog
    const acted = onLog.reduce((s, e) => s + e.cells, 0), booked = onLog.reduce((s, e) => s + Math.abs(e.impX) + Math.abs(e.impZ), 0)
    control(dOn > 0 && acted > 0 && booked > 0, `W0a.${name}`, `the option ON (keulegan1938) must differ from the stripped copy AND act: ${dOn} differing words (> 0); cells acted on over the run ${acted} (> 0), Σ|booked| ${e2(booked)} N·s (> 0)`)
    if (HEAD) {
      const dPin = diffWords(snap(off.p), snap(scene(HEAD, {}).p))
      check(dPin === 0 && offLog.length === 0, `W0apin.${name}`, `(--w0a-pinned: the recorded certification of 227ad9bb) off = the pre-stage solver: ${desc}, option absent vs ${HEAD_SHA}: ${dPin} differing words of the particle state (0); stage log entries ${offLog.length} (0)`)
    }
  }
}

// ── W0b: the viscous guard ───────────────────────────────────────────────────────────────────────────────────────────
if (run('W0b')) {
  const OIL = { rho: mat.LIQUIDS['olive-oil'].density(20), mu: mat.LIQUIDS['olive-oil'].viscosity(20) }
  const a = 4 * 0.05, tauEnd = 20.5 * DT_A2 / Math.sqrt(a / G)   // 20 steps
  const colRun = (Cls, extra, rho) => { const r = s34Scenes({ ...TREE, FlipRef: Cls }, opts).column({ aCells: 4, n2: 1, h: 0.05, nx: 12, tauEnd, extra, rho }); return { p: snap(r.p), n: r.p.n, steps: r.ts.length, log: r.sim.wallShearLog, visc: r.sim.lastViscosity } }
  const arms = [
    ['auto', `olive oil (ρ ${OIL.rho}, μ ${OIL.mu} Pa·s, ν ${e2(OIL.mu / OIL.rho)} m²/s) with viscosity 'auto' (the viscous solve runs)`, { viscosity: 'auto', viscosityDefault: OIL.mu }, OIL.rho],
    ['off', `olive oil with viscosity 'off' (only the ν rule stops the stage)`, { viscosity: 'off', viscosityDefault: OIL.mu }, OIL.rho],
    ['force', `water with viscosity 'force' (only the viscous-solve clause stops the stage; added here)`, { viscosity: 'force' }, RHO],
  ]
  const offRuns = {}
  for (const [name, desc, extra, rho] of arms) {
    const off = colRun(FlipRef, extra, rho), on = colRun(FlipRef, { ...extra, wallShear: SHEAR_ON }, rho), d = diffWords(on.p, off.p)
    offRuns[name] = off
    check(d === 0 && on.log.length === 0, `W0b.${name}`, `the guard, ${desc}: option ON vs off, ${on.steps} steps, ${on.n} particles: ${d} differing words (0); stage log entries ${on.log.length} (0: the stage never ran); last viscous solve ${on.visc ? `ran (${on.visc.unknowns} unknowns)` : 'none'}`)
  }
  class NoNuRule extends FlipRef { anyViscousLiquid() { return false } }
  const [, , extra, rho] = arms[1]
  const ctl = colRun(NoNuRule, { ...extra, wallShear: SHEAR_ON }, rho), d = diffWords(ctl.p, offRuns.off.p), acted = ctl.log.reduce((s, e) => s + e.cells, 0)
  control(d > 0 && acted > 0, 'W0b.off', `the ν rule removed (anyViscousLiquid → false) on the (off) arm must let the stage run: ${d} differing words, cells acted on ${acted} (> 0 each required)`)
  // (drift) the stage guarded off while the immiscible drift is active (fix round 2026-09-30, R-D)
  const WAT = { rho: RHO, mu: mat.LIQUIDS.water.viscosity(20) }, MERC = { rho: mat.HG_RHO_20C, mu: mat.LIQUIDS.mercury.viscosity(20) }
  const KEYS = ['water', 'mercury'], SIGMA = it.interfacialTension('water', 'mercury')
  const IMM = { props: { 0: WAT, 1: MERC }, sigma: (x, y) => it.interfacialTension(KEYS[x], KEYS[y]) }
  const driftRun = extra => {
    const h = 0.05, L = new GridLayout({ nx: 12, ny: 12, nz: 8, dx: h })
    const sim = new FlipRef(L, opts({ pressureTolerance: 1e-5, psiTolerance: 1e-4, ...extra }))
    const p = scenes().block([0, 0, 0], [3, 3, 7], () => 0.5, 8, h)   // the W0b column's block at the sub-cell centres: no rng draws
    p.mu = new Float64Array(p.n)
    for (let q = 0; q < p.n; q++) {
      const hg = q % 8 === 7 && p.pos[3 * q + 1] < h   // sub-cell 7 of each floor cell: one mercury drop per floor cell
      const liq = hg ? MERC : WAT
      p.material[q] = hg ? 1 : 0; p.mass[q] = liq.rho * h ** 3 / 8; p.mu[q] = liq.mu
    }
    let dispersed = 0
    for (let s = 0; s < 20; s++) { sim.step(p, DT_A2); dispersed = Math.max(dispersed, sim.lastDrift.dispersed) }
    return { p: snap(p), n: p.n, log: sim.wallShearLog, dispersed }
  }
  const dOn = driftRun({ immiscible: IMM, wallShear: SHEAR_ON }), dOff = driftRun({ immiscible: IMM }), dd = diffWords(dOn.p, dOff.p)
  check(dd === 0 && dOn.log.length === 0, 'W0b.drift', `the drift guard: water + mercury (σ ${SIGMA} N/m; ν ${e2(WAT.mu / WAT.rho)} and ${e2(MERC.mu / MERC.rho)} m²/s, both < VISCOUS_RUN_NU), the immiscible drift active (at most ${dOff.dispersed} dispersed particles in a step): option ON vs off, 20 steps, ${dOn.n} particles: ${dd} differing words (0); stage log entries ${dOn.log.length} (0: the stage never ran)`)
  const dCtl = driftRun({ wallShear: SHEAR_ON })
  const cActed = dCtl.log.reduce((s, e) => s + e.cells, 0), cBooked = dCtl.log.reduce((s, e) => s + Math.abs(e.impX) + Math.abs(e.impZ), 0)
  control(cActed > 0 && cBooked > 0, 'W0b.drift', `sensitivity: the same scene with the drift off (immiscible absent) and the option ON must act: cells acted on ${cActed}, Σ|booked| ${e2(cBooked)} N·s (> 0 each)`)
}

// ── W0c: the refusals ────────────────────────────────────────────────────────────────────────────────────────────────
if (run('W0c')) {
  const said = e => String(e?.message ?? e).split('\n')[0].slice(0, 100)
  /** 'refused' when fn throws an Error whose message matches `re` (its own refusal); otherwise what happened. */
  const refuses = (fn, re) => { try { fn() } catch (e) { return e instanceof Error && re.test(e.message) ? 'refused' : `threw another error (${said(e)})` } return 'ran' }
  const runs = fn => { try { fn(); return 'ran' } catch (e) { return `threw (${said(e)})` } }
  const line = (label, what, cases) => check(cases.every(([, got, want]) => got === want), label, `${what}: ${cases.map(([c, got, want]) => `${c} ${got}${got === want ? '' : ` ✗ (${want} required)`}`).join('; ')}`)
  const h = 0.05, VP = h ** 3 / 8, L1 = new GridLayout({ nx: 2, ny: 4, nz: 2, dx: h }), WMU = mat.LIQUIDS.water.viscosity(20)
  // (ctor)
  const make = extra => () => new FlipRef(L1, opts({ wallShear: SHEAR_ON, ...extra }))
  line('W0c.ctor', 'the constructor with the stage on refuses viscosityDefault not finite and > 0', [
    ...[NaN, 0, -1e-3, Infinity].map(v => [`viscosityDefault ${v}`, refuses(make({ viscosityDefault: v }), /^FlipRef: wall shear needs viscosityDefault finite and > 0/), 'refused']),
    ['the class default', runs(make({})), 'ran'],
    ['viscosityDefault 1e-3', runs(make({ viscosityDefault: 1e-3 })), 'ran'],
    ['option absent with viscosityDefault NaN (stage-off construction untouched)', runs(() => new FlipRef(L1, opts({ viscosityDefault: NaN }))), 'ran'],
  ])
  // one water floor cell (0, 0): 4 row-0 particles at the sub-cell centres, (1, 0, 0.3) m/s; particle 4 in row 2 at rest
  const cellSet = (q, mu) => {
    const p = makeParticles(5)
    p.mu = new Float64Array(5).fill(WMU)
    ;[[0.25, 0.25, 0.25], [0.75, 0.25, 0.25], [0.25, 0.25, 0.75], [0.75, 0.25, 0.75], [0.5, 2.5, 0.5]].forEach((x, r) => {
      p.pos.set(x.map(v => v * h), 3 * r); p.mass[r] = RHO * VP
      if (r < 4) p.vel.set([1, 0, 0.3], 3 * r)
    })
    if (q !== null) p.mu[q] = mu
    return p
  }
  // (particle)
  const apply = (q, mu) => () => {
    const sim = new FlipRef(L1, opts({ wallShear: SHEAR_ON }))
    sim.applyWallShear(cellSet(q, mu), 1 / 240)
    if (!(sim.wallShearLog.at(-1).cells > 0)) throw new Error('the stage did not act')
  }
  line('W0c.particle', 'applyWallShear refuses a floor-row particle whose μ is not finite and > 0, naming it (one water cell of 4)', [
    ...[NaN, 0, -1e-3, Infinity].map(v => [`particle 2 μ ${v}`, refuses(apply(2, v), /^FlipRef\.applyWallShear: particle 2 on the floor row has μ/), 'refused']),
    ['every μ water\'s (acts)', runs(apply(null)), 'ran'],
  ])
  // (guard)
  const stepOnce = (q, mu) => () => new FlipRef(L1, opts({ wallShear: SHEAR_ON })).step(cellSet(q, mu), 1 / 240)
  line('W0c.guard', 'step() refuses a particle whose μ is not finite through anyViscousLiquid (particle 4, in row 2: the binning never sees it)', [
    ...[NaN, Infinity].map(v => [`particle 4 μ ${v}`, refuses(stepOnce(4, v), /^FlipRef\.anyViscousLiquid: particle 4 has μ/), 'refused']),
    ['every μ water\'s', runs(stepOnce(null)), 'ran'],
  ])
  // (tau)
  const RW = 998.2072, NUW = 1.001596e-3 / RW, kt = (U, hh, nu, rho) => () => keuleganTau(U, hh, nu, rho)
  line('W0c.tau', 'keuleganTau(3, 0.01, ν, ρ) refuses ν and ρ not finite and > 0, and a Newton loop that ends unconverged', [
    ...[NaN, 0, -1e-6, Infinity].map(v => [`ν ${v}`, refuses(kt(3, 0.01, v, RW), /^keuleganTau: ν = /), 'refused']),
    ...[NaN, 0].map(v => [`ρ ${v}`, refuses(kt(3, 0.01, NUW, v), /^keuleganTau: ρ = /), 'refused']),
    ['U ∞', refuses(kt(Infinity, 0.01, NUW, RW), /^keuleganTau: Newton on eq\. 32 did not converge/), 'refused'],
    ['h ∞', refuses(kt(3, Infinity, NUW, RW), /^keuleganTau: Newton on eq\. 32 did not converge/), 'refused'],
    ['water (ν 1.0034e-6, ρ 998.2072)', runs(kt(3, 0.01, NUW, RW)), 'ran'],
  ])
  // (law)
  const withLaw = ws => () => new FlipRef(L1, opts({ wallShear: ws }))
  line('W0c.law', 'the constructor refuses a law outside WALL_SHEAR_LAW_NAMES, a missing or non-finite parameter, and a parameter the law does not take; no sign rule', [
    ["law 'Keulegan1938'", refuses(withLaw({ wall: 'y-', law: 'Keulegan1938' }), /is not one of/), 'refused'],
    ["law 'darcytest' (f 0.02)", refuses(withLaw({ wall: 'y-', law: 'darcytest', f: 0.02 }), /is not one of/), 'refused'],
    ['no law', refuses(withLaw({ wall: 'y-' }), /is not one of/), 'refused'],
    ['darcyTest without f', refuses(withLaw({ wall: 'y-', law: 'darcyTest' }), /darcyTest needs a finite f/), 'refused'],
    ['darcyTest f NaN', refuses(withLaw({ wall: 'y-', law: 'darcyTest', f: NaN }), /darcyTest needs a finite f/), 'refused'],
    ['constantTest without tau', refuses(withLaw({ wall: 'y-', law: 'constantTest' }), /constantTest needs a finite tau/), 'refused'],
    ['constantTest tau ∞', refuses(withLaw({ wall: 'y-', law: 'constantTest', tau: Infinity }), /constantTest needs a finite tau/), 'refused'],
    ['keulegan1938 with f', refuses(withLaw({ wall: 'y-', law: 'keulegan1938', f: 0.02 }), /keulegan1938 takes no parameter "f"/), 'refused'],
    ['darcyTest with tau', refuses(withLaw({ wall: 'y-', law: 'darcyTest', f: 0.02, tau: 10 }), /darcyTest takes no parameter "tau"/), 'refused'],
    ['constantTest with f', refuses(withLaw({ wall: 'y-', law: 'constantTest', tau: 10, f: 0.02 }), /constantTest takes no parameter "f"/), 'refused'],
    ['keulegan1938', runs(withLaw(SHEAR_ON)), 'ran'],
    ['darcyTest f 0.02', runs(withLaw({ wall: 'y-', law: 'darcyTest', f: 0.02 })), 'ran'],
    ['darcyTest f −0.02 (the sign-flip control)', runs(withLaw({ wall: 'y-', law: 'darcyTest', f: -0.02 })), 'ran'],
    ['constantTest τ 10', runs(withLaw({ wall: 'y-', law: 'constantTest', tau: 10 })), 'ran'],
    ['constantTest τ −10 (the sign-flip control)', runs(withLaw({ wall: 'y-', law: 'constantTest', tau: -10 })), 'ran'],
  ])
}

// ── W1a: the operator, Darcy test law ────────────────────────────────────────────────────────────────────────────────
if (run('W1a')) {
  const h = 0.05, N = 240, U0 = 3, f = 0.02, nx = 5, nz = 4, nPer = 3, dt = DT_A2
  const hc = nPer * h / 8, UN = 1 / (1 / U0 + N * dt * (f / 8) / hc), UN_PRINTED = 2.217922606925
  for (const axis of [0, 2]) {
    const L = new GridLayout({ nx, ny: 4, nz, dx: h })
    const sim = new FlipRef(L, opts({ wallShear: { wall: 'y-', law: 'darcyTest', f } }))
    const rng = mulberry32(240 + axis), p = makeParticles(nx * nz * nPer)
    let q = 0
    for (let k = 0; k < nz; k++) for (let i = 0; i < nx; i++) for (let s = 0; s < nPer; s++, q++) {
      p.pos.set([(i + 0.05 + 0.9 * rng()) * h, (0.05 + 0.9 * rng()) * h, (k + 0.05 + 0.9 * rng()) * h], 3 * q)
      p.mass[q] = RHO * h ** 3 / 8
      p.vel[3 * q + axis] = U0
    }
    const pre = snap(p)
    for (let s = 0; s < N; s++) sim.applyWallShear(p, dt)
    let worst = 0, worstPerp = 0, vycChanged = 0
    const perp = 2 - axis, W = words
    for (let r = 0; r < p.n; r++) {
      worst = Math.max(worst, Number.isFinite(p.vel[3 * r + axis]) ? Math.abs(p.vel[3 * r + axis] - UN) / UN : Infinity)
      worstPerp = Math.max(worstPerp, Number.isFinite(p.vel[3 * r + perp]) ? Math.abs(p.vel[3 * r + perp]) / UN : Infinity)
      if (W(p.vel)[3 * r + 1] !== W(pre.vel)[3 * r + 1]) vycChanged++
    }
    for (let a = 0; a < 3; a++) { const X = W(p.c[a]), Y = W(pre.c[a]); for (let i = 0; i < X.length; i++) if (X[i] !== Y[i]) vycChanged++ }
    const log = sim.wallShearLog, booked = log.reduce((s, e) => s + Math.abs(e.impX) + Math.abs(e.impZ), 0), minCells = log.reduce((m, e) => Math.min(m, e.cells), Infinity)
    const ok = worst <= 1e-12 && worstPerp <= 1e-12 && vycChanged === 0 && Math.abs(UN - UN_PRINTED) <= 5e-13 && log.length === N && minCells > 0 && booked > 0
    check(ok, `W1a.${axis === 0 ? 'x' : 'z'}`, `operator, darcyTest f = ${f}, U0 = ${U0} m/s along ${axis === 0 ? 'x' : 'z'}, ${nx * nz} floor cells × ${nPer} particles (h_c ${(1000 * hc).toFixed(2)} mm), Δt ${(1000 * dt).toFixed(3)} ms, ${N} applications: U_N exact ${UN.toFixed(13)} m/s (printed 2.217922606925, ±5e-13); worst particle |v − U_N|/U_N ${e2(worst)} (≤ 1e-12); other tangential component ${e2(worstPerp)}·U_N (≤ 1e-12); v_y and c words changed ${vycChanged} (0); log entries ${log.length} (${N}), fewest cells acted on ${minCells} (> 0), Σ|booked| ${e2(booked)} N·s (> 0)`)
  }
}

// ── W1a-K: the production law through the stage ──────────────────────────────────────────────────────────────────────
if (run('W1aK')) {
  const h = DX, dt = 1 / 240, NX = 6, NZ = 4, VP = h ** 3 / 8
  const W20 = { name: 'water 20 °C', rho: mat.waterDensity(20), mu: mat.LIQUIDS.water.viscosity(20) }
  const W60 = { name: 'water 60 °C', rho: mat.waterDensity(60), mu: mat.LIQUIDS.water.viscosity(60) }
  const HG = { name: 'mercury 20 °C', rho: mat.HG_RHO_20C, mu: mat.LIQUIDS.mercury.viscosity(20) }
  const L = new GridLayout({ nx: NX, ny: 4, nz: NZ, dx: h })
  const sim = new FlipRef(L, opts({ wallShear: SHEAR_ON }))
  const rng = mulberry32(2026), speeds = [1e-3, 5e-3, 0.02, 0.07, 0.3, 1, 2, 3.25, 5], pts = []
  for (let k = 0; k < NZ; k++) for (let i = 0; i < NX; i++) {
    const c = i + NX * k, n0 = c % 10, U = speeds[c % 9], ang = c * Math.PI / 4, above = c % 3
    const liq = q => (c === 13 ? HG : c === 2 ? (q === 0 ? W20 : W60) : W20)
    for (let q = 0; q < n0; q++) pts.push({ x: (i + rng()) * h, y: 0.999 * rng() * h, z: (k + rng()) * h, U, ang, L: liq(q) })
    for (let row = 1; row <= 2; row++) for (let q = 0; q < above; q++) pts.push({ x: (i + rng()) * h, y: (row + 0.999 * rng()) * h, z: (k + rng()) * h, U, ang, L: W20 })
  }
  const p = makeParticles(pts.length)
  p.mu = new Float64Array(pts.length)
  pts.forEach((s, q) => {
    p.pos.set([s.x, s.y, s.z], 3 * q); p.mass[q] = s.L.rho * VP; p.mu[q] = s.L.mu
    const fct = 0.8 + 0.4 * rng()
    p.vel.set([s.U * Math.cos(s.ang) * fct + 0.05 * s.U * (2 * rng() - 1), 0.3 * (2 * rng() - 1), s.U * Math.sin(s.ang) * fct + 0.05 * s.U * (2 * rng() - 1)], 3 * q)
    for (let a = 0; a < 3; a++) p.c[a].set([2 * rng() - 1, 2 * rng() - 1, 2 * rng() - 1], 3 * q)
  })
  const pre = snap(p), preMu = Float64Array.from(p.mu)
  /** The oracle, from a particle state s (pos, vel, mass) and each particle's μ: the floor row ⌊y/dx⌋ = 0 binned into
   *  (⌊x/dx⌋, ⌊z/dx⌋), every wetted cell's M_c, n_c, U_c and Δv_c (the header's rule), and Σ M_c·Δv_c. */
  const oracleOf = (s, muOf) => {
    const cells = new Map()
    for (let q = 0; q < s.mass.length; q++) {
      if (Math.floor(s.pos[3 * q + 1] / h) !== 0) continue
      const key = Math.floor(s.pos[3 * q] / h) + NX * Math.floor(s.pos[3 * q + 2] / h)
      const e = cells.get(key) ?? { M: 0, n: 0, Px: 0, Pz: 0, Mmu: 0, KE0: 0, KE1: 0 }
      const m = s.mass[q]
      e.M += m; e.n++; e.Px += m * s.vel[3 * q]; e.Pz += m * s.vel[3 * q + 2]; e.Mmu += m * muOf(q); e.KE0 += 0.5 * m * (s.vel[3 * q] ** 2 + s.vel[3 * q + 2] ** 2)
      cells.set(key, e)
    }
    let oBx = 0, oBz = 0, aMax = 0, lam = 0, turb = 0
    for (const e of cells.values()) {
      const Vc = e.n * VP, hc = Math.min(h, Vc / (h * h)), rho = e.M / Vc, Ux = e.Px / e.M, Uz = e.Pz / e.M, U = Math.hypot(Ux, Uz)
      const mu = e.Mmu / e.M, nu = mu / rho, Re = U * hc / nu
      const tau = Re < RE_C ? 3 * mu * U / hc : rho * ustarBisect(U, hc, nu) ** 2
      const a = dt * tau * h * h / (e.M * U)
      Object.assign(e, { U, dvx: -Ux * a / (1 + a), dvz: -Uz * a / (1 + a) })
      oBx += e.M * e.dvx; oBz += e.M * e.dvz; aMax = Math.max(aMax, a); if (Re < RE_C) lam++; else turb++
    }
    return { cells, oBx, oBz, aMax, lam, turb }
  }
  // the oracle, from the pre-state
  const { cells, oBx, oBz, aMax, lam, turb } = oracleOf(pre, q => preMu[q])
  info('W1aK.set', `${p.n} particles, ${cells.size} wetted floor cells (${turb} on the turbulent branch, ${lam} laminar by this file's Re_c ${RE_C.toFixed(7)}), a_max ${e2(aMax)}; cell 13 ${HG.name} (ρ ${HG.rho}, μ ${HG.mu}), cell 2 ${W20.name} + ${W60.name} (μ ${W20.mu} / ${W60.mu})`)
  // the stage, once, through its real entry point
  sim.applyWallShear(p, dt)
  const log = sim.wallShearLog.at(-1), Wd = words
  let worst = 0, offRow = 0, vyc = 0, nRow0 = 0
  const V = Wd(p.vel), V0 = Wd(pre.vel), P = Wd(p.pos), P0 = Wd(pre.pos), Mw = Wd(p.mass), M0 = Wd(pre.mass)
  for (let q = 0; q < p.n; q++) {
    const row = Math.floor(pre.pos[3 * q + 1] / h)
    if (V[3 * q + 1] !== V0[3 * q + 1]) vyc++
    for (let a = 0; a < 3; a++) if (P[3 * q + a] !== P0[3 * q + a]) vyc++
    if (Mw[q] !== M0[q]) vyc++
    for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) if (Wd(p.c[a])[3 * q + b] !== Wd(pre.c[a])[3 * q + b]) { vyc++; if (row !== 0) offRow++ }
    if (row !== 0) { if (V[3 * q] !== V0[3 * q] || V[3 * q + 1] !== V0[3 * q + 1] || V[3 * q + 2] !== V0[3 * q + 2]) offRow++; continue }
    nRow0++
    const e = cells.get(Math.floor(pre.pos[3 * q] / h) + NX * Math.floor(pre.pos[3 * q + 2] / h))
    const ex = Math.abs((p.vel[3 * q] - pre.vel[3 * q]) - e.dvx) / e.U, ez = Math.abs((p.vel[3 * q + 2] - pre.vel[3 * q + 2]) - e.dvz) / e.U
    worst = Math.max(worst, Number.isFinite(ex) ? ex : Infinity, Number.isFinite(ez) ? ez : Infinity)
    e.KE1 += 0.5 * p.mass[q] * (p.vel[3 * q] ** 2 + p.vel[3 * q + 2] ** 2)
  }
  const bookErr = Math.hypot(log.impX - oBx, log.impZ - oBz) / Math.hypot(oBx, oBz)
  let grew = 0
  for (const e of cells.values()) if (!(e.KE1 <= e.KE0 * (1 + 1e-12))) grew++
  check(worst <= 1e-9, 'W1aK.1', `every row-0 particle gets the oracle's Δv_c: ${nRow0} particles, worst |Δv − Δv_c|/|U_c| ${e2(worst)} (≤ 1e-9)`)
  check(offRow === 0, 'W1aK.2', `particles in rows ≥ 1: v and c words changed ${offRow} (0)`)
  check(vyc === 0, 'W1aK.3', `every particle's v_y, c, position and mass: words changed ${vyc} (0)`)
  check(bookErr <= 1e-9, 'W1aK.4', `the log's booked impulse (${e2(log.impX)}, ${e2(log.impZ)}) N·s vs Σ M_c·Δv_c (${e2(oBx)}, ${e2(oBz)}): relative ${e2(bookErr)} (≤ 1e-9)`)
  check(log.cells > 0, 'W1aK.5', `cells acted on ${log.cells} (> 0; the oracle's wetted cells ${cells.size}), laminar-branch cells ${log.laminar}`)
  check(cells.size > 0 && grew === 0, 'W1aK.6', `energy: floor cells whose tangential kinetic energy grew across the stage ${grew} of ${cells.size} checked (0, > 0 checked; 1e-12 relative)`)
  // W1aK.default (GATE-F1): the same pre-state with p.mu removed — μ_c from viscosityDefault, the μ of every dam-break run
  const W25 = waterAt(mat, 25)
  const arms = [
    ['a', `viscosityDefault absent (the class default); the oracle's μ ${W20.name}, ${W20.mu} Pa·s (never the solver's)`, {}, W20.mu],
    ['b', `viscosityDefault from waterOpts(waterAt(materialData, 25)); the oracle's μ water 25 °C, ${mat.LIQUIDS.water.viscosity(25)} Pa·s`, { viscosityDefault: waterOpts(W25).viscosityDefault }, mat.LIQUIDS.water.viscosity(25)],
  ]
  for (const [arm, desc, extra, muArm] of arms) {
    const p2 = makeParticles(pre.mass.length)   // a clone of the pre-state without p.mu
    p2.pos.set(pre.pos); p2.vel.set(pre.vel); p2.mass.set(pre.mass)
    for (let a = 0; a < 3; a++) p2.c[a].set(pre.c[a])
    const sim2 = new FlipRef(L, opts({ wallShear: SHEAR_ON, ...extra }))
    const o = oracleOf(pre, () => muArm)
    sim2.applyWallShear(p2, dt)
    const lg = sim2.wallShearLog.at(-1)
    let worst2 = 0, n0 = 0
    for (let q = 0; q < p2.n; q++) {
      if (Math.floor(pre.pos[3 * q + 1] / h) !== 0) continue
      n0++
      const e = o.cells.get(Math.floor(pre.pos[3 * q] / h) + NX * Math.floor(pre.pos[3 * q + 2] / h))
      const ex = Math.abs((p2.vel[3 * q] - pre.vel[3 * q]) - e.dvx) / e.U, ez = Math.abs((p2.vel[3 * q + 2] - pre.vel[3 * q + 2]) - e.dvz) / e.U
      worst2 = Math.max(worst2, Number.isFinite(ex) ? ex : Infinity, Number.isFinite(ez) ? ez : Infinity)
    }
    const book2 = Math.hypot(lg.impX - o.oBx, lg.impZ - o.oBz) / Math.hypot(o.oBx, o.oBz)
    check(worst2 <= 1e-9 && book2 <= 1e-9 && lg.cells > 0, `W1aK.default.${arm}`, `μ_c from viscosityDefault (p.mu absent), ${desc}: (1) ${n0} row-0 particles, worst |Δv − Δv_c|/|U_c| ${e2(worst2)} (≤ 1e-9); (4) booked (${e2(lg.impX)}, ${e2(lg.impZ)}) vs Σ M_c·Δv_c (${e2(o.oBx)}, ${e2(o.oBz)}) N·s, relative ${e2(book2)} (≤ 1e-9); cells acted on ${lg.cells} (> 0)`)
  }
}

// ── W1b: the law ─────────────────────────────────────────────────────────────────────────────────────────────────────
if (run('W1b')) {
  const rho = 998.2072, mu = 1.001596e-3, nu = mu / rho
  // a refusal of these valid inputs (keuleganTau throws) is that point's failure, never a crash of the gate (header): its
  // τ and u* are NaN, which fails every criterion below; a line with refusals names them (without one it prints as before)
  const refusals = []
  const tauOf = (U, hh) => { try { return keuleganTau(U, hh, nu, rho) } catch (e) { refusals.push(`(${U}, ${hh}): ${String(e?.message ?? e).slice(0, 110)}`); return { tau: NaN, ustar: NaN, laminar: false } } }
  const refusedSince = k => (refusals.length > k ? `; keuleganTau REFUSED ${refusals.length - k} of these valid inputs (first ${refusals[k]})` : '')
  // (resid)
  const r0 = refusals.length
  let nTurb = 0, worst = 0
  for (let a = 0; a <= 40; a++) for (let b = 0; b <= 20; b++) {
    const U = 1e-3 * (5 / 1e-3) ** (a / 40), hh = 1e-3 * (0.0567 / 1e-3) ** (b / 20)
    if (U * hh / nu < RE_C) continue
    const us = tauOf(U, hh).ustar, r = Math.abs(U - us * (AS - BK + BK * Math.log(hh * us / nu))) / U
    nTurb++; worst = Math.max(worst, Number.isFinite(r) ? r : Infinity)
  }
  check(nTurb > 0 && worst <= 1e-12, 'W1b.resid', `eq. 32 residual on the turbulent branch (Re_h ≥ ${RE_C.toFixed(4)}, this file's) of the grid U [1e-3, 5] m/s × h [1 mm, 0.0567 m], 41 × 21: ${nTurb} points, worst |U − u*(3.0 + 2.5·ln(h·u*/ν))|/U ${e2(worst)} (≤ 1e-12)${refusedSince(r0)}`)
  // (ref)
  const r1 = refusals.length
  const refs = [[3.25, 0.01, 0.152471658971, 1e-12, 23.20592848, 1e-8], [4.17, 0.0567, 0.1616324490019, 1e-13, 26.07821158, 1e-8]]
  const refOut = refs.map(([U, hh, us, uu, tau, tu]) => { const r = tauOf(U, hh); return { ok: Math.abs(r.ustar - us) <= 0.5 * uu && Math.abs(r.tau - tau) <= 0.5 * tu && !r.laminar, s: `u*(${U}, ${hh}) ${r.ustar.toPrecision(16)} (printed ${us}), τ ${r.tau.toPrecision(13)} Pa (printed ${tau})` } })
  check(refOut.every(o => o.ok), 'W1b.ref', `turbulent references, each within half a unit of its last printed digit: ${refOut.map(o => o.s).join('; ')}${refusedSince(r1)}`)
  // (lam)
  const r2 = refusals.length
  const lams = [[1e-3, 1e-3, 3.004788e-3], [0.03, 0.01, 9.014364e-3]]
  const lamOut = lams.map(([U, hh, tau]) => { const r = tauOf(U, hh); return { ok: Math.abs(r.tau - tau) <= 5e-10, s: `τ(${U}, ${hh}) ${r.tau.toPrecision(10)} Pa (printed ${tau}; Re_h ${(U * hh / nu).toFixed(1)})` } })
  check(lamOut.every(o => o.ok), 'W1b.lam', `laminar references within 5e-10 Pa: ${lamOut.map(o => o.s).join('; ')}${refusedSince(r2)}`)
  const HS = [1e-3, 2e-3, 6.25e-3, DX / 8, 1e-2, 2.5e-2, 5e-2, 0.0567]
  // (zero)
  const r3 = refusals.length
  const zeros = HS.map(hh => tauOf(0, hh).tau)
  check(zeros.every(t => t === 0), 'W1b.zero', `τ(0, h) at the ${HS.length} scan depths: ${[...new Set(zeros)].join(', ')} (0)${refusedSince(r3)}`)
  // (scan)
  const r4 = refusals.length
  let drops = 0, lowWorst = 0, crossWorst = 0, jumpWorst = 0, nonFinite = 0
  for (const hh of HS) {
    let prev = -Infinity
    for (let k = 0; k <= 4000; k++) {
      const U = 1e-7 * (5 / 1e-7) ** (k / 4000), t = tauOf(U, hh).tau
      if (!Number.isFinite(t)) nonFinite++
      if (!(t >= prev)) drops++
      prev = t
    }
    lowWorst = Math.max(lowWorst, Math.abs(tauOf(1e-7, hh).tau / (3 * rho * nu * 1e-7 / hh) - 1))
    const Um = RE_C * (1 - 1e-6) * nu / hh, Up = RE_C * (1 + 1e-6) * nu / hh
    const tm = tauOf(Um, hh).tau, tp = tauOf(Up, hh).tau
    crossWorst = Math.max(crossWorst, Math.abs(tm / (3 * rho * nu * Um / hh) - 1), Math.abs(tp / (rho * ustarBisect(Up, hh, nu) ** 2) - 1))
    jumpWorst = Math.max(jumpWorst, Math.abs(tp / tm - 1))
  }
  const scanOk = drops === 0 && nonFinite === 0 && lowWorst <= 1e-12 && crossWorst <= 1e-9 && jumpWorst <= 1e-5
  check(scanOk, 'W1b.scan', `U 1e-7 → 5 m/s, 4001 geometric points at h ${HS.map(x => (1000 * x).toPrecision(3)).join('/')} mm: decreases ${drops} (0), non-finite ${nonFinite} (0); |τ/τ_lam − 1| at U = 1e-7 ${e2(lowWorst)} (≤ 1e-12); at Re_h = Re_c(1 ∓ 1e-6) worst |τ/τ_branch − 1| ${e2(crossWorst)} (≤ 1e-9), jump |τ₊/τ₋ − 1| ${e2(jumpWorst)} (≤ 1e-5)${refusedSince(r4)}`)
}

// ── W1c: the sheet ───────────────────────────────────────────────────────────────────────────────────────────────────
if (run('W1c')) {
  const U0 = 2, F = 0.02, h = 0.05, S = scenes()
  function sheet(axis, law) {
    const nx = axis === 0 ? 400 : 4, nz = axis === 0 ? 4 : 400
    const L = new GridLayout({ nx, ny: 8, nz, dx: h })
    const sim = new FlipRef(L, opts({ pressureTolerance: 1e-5, psiTolerance: 1e-4, ...(law ? { wallShear: law } : {}) }))
    const p = S.block([0, 0, 0], [nx - 1, 0, nz - 1], mulberry32(7), 8, h)
    for (let q = 0; q < p.n; q++) p.vel[3 * q + axis] = U0
    const depth = p.n * (h ** 3 / 8) / (nx * h * nz * h), out = []
    for (let s = 1; s * DT_A2 <= 1 + 1e-9; s++) {
      sim.step(p, DT_A2)
      let m = 0, su = 0
      for (let q = 0; q < p.n; q++) { const x = p.pos[3 * q + axis]; if (x >= 9 && x <= 11) { m++; su += p.vel[3 * q + axis] } }
      out.push({ t: s * DT_A2, u: su / m })
    }
    return { out, depth, log: sim.wallShearLog }
  }
  const TS = [0.25, 0.5, 1.0]
  const at = (r, t) => r.out.reduce((b, o) => (Math.abs(o.t - t) < Math.abs(b.t - t) ? o : b))
  const exact = (t, depth, f = F) => U0 - U0 / (1 + (f / 8) * U0 * t / depth)
  const rel = (ctrl, stage, t) => { const c = at(ctrl, t), s = at(stage, t); return (c.u - s.u) / exact(c.t, ctrl.depth) - 1 }
  const DARCY = { wall: 'y-', law: 'darcyTest', f: F }
  const runs = {}
  for (const [axis, name] of [[0, 'x'], [2, 'z']]) {
    const ctrl = sheet(axis, null), stage = sheet(axis, DARCY)
    runs[name] = { ctrl, stage }
    const rs = TS.map(t => rel(ctrl, stage, t)), drift = Math.max(...ctrl.out.map(o => Math.abs(o.u / U0 - 1)))
    const minCells = stage.log.reduce((m, e) => Math.min(m, e.cells), Infinity), booked = stage.log.reduce((s, e) => s + Math.abs(e.impX) + Math.abs(e.impZ), 0)
    const ok = rs.every(r => Math.abs(r) <= 0.03) && stage.log.length === ctrl.out.length && minCells > 0 && booked > 0
    const worstAt = ctrl.out.reduce((b, o) => (Math.abs(o.u / U0 - 1) > Math.abs(b.u / U0 - 1) ? o : b)), valid = drift <= 0.002
    check(valid, `W1cvalid.${name}`, `validity of the ${name} sheet: the control's (stage off) window-mean drift |ū/u0 − 1| max ${(100 * drift).toFixed(3)} % at t ${worstAt.t.toFixed(3)} s over ${ctrl.out.length} steps t ≤ 1 s (≤ 0.2 %); at t ${TS.map(t => { const o = at(ctrl, t); return `${o.t.toFixed(3)} s ${o.u / U0 - 1 >= 0 ? '+' : ''}${(100 * (o.u / U0 - 1)).toFixed(3)} %` }).join(', ')}`)
    const lossMsg = `one-cell sheet along ${name} (depth ${(100 * ctrl.depth).toFixed(3)} cm, u0 ${U0} m/s, darcyTest f ${F}, window [9, 11] m): loss vs exact at t ${TS.map((t, i) => `${at(ctrl, t).t.toFixed(3)} s ${rs[i] >= 0 ? '+' : ''}${(100 * rs[i]).toFixed(2)} %`).join(', ')} (±3 % each); log entries ${stage.log.length}, fewest cells acted on ${minCells} (> 0), Σ|booked| ${e2(booked)} N·s (> 0)`
    if (valid) check(ok, `W1c.${name}`, lossMsg)
    else voidCheck(`W1c.${name}`, lossMsg)
  }
  const fails3 = rs => rs.some(r => !(Math.abs(r) <= 0.03))
  const fmt = rs => rs.map(r => `${r >= 0 ? '+' : ''}${(100 * r).toFixed(2)} %`).join(', ')
  for (const [label, f] of [['W1c.tau2', 2 * F], ['W1c.sign', -F]]) {
    const st = sheet(0, { wall: 'y-', law: 'darcyTest', f }), rs = TS.map(t => rel(runs.x.ctrl, st, t))
    control(fails3(rs), label, `x sheet, darcyTest f = ${f} against the f = ${F} reference, must miss the ±3 %: ${fmt(rs)}`)
  }
  const rsSkip = TS.map(t => rel(runs.x.ctrl, runs.x.ctrl, t))
  control(fails3(rsSkip), 'W1c.skipped', `x sheet, the stage skipped (the control as the stage run), must miss the ±3 %: ${fmt(rsSkip)}`)
  // REPORTED: keulegan1938 against its own ODE
  const kg = sheet(0, SHEAR_ON), nu = 1.001596e-3 / RHO, depth = runs.x.ctrl.depth
  const ode = t1 => { let u = U0; const n = 1000, d = t1 / n, fr = x => -tauOracle(x, depth, nu, RHO) / (RHO * depth); for (let i = 0; i < n; i++) { const k1 = fr(u), k2 = fr(u + 0.5 * d * k1), k3 = fr(u + 0.5 * d * k2), k4 = fr(u + d * k3); u += d * (k1 + 2 * k2 + 2 * k3 + k4) / 6 } return u }
  info('W1c.keulegan', `x sheet, keulegan1938 (20 °C water), loss vs its ODE dū/dt = −τ(ū, h)/(ρh) (this file's law, RK4): ${TS.map(t => { const c = at(runs.x.ctrl, t), s = at(kg, t), ref = U0 - ode(c.t); return `t ${c.t.toFixed(3)} s ${(100 * ((c.u - s.u) / ref - 1)).toFixed(2)} %` }).join(', ')} (reported; spec 1.1–2.1 %)`)
}

// ── W1d: the placement audit ─────────────────────────────────────────────────────────────────────────────────────────
if (run('W1d')) {
  const aCells = 12, h = 0.05, nx = 72, nz = 8, tUnit = Math.sqrt(aCells * h / G), dt = DT_A2, TAU = 10
  /** The particle stage, disarmed until the gate arms it; records the particles as the stage receives them. */
  class Armed extends FlipRef {
    armed = false; stageIn = null; stageOut = null
    applyWallShear(p, dt2) {
      if (!this.armed) return
      this.stageIn = { pos: Float64Array.from(p.pos), vel: Float64Array.from(p.vel), mass: Float64Array.from(p.mass) }
      super.applyWallShear(p, dt2)
      this.afterStage(p)
      this.stageOut = Float64Array.from(p.vel)
    }
    afterStage() {}
  }
  /** Control: Δv on rows 0 AND 1 — the stage's per-cell Δv (its field) added to the row-1 particles of the same cell. */
  class Rows01 extends Armed {
    afterStage(p) {
      const L = this.layout, hh = L.dx, dv = new Map(this.wallShearField.map(e => [e.i + L.nx * e.k, e]))
      for (let q = 0; q < p.n; q++) {
        if (Math.floor(p.pos[3 * q + 1] / hh) !== 1) continue
        const i = Math.min(L.nx - 1, Math.max(0, Math.floor(p.pos[3 * q] / hh))), k = Math.min(L.nz - 1, Math.max(0, Math.floor(p.pos[3 * q + 2] / hh)))
        const e = dv.get(i + L.nx * k)
        if (e) { p.vel[3 * q] += e.dvx; p.vel[3 * q + 2] += e.dvz }
      }
    }
  }
  /** Control G1: the physics memo's grid stage (template FR/spec/src/sim-ref/flipRef.ts applyFloorShear, 'cell' mass),
   *  with the constant τ: on u* after gridUpdate, every FLUID, valid floor x- and z-face (j = 0) with first-cell mass M
   *  (particles with y < dx, horizontal hat weights, side-wall ghost weights folded in) and tangential speed u_t =
   *  |(u_a, mean of the up to four surrounding b-faces)| > 0 is scaled by f = 1/(1 + Δt·τ·dx²/(M·u_t)); it books
   *  M·u_a·(f − 1). The particle stage is not enabled (no option). */
  class GridStage extends FlipRef {
    armed = false; pIn = null; gridField = []
    p2g(p) { this.pIn = p; super.p2g(p) }
    gridUpdate(dt2) { super.gridUpdate(dt2); if (this.armed) this.floorShearGrid(dt2, this.pIn) }
    floorShearGrid(dt2, p) {
      const L = this.layout, hh = L.dx, n = [L.nx, L.ny, L.nz]
      const Mcell = [new Float64Array(L.size), null, new Float64Array(L.size)]
      for (let q = 0; q < p.n; q++) {
        if (!(p.pos[3 * q + 1] < hh)) continue
        const x = p.pos[3 * q], z = p.pos[3 * q + 2], m = p.mass[q]
        for (const a of [0, 2]) {
          const b = a === 0 ? 2 : 0, ca = (a === 0 ? x : z) / hh, cb = (a === 0 ? z : x) / hh - 0.5
          const ia = Math.floor(ca), ib = Math.floor(cb), ta = ca - ia, tb = cb - ib
          for (let da = 0; da < 2; da++) for (let db = 0; db < 2; db++) {
            const w = (da ? ta : 1 - ta) * (db ? tb : 1 - tb)
            if (w === 0) continue
            const fa = ia + da, fb = Math.min(n[b] - 1, Math.max(0, ib + db))
            if (fa < 0 || fa > n[a]) continue
            Mcell[a][a === 0 ? L.idx(fa, 0, fb) : L.idx(fb, 0, fa)] += w * m
          }
        }
      }
      const upd = []
      let faces = 0, impX = 0, impZ = 0
      this.gridField = []
      for (const a of [0, 2]) {
        const b = a === 0 ? 2 : 0, t = this.faceType[a], ok = this.valid[a], u = this.u[a], [lo, hi] = L.faceRange(a)
        const ub = this.u[b], okb = this.valid[b], tb = this.faceType[b]
        for (let k = lo[2]; k <= hi[2]; k++) for (let i = lo[0]; i <= hi[0]; i++) {
          const s = L.idx(i, 0, k)
          if (t[s] !== FaceType.FLUID || !ok[s]) continue
          const M = Mcell[a][s]
          if (!(M > 0)) continue
          let vb = 0, nb = 0
          for (const da of [-1, 0]) for (const db of [0, 1]) {
            const cc = [i, 0, k]; cc[a] += da; cc[b] += db
            if (cc[a] < 0 || cc[a] >= n[a] || cc[b] < 0 || cc[b] > n[b]) continue
            const sb = L.idx(cc[0], cc[1], cc[2])
            if (okb[sb] || tb[sb] === FaceType.SOLID) { vb += tb[sb] === FaceType.SOLID ? 0 : ub[sb]; nb++ }
          }
          const ua = u[s], ut = Math.hypot(ua, nb > 0 ? vb / nb : 0)
          if (!(ut > 0)) continue
          const f = 1 / (1 + dt2 * TAU * hh * hh / (M * ut))
          upd.push([a, s, f])
          faces++
          const imp = M * ua * (f - 1)
          if (a === 0) impX += imp; else impZ += imp
          this.gridField.push({ i, x: a === 0 ? imp : 0, z: a === 2 ? imp : 0 })   // i: x-face index (a = 0) or cell column (a = 2)
        }
      }
      for (const [a, s, f] of upd) this.u[a][s] *= f
      this.wallShearLog.push({ t: this.time, cells: faces, impX, impZ, tauMax: TAU, laminar: 0 })
    }
  }
  const wallForce = sim => { const L = sim.layout; let F = 0; for (let k = 0; k < L.nz; k++) for (let j = 0; j < L.ny; j++) { const c = L.idx(0, j, k); if (sim.label[c] === CellLabel.LIQUID) F += sim.pressure[c] * h * h } return F }
  const res = {}
  for (const T of [2, 3]) {
    const N = Math.round(T * tUnit / dt), tauEnd = (N + 1.5) * dt / tUnit
    const args = (extra, onStep) => ({ aCells, n2: 1, h, nx, tauEnd, gate: 4.53, extra, onStep })
    let ctrlN = null, iB = 0
    const S0 = scenes()
    const ctrl = S0.column(args({}, (sim, p, s) => { if (s === N) { ctrlN = snap(p); iB = Math.round(S0.frontSlab(p.pos, p.n, h, nz) / h) - 2 } }))
    const ctrlF = wallForce(ctrl.sim), ctrlV = Float64Array.from(ctrl.p.vel), mass = ctrl.p.mass
    const variant = (Cls, extra) => {
      let lock = -1
      const r = scenes({ ...TREE, FlipRef: Cls }).column(args(extra, (sim, p, s) => { if (s === N) { lock = diffWords(snap(p), ctrlN); sim.armed = true } }))
      return { sim: r.sim, p: r.p, lock, F: wallForce(r.sim) }
    }
    const constTest = tau => ({ wallShear: { wall: 'y-', law: 'constantTest', tau } })
    const V = {
      P: variant(Armed, constTest(TAU)),
      G1: variant(GridStage, {}),
      rows01: variant(Rows01, constTest(TAU)),
      sign: variant(Armed, constTest(-TAU)),
      tau2: variant(Armed, constTest(2 * TAU)),
    }
    // the target, binned here from the stage's own input (P's; every variant's input is the same state)
    const inp = V.P.sim.stageIn, cellsT = new Map()
    for (let q = 0; q < inp.mass.length; q++) {
      if (Math.floor(inp.pos[3 * q + 1] / h) !== 0) continue
      const i = Math.floor(inp.pos[3 * q] / h), k = Math.floor(inp.pos[3 * q + 2] / h), key = i + nx * k
      const e = cellsT.get(key) ?? { i, M: 0, Px: 0, Pz: 0 }
      e.M += inp.mass[q]; e.Px += inp.mass[q] * inp.vel[3 * q]; e.Pz += inp.mass[q] * inp.vel[3 * q + 2]
      cellsT.set(key, e)
    }
    const Tf = [0, 0]
    let aMax = 0, nWet = 0, nF = 0
    for (const e of cellsT.values()) {
      const U = Math.hypot(e.Px, e.Pz) / e.M
      if (!(U > 0)) continue
      nWet++
      if (e.i < iB) continue
      const kk = TAU * h * h * dt
      Tf[0] -= kk * (e.Px / e.M) / U; Tf[1] -= kk * (e.Pz / e.M) / U
      aMax = Math.max(aMax, kk / (e.M * U)); nF++
    }
    const lo = 1 / (1 + aMax), TT = Tf[0] ** 2 + Tf[1] ** 2
    const measure = (v, grid) => {
      const lg = v.sim.wallShearLog.at(-1)
      let Bf = [0, 0], BfX = 0
      if (grid) for (const e of v.sim.gridField) { if (e.i >= iB) { Bf[0] += e.x; Bf[1] += e.z } }
      else for (const e of v.sim.wallShearField) if (e.i >= iB) { Bf[0] += e.M * e.dvx; Bf[1] += e.M * e.dvz }
      BfX = Bf[0]
      let dP = 0, dPf = 0
      for (let q = 0; q < mass.length; q++) { const d = mass[q] * (v.p.vel[3 * q] - ctrlV[3 * q]); dP += d; if (ctrlN.pos[3 * q] >= iB * h) dPf += d }
      const dW = (v.F - ctrlF) * dt
      const i1 = (Bf[0] * Tf[0] + Bf[1] * Tf[1]) / TT, i2 = (dP - dW) / lg.impX, i3 = dPf / BfX
      const pass = { i: i1 >= lo && i1 <= 1, ii: Math.abs(i2 - 1) <= 0.03, iii: Math.abs(i3 - 1) <= 0.05 }
      return { lg, i1, i2, i3, pass, booked: Math.abs(lg.impX) + Math.abs(lg.impZ), wall: dW }
    }
    const m = {}
    for (const [name, v] of Object.entries(V)) m[name] = measure(v, name === 'G1')
    res[T] = { N, iB, nWet, nF, aMax, lo, m, locks: Object.fromEntries(Object.entries(V).map(([k, v]) => [k, v.lock])), T: N * dt / tUnit }
    // REPORTED: W1d-t, the transfer-only split of the stage's Δv at the same state
    const L = new GridLayout({ nx, ny: aCells + 8, nz, dx: h })
    const tr = new FlipRef(L, { gravity: [0, 0, 0], density: RHO, projection: false, densityProjection: false })
    const pt = makeParticles(inp.mass.length)
    pt.pos.set(inp.pos); pt.mass.set(inp.mass)
    let bookG = 0, bookF = 0
    for (let q = 0; q < pt.n; q++) {
      const d = V.P.sim.stageOut[3 * q] - inp.vel[3 * q], dz = V.P.sim.stageOut[3 * q + 2] - inp.vel[3 * q + 2]
      pt.vel[3 * q] = d; pt.vel[3 * q + 2] = dz
      bookG += pt.mass[q] * d; if (inp.pos[3 * q] >= iB * h) bookF += pt.mass[q] * d
    }
    tr.p2g(pt); tr.gridUpdate(dt); tr.extrapolate(); tr.applySolidFaces(); tr.g2p(pt)
    let keptG = 0, keptF = 0
    for (let q = 0; q < pt.n; q++) { keptG += pt.mass[q] * pt.vel[3 * q]; if (inp.pos[3 * q] >= iB * h) keptF += pt.mass[q] * pt.vel[3 * q] }
    info(`W1d-t.T${T}`, `transfer-only (one P2G → gridUpdate(g = 0) → extrapolate → solid faces → G2P of the stage's Δv alone at its input positions, no projection), step ${N + 1}: kept ÷ booked (x) global ${f4(keptG / bookG)}, front ${f4(keptF / bookF)} (spec §3.5: 0.978–0.984 under deeper liquid, 1.001 for a one-row sheet)`)
  }
  const Ts = [2, 3], R = res
  const row = (name, key, fmt) => Ts.map(T => `T ${R[T].T.toFixed(3)}: ${fmt(R[T].m[name], R[T])}`).join('; ')
  info('W1d.band', Ts.map(T => `T ${R[T].T.toFixed(3)} (step ${R[T].N + 1}): i_B ${R[T].iB}, ${R[T].nWet} wetted floor cells (${R[T].nF} in the front band), a_max ${e2(R[T].aMax)} → (i) window [${f4(R[T].lo)}, 1]`).join('; '))
  const locksOk = Ts.every(T => Object.values(R[T].locks).every(d => d === 0)), nonvac = Ts.every(T => R[T].m.P.lg.cells > 0 && R[T].m.P.booked > 0)
  check(locksOk && nonvac, 'W1d.setup', `lockstep: differing words at step N vs the control, per variant ${Ts.map(T => `T${T} ${Object.entries(R[T].locks).map(([k, d]) => `${k} ${d}`).join(' ')}`).join('; ')} (0 each); the stage at N + 1: ${Ts.map(T => `T${T} ${R[T].m.P.lg.cells} cells, Σ|booked| ${e2(R[T].m.P.booked)} N·s`).join('; ')} (> 0)`)
  check(Ts.every(T => R[T].m.P.pass.i), 'W1d(i)', `front booking B⃗_f·T⃗_f/|T⃗_f|² ${row('P', 'i', (x, r) => `${f4(x.i1)} ∈ [${f4(r.lo)}, 1]`)}`)
  check(Ts.every(T => R[T].m.P.pass.ii), 'W1d(ii)', `global (ΔP_x − ΔI_wall)/B_x ${row('P', 'ii', x => `${f4(x.i2)} (wall ${e2(x.wall)} N·s, B_x ${e2(x.lg.impX)})`)} (±3 %)`)
  check(Ts.every(T => R[T].m.P.pass.iii), 'W1d(iii)', `front ΔP_x/B_x,f ${row('P', 'iii', x => f4(x.i3))} (±5 %)`)
  for (const [name, what] of [['G1', 'G1, the grid stage (physics memo, subclass)'], ['rows01', 'Δv on rows 0 and 1'], ['sign', 'sign flipped (τ = −10 Pa)'], ['tau2', 'τ×2 (τ = 20 Pa)']]) {
    const failed = Ts.some(T => { const p = R[T].m[name].pass; return !(p.i && p.ii && p.iii) })
    control(failed, `W1d.${name}`, `${what} must fail (i), (ii) or (iii) at T = 2 or 3: ${Ts.map(T => { const x = R[T].m[name]; return `T${T} (i) ${f4(x.i1)}${x.pass.i ? '' : ' FAILS'}, (ii) ${f4(x.i2)}${x.pass.ii ? '' : ' FAILS'}, (iii) ${f4(x.i3)}${x.pass.iii ? '' : ' FAILS'}` }).join('; ')}`)
  }
}

console.log(`\ns3.8 reference gate${ONLY ? ` (--only=${ONLY.join(',')})` : ''}: ${fails ? `FAIL (${fails})` : 'PASS'}${voids ? `; VOID ${voids}` : ''}  (${((Date.now() - t0) / 1000).toFixed(0)} s)`)
process.exit(fails ? 1 : 0)
