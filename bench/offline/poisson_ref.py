"""
Gate 0 (G0-b) numpy reference for the GPU pressure-Poisson solver
(src/gpu-sim/flip/poisson/PoissonSolver.ts).  FINAL-PLAN section 5.3 / section 7 S0.5.

WHAT THIS IS
  A port of research subagent r1's poisson_bench.py (fluid-research/, 2026-09-28): the same
  voxelised free-surface Poisson operator (FLUID = unknown, AIR = Dirichlet p = 0,
  SOLID = Neumann), the same Jacobi-PCG and the same MGPCG preconditioner, which follows
  McAdams, Sifakis, Teran 2010 ("A parallel multigrid Poisson solver for fluids simulation on
  large grids", SCA 2010, https://www.math.ucdavis.edu/~jteran/papers/MST10.pdf) section 3.2:
    - damped Jacobi w = 2/3, 2 pre + 2 post sweeps (McAdams' extra boundary Gauss-Seidel sweeps
      are NOT used, as in r1 and FINAL-PLAN 5.3),
    - restriction B(x)B(x)B with B = [1,3,3,1]/8, prolongation 8 R^T (trilinear),
    - coarse cell Dirichlet if ANY child is Dirichlet, else interior if any child is interior,
      else Neumann,
    - "at every level ... we construct a voxelized description of our domain ... The procedure
      of Section 3.1 is then followed to construct a discrete Poisson operator L from this
      voxelized representation" (McAdams 3.2): REDISCRETISATION from the coarse labels, the
      7-point stencil with spacing 2^l h, i.e. every face between two non-Neumann coarse cells
      is open with coefficient 0.25^l (class Level / MG below),
    - 5 levels 64 -> 4, coarsest solved by a FIXED 60 damped-Jacobi sweeps from zero.
  Generalised to
    * dtype float64 AND float32 (every array and scalar stays in the chosen dtype; asserted),
    * two stopping rules: relative 2-norm ||r||/||b|| (r1) and absolute inf-norm ||r||_inf
      (the production rule of FINAL-PLAN 5.3; iteration count 0 when ||r0||_inf <= tol),
    * warm start x0,
    * per-iteration residual history (rel-2 and inf) so GPU curves can be compared point-wise,
    * VARIABLE face coefficients (class VarLevel / VarMG): the rule the GPU implements
      (prepare.wgsl). Level 0: e_f = a_f unless a cell of the face is SOLID, diag = sum e_f +
      extraDiag. Coarse levels: the NOMINAL (unmasked) coefficient of a coarse face is
      (1/4) * mean of the 4 fine nominal coefficients it covers; the face is open iff both
      coarse cells are non-SOLID (McAdams' rule). With a uniform a_f this is EXACTLY McAdams'
      rediscretisation (asserted: VarMG == MG to round-off on the ball/step domains).
      The arithmetic mean for varying a_f is [PROPOSED]; FINAL-PLAN G0-c decides whether large
      density contrasts need Galerkin coarsening instead.
  The stationary solvers of r1 (Jacobi / GS / SOR) are dropped: they are not under test.

WHAT IT WRITES  (--out, default bench-results/gate0/fixtures, regenerable, gitignored)
  n<N>/manifest.json            cases, numpy counts (f64 + f32, JPCG + MGPCG), histories
  n<N>/labels_<domain>.u8       padded (N+2)^3 cell labels, x-fastest: idx = i + (N+2)*(j + (N+2)*k)
                                values AIR=0 FLUID=1 SOLID=2; j (2nd axis) is "up"
  n<N>/rhs_<case>.f32           padded rhs, little-endian float32, same layout
  n<N>/x0_<case>.f32            warm-start x0 (numpy f64 solution rounded to f32), same layout
  n<N>/fcoef_<name>.f32         padded vec4 per cell (a-x, a-y, a-z, extraDiag), component fastest
  n<N>/unit_*.f32               operator / preconditioner fixtures (A.x and one V-cycle M.r)

PROBLEMS (every case records its source; "pub" cases reproduce published scripts EXACTLY)
  parity/*            r1's six domains x RHS (tank_half, dam_break, tank_shallow) x (hydrostatic,
                      random); random = default_rng(1) drawn fresh per case (one-case invocations of
                      poisson_bench.py). Relative 2-norm 1e-4 (FINAL-PLAN G0-b "(14, 15, 13, 12)").
                      + the same two RHS on tank_half with an interior solid ball / an odd-aligned
                      step (reviewer g0review/coarse_rule.py geometry), + one variable-coefficient
                      case with a ghost-fluid-like extra diagonal (a test load of the code path).
  pub/perfcritic/*    perfcritic/infnorm_iters.py (box 3.63 m, dx = 3.63/n, dt = 1/120 s,
                      ONE default_rng(7) shared by both domains, draw order b_noise, 1% perturbation,
                      fresh noise, density noise): gravity/impact/noise/combined, the three warm
                      starts (x0 = numpy f64 solves to ||r||_inf 1e-6), density noise(+impact).
  pub/reviewB/*       reviewB/tol_bench.py (dx = 3.2/n, as that script): dam_break gravity at
                      dt = 5.8/7.5/16.7 ms, wedge impact u = 3, 6 m/s and their +10% warm restarts
                      (x0 = numpy f64 solve to ||r||_inf 1e-4, where that script's loop stops),
                      psi: wedge random 1%, 10% (default_rng(5)) and smooth 2% compression.
  prod/*              lane additions at production settings (box 3.63 m): dam_break gravity at
                      dt = T/3 and T (T = 1/60 s; T/2 is pub/perfcritic gravity_only), gravity step
                      on the ball and step domains.
  Solve classes: 'p' = velocity (pressure) solve, ||r||_inf <= 1e-2 s^-1; 'psi' = density solve,
  ||r||_inf <= 1e-3 (volume-fraction units); 'parity' = numpy parity only (not used for caps).
  Unknown q = dt p/(rho dx^2), so the residual is -div(u) in s^-1 (perfcritic convention).
  g = 9.80665 m/s^2 (standard gravity, exact; https://physics.nist.gov/cgi-bin/cuu/Value?gn).
  RHS amplitudes of the impact / noise cases are DERIVED or ASSUMED in those scripts (labelled
  there); they are test loads, not measurements of a flow.

PORT CHECK (--check-port): the f64 path must reproduce, EXACTLY, every iteration count already
  published by r1 (poisson_bench_n64_*.json), perfcritic (infnorm_iters_n64.json) and reviewB
  (tol64.json, all four targets 1e-1..1e-4) on the identical problems. Any mismatch = port bug.
  It also asserts VarMG(uniform a) == MG (the GPU coarse rule reduces to McAdams).

Usage:
  python bench/offline/poisson_ref.py --n 64 --check-port
  python bench/offline/poisson_ref.py --n 64            # fixtures + numpy counts for 64^3
  python bench/offline/poisson_ref.py --n 48
"""
import argparse
import json
import math
import os
import sys
import time

import numpy as np

sys.stdout.reconfigure(encoding="utf-8")

FLUID, AIR, SOLID = 1, 0, 2
SHIFTS = [(1, 0, 0), (-1, 0, 0), (0, 1, 0), (0, -1, 0), (0, 0, 1), (0, 0, -1)]
G = 9.80665          # m s^-2, standard gravity (exact by definition)
BOX_L = 3.63         # m, FINAL-PLAN 4.3 default domain (perfcritic)
BOX_L_REVIEWB = 3.2  # m, reviewB tol_bench.py: dx = 3.2/64 * 64/n


# ---------------------------------------------------------------- domains (r1 + tol_bench + reviewer)
def make_domain(n, kind):
    """Cell-type array (n+2)^3 with a 1-cell SOLID border. r1 kinds + reviewB 'wedge' +
    reviewer coarse_rule.py 'tank_half_ball' / 'tank_half_step' (interior solids)."""
    t = np.full((n + 2, n + 2, n + 2), SOLID, dtype=np.int8)
    inner = np.full((n, n, n), AIR, dtype=np.int8)
    x, y, z = np.meshgrid(np.arange(n), np.arange(n), np.arange(n), indexing="ij")
    if kind in ("tank_half", "tank_half_ball", "tank_half_step"):
        inner[y < n // 2] = FLUID
        if kind == "tank_half_ball":      # sphere R = 0.15 n, off-lattice centre, inside the water
            c = np.array([0.43 * n, 0.23 * n, 0.51 * n])
            R = 0.15 * n
            inner[(x - c[0]) ** 2 + (y - c[1]) ** 2 + (z - c[2]) ** 2 < R * R] = SOLID
        elif kind == "tank_half_step":    # a floor step one cell off the 2^l lattice
            inner[(x >= n // 2 + 1) & (y < n // 8 + 1)] = SOLID
    elif kind == "dam_break":
        inner[(x < 3 * n // 8) & (y < 3 * n // 4)] = FLUID
    elif kind == "tank_shallow":
        inner[y < n // 4] = FLUID
    elif kind == "wedge":            # reviewB tol_bench.py "mid-collapse wedge hitting right wall"
        hgt = (0.45 * n - 0.33 * n * x / n).astype(int)
        inner[y < hgt] = FLUID
    else:
        raise ValueError(kind)
    t[1:-1, 1:-1, 1:-1] = inner
    return t


def nb(a, s):
    n0, n1, n2 = a.shape
    return a[1 + s[0]:n0 - 1 + s[0], 1 + s[1]:n1 - 1 + s[1], 1 + s[2]:n2 - 1 + s[2]]


# ---------------------------------------------------------------- operator (r1 Level, dtype-safe)
class Level:
    """McAdams / r1 constant-coefficient operator: scale * 7-point stencil from the labels."""

    def __init__(self, types, scale, dtype):
        self.dtype = dtype
        self.t = types
        self.F = (types[1:-1, 1:-1, 1:-1] == FLUID)
        cnt = np.zeros(self.F.shape, dtype=dtype)
        self.fn = []
        for s in SHIFTS:
            tn = nb(types, s)
            cnt += (tn != SOLID).astype(dtype)
            self.fn.append((tn == FLUID) & self.F)
        # a FLUID cell with only SOLID neighbours would be singular; the GPU treats it as a
        # non-unknown. No test domain may contain one (asserted so both sides stay identical).
        assert not (self.F & (cnt == 0)).any(), "isolated FLUID cell"
        self.scale = dtype(scale)
        self.diag = (np.where(self.F, cnt, dtype(1)) * self.scale).astype(dtype)
        self.shape = self.F.shape

    def pad(self, p):
        q = np.zeros((p.shape[0] + 2, p.shape[1] + 2, p.shape[2] + 2), dtype=self.dtype)
        q[1:-1, 1:-1, 1:-1] = p
        return q

    def offsum(self, p):
        assert p.dtype == self.dtype
        q = self.pad(p)
        s = np.zeros(self.shape, dtype=self.dtype)
        for m, sh in zip(self.fn, SHIFTS):
            s += np.where(m, nb(q, sh), self.dtype(0))
        return s * self.scale

    def A(self, p):
        assert p.dtype == self.dtype
        out = np.where(self.F, self.diag * p - self.offsum(p), self.dtype(0))
        assert out.dtype == self.dtype
        return out


def coarsen_types(t):
    inner = t[1:-1, 1:-1, 1:-1]
    n = inner.shape[0]
    c = inner.reshape(n // 2, 2, n // 2, 2, n // 2, 2).transpose(0, 2, 4, 1, 3, 5).reshape(n // 2, n // 2, n // 2, 8)
    anyair = (c == AIR).any(-1)
    anyfl = (c == FLUID).any(-1)
    ct = np.full((n // 2,) * 3, SOLID, dtype=np.int8)
    ct[anyfl] = FLUID
    ct[anyair] = AIR            # Dirichlet if ANY child is Dirichlet (McAdams 2010 sec. 3.2)
    out = np.full((n // 2 + 2,) * 3, SOLID, dtype=np.int8)
    out[1:-1, 1:-1, 1:-1] = ct
    return out


def prolong(uc):
    """Cell-centred trilinear prolongation, 1-D weights 3/4 (parent) + 1/4 (neighbour), zero outside."""
    u = uc
    dt = uc.dtype
    for ax in range(3):
        n = u.shape[ax]
        up = np.zeros(u.shape[:ax] + (2 * n,) + u.shape[ax + 1:], dtype=dt)
        pad = np.pad(u, [(1, 1) if a == ax else (0, 0) for a in range(3)])
        sl = lambda a, b_: tuple(slice(a, b_) if k == ax else slice(None) for k in range(3))
        even = 0.75 * pad[sl(1, n + 1)] + 0.25 * pad[sl(0, n)]
        odd = 0.75 * pad[sl(1, n + 1)] + 0.25 * pad[sl(2, n + 2)]
        up[tuple(slice(0, 2 * n, 2) if k == ax else slice(None) for k in range(3))] = even
        up[tuple(slice(1, 2 * n, 2) if k == ax else slice(None) for k in range(3))] = odd
        u = up
    assert u.dtype == dt
    return u


def restrict(uf):
    """R = P^T / 8, 1-D stencil [1,3,3,1]/8 on fine indices 2I-1, 2I, 2I+1, 2I+2; zero outside."""
    u = uf
    dt = uf.dtype
    for ax in range(3):
        n = u.shape[ax] // 2
        sl = lambda s: tuple(s if k == ax else slice(None) for k in range(3))
        e = u[sl(slice(0, 2 * n, 2))]
        o = u[sl(slice(1, 2 * n, 2))]
        o_prev = np.pad(o, [(1, 0) if k == ax else (0, 0) for k in range(3)])[sl(slice(0, n))]
        e_next = np.pad(e, [(0, 1) if k == ax else (0, 0) for k in range(3)])[sl(slice(1, n + 1))]
        u = 0.375 * e + 0.375 * o + 0.125 * o_prev + 0.125 * e_next
    assert u.dtype == dt
    return u


class MGBase:
    """V-cycle (McAdams Algorithm 1 as a preconditioner, r1 poisson_bench.MG), dtype-safe."""

    def smooth(self, L, u, b, iters):
        for _ in range(iters):
            u = np.where(L.F, u + self.omega * (b - L.A(u)) / L.diag, self.dtype(0))
        return u

    def vcycle(self, l, b):
        L = self.levels[l]
        z0 = np.zeros(L.shape, dtype=self.dtype)
        if l == len(self.levels) - 1:
            return self.smooth(L, z0, b, self.ci)
        u = self.smooth(L, z0, b, self.nu)
        r = np.where(L.F, b - L.A(u), self.dtype(0))
        Lc = self.levels[l + 1]
        rc = np.where(Lc.F, restrict(r), self.dtype(0))
        ec = self.vcycle(l + 1, rc)
        u = u + np.where(L.F, prolong(ec), self.dtype(0))
        u = self.smooth(L, u, b, self.nu)
        assert u.dtype == self.dtype
        return u

    def __call__(self, r):
        assert r.dtype == self.dtype
        return self.vcycle(0, r)


class MG(MGBase):
    """McAdams rediscretisation with a constant coefficient (scale 0.25 per level)."""

    def __init__(self, types, dtype, nu=2, coarse_iters=60):
        self.dtype = dtype
        self.levels = [Level(types, 1.0, dtype)]
        t = types
        scale = 1.0
        while t.shape[0] - 2 > 4:
            t = coarsen_types(t)
            scale *= 0.25       # Laplacian on spacing 2h
            self.levels.append(Level(t, scale, dtype))
        self.nu = nu
        self.ci = coarse_iters
        self.omega = dtype(2.0 / 3.0)


# ---------------------------------------------------------------- variable coefficients (GPU rule)
class VarLevel:
    """7-point operator from NOMINAL face coefficients e[a] (padded arrays; e[a][i,j,k] = coefficient
    of the MINUS-a face of padded cell (i,j,k), the GPU layout) + extra diagonal (interior array).
    A face is open iff neither of its cells is SOLID. Row of a FLUID cell:
    diag = sum over open faces of e_f + extra, off-diagonal -e_f to FLUID neighbours."""

    def __init__(self, t, e, extra, dtype):
        self.dtype = dtype
        self.t = t
        self.e = e
        self.F = t[1:-1, 1:-1, 1:-1] == FLUID
        self.shape = self.F.shape
        n0, n1, n2 = t.shape
        dims = [n0, n1, n2]
        I = (slice(1, n0 - 1), slice(1, n1 - 1), slice(1, n2 - 1))
        self.cf = []
        for a in range(3):
            s = list(I)
            s[a] = slice(2, dims[a])                     # plus face = minus face of the next cell
            self.cf.append(e[a][tuple(s)].astype(dtype))
            self.cf.append(e[a][I].astype(dtype))
        diag = np.zeros(self.shape, dtype=dtype)
        self.fn = []
        for c, s in zip(self.cf, SHIFTS):
            tn = nb(t, s)
            diag += np.where(tn != SOLID, c, dtype(0))
            self.fn.append((tn == FLUID) & self.F)
        if extra is not None:
            diag += np.where(self.F, extra.astype(dtype), dtype(0))
        assert not (self.F & ~(diag > 0)).any(), "FLUID cell with non-positive diagonal"
        self.diag = np.where(self.F, diag, dtype(1)).astype(dtype)

    def A(self, p):
        assert p.dtype == self.dtype
        q = np.zeros(tuple(s + 2 for s in p.shape), dtype=self.dtype)
        q[1:-1, 1:-1, 1:-1] = p
        off = np.zeros(self.shape, dtype=self.dtype)
        for c, m, s in zip(self.cf, self.fn, SHIFTS):
            off += np.where(m, c * nb(q, s), self.dtype(0))
        out = np.where(self.F, self.diag * p - off, self.dtype(0))
        assert out.dtype == self.dtype
        return out


def coarsen_faces(e):
    """Nominal coarse face coefficient = (1/16) * sum of the 4 fine nominal coefficients on the
    coarse face (= 0.25 x their mean; 0.25 = h^2/(2h)^2). prepare.wgsl coarseFace, same indices:
    coarse padded (I+1, J+1, K+1) minus-a face covers fine padded 2I+1 along a and 2J+1, 2J+2 on
    the two other axes. Label independent; ghost entries 0 (never used: ghosts are SOLID)."""
    P = e[0].shape[0]
    nf = P - 2
    nc = nf // 2
    out = []
    for a in range(3):
        c = np.zeros((nc + 2,) * 3, dtype=np.float64)
        fine = e[a][1:-1, 1:-1, 1:-1]                           # interior fine cells, [i, j, k]
        # group interior fine cells in 2x2x2 blocks; minus-a face of the coarse cell = the children
        # with even (0-based) index along a
        blk = fine.reshape(nc, 2, nc, 2, nc, 2)          # axes I, di, J, dj, K, dk
        sel = [slice(None)] * 6
        sel[2 * a + 1] = slice(0, 1)                      # children with even index along a
        s = blk[tuple(sel)].sum(axis=(1, 3, 5))
        c[1:-1, 1:-1, 1:-1] = s / 16.0
        out.append(c)
    return out


class VarMG(MGBase):
    """The GPU's MG hierarchy for nominal face coefficients (level 0 extra diagonal only)."""

    def __init__(self, types, e, extra, dtype, nu=2, coarse_iters=60):
        self.dtype = dtype
        self.levels = [VarLevel(types, e, extra, dtype)]
        t = types
        while t.shape[0] - 2 > 4:
            t = coarsen_types(t)
            e = coarsen_faces(e)
            self.levels.append(VarLevel(t, e, None, dtype))
        self.nu = nu
        self.ci = coarse_iters
        self.omega = dtype(2.0 / 3.0)


def uniform_faces(n, value=1.0):
    """Nominal a_f = value on EVERY face incl. faces touching SOLID and ghosts (writeUnitCoefficients)."""
    return [np.full((n + 2,) * 3, value, dtype=np.float64) for _ in range(3)]


# ---------------------------------------------------------------- PCG with both stopping rules
def pcg(L, b, M, criterion, tol, x0=None, maxit=2000):
    """Returns dict(iters=None|k, hist=[(rel2, inf), ...] for k = 0..last, x, true_rel2, true_inf).
    Convergence is tested after the r-update of iteration k (and at k = 0), before z = M r.
    rel2 with b == 0: the relative residual is undefined, so only an exactly zero residual counts
    as converged (a stale warm start is iterated, never accepted); inf has no such special case."""
    dt = L.dtype
    assert b.dtype == dt
    x = np.zeros(L.shape, dtype=dt) if x0 is None else x0.astype(dt).copy()
    r = np.where(L.F, b - L.A(x), dt(0)) if x0 is not None else b.copy()
    bn = np.linalg.norm(b)

    def met(rr):
        nr = float(np.linalg.norm(rr))
        rel = nr / float(bn) if bn > 0 else (0.0 if nr == 0 else math.inf)
        inf = float(np.abs(rr).max())
        return rel, inf

    def done(rel, inf):
        return (rel <= tol) if criterion == "rel2" else (inf <= tol)

    rel, inf = met(r)
    hist = [(rel, inf)]
    iters = 0 if done(rel, inf) else None
    k = 0
    if iters is None:
        z = M(r)
        d = z.copy()
        rz = np.sum(r * z)
        for k in range(1, maxit + 1):
            Ad = L.A(d)
            alpha = rz / np.sum(d * Ad)
            x += alpha * d
            r -= alpha * Ad
            assert x.dtype == dt and r.dtype == dt
            rel, inf = met(r)
            hist.append((rel, inf))
            if done(rel, inf):
                iters = k
                break
            z = M(r)
            rz_new = np.sum(r * z)
            d = z + (rz_new / rz) * d
            rz = rz_new
    # true residual in float64 from the returned x (detects recursive-residual drift)
    if isinstance(L, VarLevel):
        L64 = VarLevel(L.t, L.e, getattr(L, "extra64", None), np.float64)
    else:
        L64 = Level(L.t, float(L.scale), np.float64)
    rt = np.where(L64.F, b.astype(np.float64) - L64.A(x.astype(np.float64)), 0.0)
    b64n = np.linalg.norm(b.astype(np.float64))
    true_rel = float(np.linalg.norm(rt) / b64n) if b64n > 0 else 0.0
    return {"iters": iters, "ran": k, "hist": hist, "x": x,
            "true_rel2": true_rel, "true_inf": float(np.abs(rt).max())}


def jacobi(L):
    return lambda r: np.where(L.F, r / L.diag, L.dtype(0))


# ---------------------------------------------------------------- RHS builders
def hydrostatic_rhs(t, F):
    """r1: +1 on fluid cells with SOLID below, -1 with SOLID above (b = -div, unit v*)."""
    below = (nb(t, (0, -1, 0)) == SOLID) & F
    above = (nb(t, (0, 1, 0)) == SOLID) & F
    d = np.zeros(F.shape)
    d[below] += 1.0
    d[above] -= 1.0
    return np.where(F, d, 0.0)


def var_coefficients(n, t, F):
    """Variable-coefficient TEST LOAD (not physics): nominal a_f = exp(U(-1, 1)) per face
    (contrast up to e^2 = 7.4) on every face, and an extra diagonal U(0, 2) on FLUID cells next to
    AIR (the shape of Bridson's ghost-fluid term a_f (1-theta)/theta). All rounded to float32 so
    numpy and the GPU use bit-identical inputs. Seed default_rng(21)."""
    rng = np.random.default_rng(21)
    e = [np.exp(rng.uniform(-1.0, 1.0, (n + 2,) * 3)).astype(np.float32).astype(np.float64) for _ in range(3)]
    airnb = np.zeros((n, n, n), bool)
    for s in SHIFTS:
        airnb |= (nb(t, s) == AIR)
    extra = np.where(F & airnb, rng.uniform(0.0, 2.0, (n, n, n)), 0.0).astype(np.float32).astype(np.float64)
    return e, extra


def build_cases(n, need_x0=True):
    """Every problem as float64 arrays on the interior (n,n,n). RNG draw orders replicate the
    scripts the counts were first published by. Warm cases carry x0 (numpy f64 solution)."""
    cases = []
    doms = {}

    def dom(kind):
        if kind not in doms:
            t = make_domain(n, kind)
            doms[kind] = (t, t[1:-1, 1:-1, 1:-1] == FLUID)
        return doms[kind]

    def solve64(kind, b, tol, maxit):
        t, F = dom(kind)
        L = Level(t, 1.0, np.float64)
        res = pcg(L, b, MG(t, np.float64), "inf", tol, maxit=maxit)
        assert res["iters"] is not None, f"x0 solve did not reach {tol}"
        return res["x"]

    X, Y, Z = np.meshgrid(np.arange(n), np.arange(n), np.arange(n), indexing="ij")

    # --- parity (r1). Fresh default_rng(1) per case = one-case invocations of poisson_bench.py
    for kind in ("tank_half", "dam_break", "tank_shallow", "tank_half_ball", "tank_half_step"):
        t, F = dom(kind)
        src = "r1" if kind in ("tank_half", "dam_break", "tank_shallow") else "lane (reviewer coarse_rule.py geometry)"
        cases.append(dict(name=f"parity/{kind}/hydrostatic", domain=kind, criterion="rel2", tol=1e-4, solve="parity",
                          b=hydrostatic_rhs(t, F), source=src, note="unit hydrostatic RHS"))
        rng = np.random.default_rng(1)
        cases.append(dict(name=f"parity/{kind}/random", domain=kind, criterion="rel2", tol=1e-4, solve="parity",
                          b=np.where(F, rng.standard_normal((n, n, n)), 0.0), source=src, note="random RHS default_rng(1)"))
    # variable coefficients + extra diagonal (code-path test load)
    t, F = dom("tank_half_ball")
    rng = np.random.default_rng(1)
    cases.append(dict(name="parity/var/tank_half_ball/random", domain="tank_half_ball", criterion="rel2", tol=1e-4,
                      solve="parity", b=np.where(F, rng.standard_normal((n, n, n)), 0.0), fcoef="var_ball",
                      source="lane", note="nominal a_f = exp(U(-1,1)), extraDiag U(0,2) next to AIR (test load)"))

    # --- perfcritic infnorm_iters.py (box 3.63 m), one rng for both domains, in order
    dx = BOX_L / n
    rng = np.random.default_rng(7)
    for kind in ("dam_break", "tank_half"):
        t, F = dom(kind)
        below = (nb(t, (0, -1, 0)) == SOLID) & F
        dt = 1 / 120
        b_grav = np.where(below, G * dt / dx, 0.0)
        if kind == "dam_break":
            x_front = 3 * n // 8
            patch = below & (X >= x_front - n // 8)
            v_imp = 2 * math.sqrt(G * (3 * n // 4) * dx)            # Ritter bound 2 sqrt(g h0) [DERIVED there]
        else:
            c = n // 2
            w = max(2, 3 * n // 32)
            patch = below & (abs(X - c) < w) & (abs(Z - c) < w)
            v_imp = math.sqrt(2 * G * BOX_L / 2)                     # drop from half box height [DERIVED there]
        b_imp = np.where(patch, v_imp / dx, 0.0)
        sig = 0.1 * 5.0 / dx                                         # ASSUMED there: 10% noise at 5 m/s
        b_noise = np.where(F, rng.standard_normal((n, n, n)) * sig, 0.0)
        pre = f"pub/perfcritic/{kind}"
        common = dict(domain=kind, criterion="inf", tol=1e-2, solve="p", source="perfcritic/infnorm_iters.py")
        cases.append(dict(name=f"{pre}/gravity_only", b=b_grav, note="b = g dt/dx on floor cells, dt = 1/120 s", **common))
        cases.append(dict(name=f"{pre}/impact_only", b=b_imp, note=f"impact strip v = {v_imp:.3f} m/s", **common))
        cases.append(dict(name=f"{pre}/noise_only", b=b_noise, note=f"N(0, {sig:.2f} s^-1) noise (ASSUMED sigma)", **common))
        b = b_grav + b_imp + b_noise
        cases.append(dict(name=f"{pre}/gravity+impact+noise", b=b, note="sum", **common))
        xs = solve64(kind, b, 1e-6, 60) if need_x0 else None
        bp = b * (1 + 0.01 * rng.standard_normal((n, n, n)))
        cases.append(dict(name=f"{pre}/warm_same_rhs_1pct", b=bp, x0=xs, x0_note="x0 = f64 solve of gravity+impact+noise to inf 1e-6",
                          note="RHS x (1 + 0.01 N(0,1))", **common))
        b_new_noise = np.where(F, rng.standard_normal((n, n, n)) * sig, 0.0)
        cases.append(dict(name=f"{pre}/warm_fresh_noise", b=b_grav + b_imp + b_new_noise, x0=xs,
                          x0_note="x0 = f64 solve of gravity+impact+noise to inf 1e-6", note="new noise realisation", **common))
        xg = solve64(kind, b_grav, 1e-6, 60) if need_x0 else None
        cases.append(dict(name=f"{pre}/warm_impact_appears", b=b, x0=xg, x0_note="x0 = f64 solve of gravity_only to inf 1e-6",
                          note="previous step gravity only", **common))
        f_noise = np.where(F, rng.standard_normal((n, n, n)) * 0.05, 0.0)   # ASSUMED there: 5% noise
        air_nb = np.zeros((n, n, n), bool)
        for s in SHIFTS:
            air_nb |= (nb(t, s) == AIR)
        f = 1 + f_noise + np.where(patch, 0.5, 0.0)
        f = np.clip(f, 0.5, 1.5)
        f = np.where(F & air_nb, np.maximum(f, 1.0), f)
        cpsi = dict(domain=kind, criterion="inf", tol=1e-3, solve="psi", source="perfcritic/infnorm_iters.py")
        cases.append(dict(name=f"{pre}/density_noise5pct+impact0.5", b=np.where(F, f - 1, 0.0),
                          note="f = clip(1 + 0.05 N + 0.5 on impact strip, 0.5, 1.5), >= 1 next to air", **cpsi))
        cases.append(dict(name=f"{pre}/density_noise5pct",
                          b=np.where(F, np.where(F & air_nb, np.maximum(1 + f_noise, 1), 1 + f_noise) - 1, 0.0),
                          note="f = 1 + 0.05 N (no clip), >= 1 next to air", **cpsi))

    # --- reviewB tol_bench.py (dx = 3.2/n)
    dxb = BOX_L_REVIEWB / n
    t, F = dom("dam_break")
    for dt in (0.0058, 0.0075, 1 / 60):
        cases.append(dict(name=f"pub/reviewB/dam_break/gravity_dt{dt*1e3:.1f}ms", domain="dam_break", criterion="inf", tol=1e-2,
                          solve="p", b=hydrostatic_rhs(t, F) * G * dt / dxb, source="reviewB/tol_bench.py",
                          note=f"b = g dt/dx on floor cells, dt = {dt*1e3:.2f} ms, dx = 3.2/n"))
    tw, Fw = dom("wedge")
    wall = Fw & (X == n - 1)
    floor = Fw & (Y == 0)
    for u in (3.0, 6.0):
        dt = dxb / (u + math.sqrt(dxb * G))
        b = np.zeros((n, n, n))
        b[wall] += u / dxb
        b[floor] += G * dt / dxb
        name = f"pub/reviewB/wedge/impact_u{u:.0f}"
        cases.append(dict(name=name, domain="wedge", criterion="inf", tol=1e-2, solve="p", b=b, source="reviewB/tol_bench.py",
                          note=f"wall u = {u} m/s, floor g dt/dx, dt = {dt*1e3:.3f} ms, dx = 3.2/n"))
        x_prev = solve64("wedge", b, 1e-4, 100) if need_x0 else None
        rng = np.random.default_rng(3)
        b2 = b * (1 + 0.1 * rng.standard_normal(b.shape))
        cases.append(dict(name=name + "_warm10pct", domain="wedge", criterion="inf", tol=1e-2, solve="p", b=b2, x0=x_prev,
                          x0_note="x0 = f64 solve of the cold case to inf 1e-4 (where tol_bench's loop stops)",
                          source="reviewB/tol_bench.py", note="RHS x (1 + 0.1 N(0,1)), default_rng(3)"))
    rng = np.random.default_rng(5)
    airnb = np.zeros((n, n, n), bool)
    for s in SHIFTS:
        airnb |= (nb(tw, s) == AIR)
    for amp in (0.01, 0.1):
        ph = 1 + amp * rng.standard_normal((n, n, n))
        ph = np.clip(ph, 0.5, 1.5)
        ph = np.where(airnb, np.maximum(ph, 1.0), ph)
        cases.append(dict(name=f"pub/reviewB/wedge/density_random_{amp:g}", domain="wedge", criterion="inf", tol=1e-3, solve="psi",
                          b=np.where(Fw, ph - 1.0, 0.0), source="reviewB/tol_bench.py",
                          note=f"f* = clip(1 + {amp} N(0,1), 0.5, 1.5), f* >= 1 next to air"))
    hgt = (0.45 * n - 0.33 * n * X / n).astype(int)
    ph = 1 + 0.02 * (hgt - Y) / np.maximum(hgt, 1)
    cases.append(dict(name="pub/reviewB/wedge/density_smooth_2pct", domain="wedge", criterion="inf", tol=1e-3, solve="psi",
                      b=np.where(Fw, ph - 1.0, 0.0), source="reviewB/tol_bench.py", note="2% compression growing with depth"))

    # --- lane production additions (box 3.63 m)
    t, F = dom("dam_break")
    below = (nb(t, (0, -1, 0)) == SOLID) & F
    for nsub in (3, 1):                         # T/2 = pub/perfcritic/dam_break/gravity_only
        dt = 1.0 / 60.0 / nsub
        cases.append(dict(name=f"prod/p/dam_break/gravity_dt{dt*1e3:.2f}ms", domain="dam_break", criterion="inf", tol=1e-2,
                          solve="p", b=np.where(below, G * dt / dx, 0.0), source="lane",
                          note=f"b = g dt/dx on floor cells, dt = 1/{60*nsub} s [DERIVED]"))
    for kind in ("tank_half_ball", "tank_half_step"):
        t, F = dom(kind)
        cases.append(dict(name=f"prod/p/{kind}/gravity_dt8.33ms", domain=kind, criterion="inf", tol=1e-2, solve="p",
                          b=hydrostatic_rhs(t, F) * G * (1 / 120) / dx, source="lane",
                          note="still pool with an interior solid, one gravity step: b = +-g dt/dx at solid below/above [DERIVED]"))
    return cases, doms


# ---------------------------------------------------------------- expected published counts
# r1 poisson_bench_n64_<kind>_<rhs>.json {rel2 tol: iters}; perfcritic infnorm_iters_n64.json
# (inf 1e-2 for velocity, 1e-3 for density); reviewB tol64.json iters_to_abs {inf tol: iters}.
PORT_EXPECT = {
    64: {
        "parity/tank_half/hydrostatic": {"mgpcg": {1e-2: 10, 1e-4: 14, 1e-6: 19}, "jpcg": {1e-2: 85, 1e-4: 143, 1e-6: 173}},
        "parity/tank_half/random": {"mgpcg": {1e-2: 7, 1e-4: 15, 1e-6: 22}, "jpcg": {1e-2: 92, 1e-4: 213, 1e-6: 275}},
        "parity/dam_break/hydrostatic": {"mgpcg": {1e-2: 9, 1e-4: 13, 1e-6: 18}, "jpcg": {1e-2: 97, 1e-4: 141, 1e-6: 201}},
        "parity/dam_break/random": {"mgpcg": {1e-2: 6, 1e-4: 12, 1e-6: 18}, "jpcg": {1e-2: 69, 1e-4: 156, 1e-6: 223}},
        "parity/tank_shallow/hydrostatic": {"mgpcg": {1e-2: 8, 1e-4: 12, 1e-6: 17}, "jpcg": {1e-2: 57, 1e-4: 95, 1e-6: 131}},
        "parity/tank_shallow/random": {"mgpcg": {1e-2: 5, 1e-4: 12, 1e-6: 17}, "jpcg": {1e-2: 52, 1e-4: 128, 1e-6: 199}},
        "pub/perfcritic/dam_break/gravity_only": {"inf": {1e-2: 9}},
        "pub/perfcritic/dam_break/impact_only": {"inf": {1e-2: 14}},
        "pub/perfcritic/dam_break/noise_only": {"inf": {1e-2: 11}},
        "pub/perfcritic/dam_break/gravity+impact+noise": {"inf": {1e-2: 13}},
        "pub/perfcritic/dam_break/warm_same_rhs_1pct": {"inf": {1e-2: 7}},
        "pub/perfcritic/dam_break/warm_fresh_noise": {"inf": {1e-2: 12}},
        "pub/perfcritic/dam_break/warm_impact_appears": {"inf": {1e-2: 13}},
        "pub/perfcritic/dam_break/density_noise5pct+impact0.5": {"inf": {1e-3: 10}},
        "pub/perfcritic/dam_break/density_noise5pct": {"inf": {1e-3: 7}},
        "pub/perfcritic/tank_half/gravity_only": {"inf": {1e-2: 11}},
        "pub/perfcritic/tank_half/impact_only": {"inf": {1e-2: 15}},
        "pub/perfcritic/tank_half/noise_only": {"inf": {1e-2: 14}},
        "pub/perfcritic/tank_half/gravity+impact+noise": {"inf": {1e-2: 15}},
        "pub/perfcritic/tank_half/warm_same_rhs_1pct": {"inf": {1e-2: 8}},
        "pub/perfcritic/tank_half/warm_fresh_noise": {"inf": {1e-2: 15}},
        "pub/perfcritic/tank_half/warm_impact_appears": {"inf": {1e-2: 15}},
        "pub/perfcritic/tank_half/density_noise5pct+impact0.5": {"inf": {1e-3: 11}},
        "pub/perfcritic/tank_half/density_noise5pct": {"inf": {1e-3: 9}},
        "pub/reviewB/dam_break/gravity_dt5.8ms": {"inf": {1e-1: 7, 1e-2: 9, 1e-3: 11, 1e-4: 14}},
        "pub/reviewB/dam_break/gravity_dt7.5ms": {"inf": {1e-1: 7, 1e-2: 9, 1e-3: 12, 1e-4: 14}},
        "pub/reviewB/dam_break/gravity_dt16.7ms": {"inf": {1e-1: 8, 1e-2: 10, 1e-3: 13, 1e-4: 15}},
        "pub/reviewB/wedge/impact_u3": {"inf": {1e-1: 11, 1e-2: 13, 1e-3: 16, 1e-4: 18}},
        "pub/reviewB/wedge/impact_u3_warm10pct": {"inf": {1e-1: 5, 1e-2: 7, 1e-3: 10, 1e-4: 13}},
        "pub/reviewB/wedge/impact_u6": {"inf": {1e-1: 12, 1e-2: 14, 1e-3: 17, 1e-4: 19}},
        "pub/reviewB/wedge/impact_u6_warm10pct": {"inf": {1e-1: 5, 1e-2: 7, 1e-3: 10, 1e-4: 13}},
        "pub/reviewB/wedge/density_random_0.01": {"inf": {1e-1: 0, 1e-2: 1, 1e-3: 5, 1e-4: 8}},
        "pub/reviewB/wedge/density_random_0.1": {"inf": {1e-1: 1, 1e-2: 5, 1e-3: 8, 1e-4: 11}},
        "pub/reviewB/wedge/density_smooth_2pct": {"inf": {1e-1: 0, 1e-2: 7, 1e-3: 10, 1e-4: 13}},
    }
}


def first_hit(hist, criterion, tol):
    for k, (rel, inf) in enumerate(hist):
        if (rel if criterion == "rel2" else inf) <= tol:
            return k
    return None


def check_port(n):
    cases, doms = build_cases(n)
    exp = PORT_EXPECT.get(n, {})
    bad = 0
    seen = 0
    for c in cases:
        if c["name"] not in exp:
            continue
        seen += 1
        t, F = doms[c["domain"]]
        L = Level(t, 1.0, np.float64)
        e = exp[c["name"]]
        M = MG(t, np.float64)
        if "mgpcg" in e:
            res = pcg(L, c["b"], M, "rel2", 1e-6, maxit=200)
            got = {tg: first_hit(res["hist"], "rel2", tg) for tg in e["mgpcg"]}
            resj = pcg(L, c["b"], jacobi(L), "rel2", 1e-6, maxit=3000)
            gotj = {tg: first_hit(resj["hist"], "rel2", tg) for tg in e["jpcg"]}
            ok = got == e["mgpcg"] and gotj == e["jpcg"]
            print(f"{'OK ' if ok else 'BAD'} {c['name']}: mgpcg {got} (r1 {e['mgpcg']})  jpcg {gotj} (r1 {e['jpcg']})")
        else:
            want = e["inf"]
            res = pcg(L, c["b"], M, "inf", min(want), x0=c.get("x0"), maxit=200)
            got = {tg: first_hit(res["hist"], "inf", tg) for tg in want}
            ok = got == want
            print(f"{'OK ' if ok else 'BAD'} {c['name']}: mgpcg inf {got} (published {want})")
        bad += 0 if ok else 1
    missing = [k for k in exp if k not in {c['name'] for c in cases}]
    if missing:
        print("MISSING cases for published counts:", missing)
        bad += len(missing)
    # the GPU coarse rule (nominal-mean faces) must reduce to McAdams for a uniform coefficient
    rng = np.random.default_rng(12)
    for kind in ("tank_half_ball", "tank_half_step", "dam_break"):
        t, F = doms[kind]
        r = np.where(F, rng.standard_normal((n, n, n)), 0.0)
        for a in (1.0, 0.37):
            z_ref = MG(t, np.float64)(r) / a
            z_var = VarMG(t, uniform_faces(n, a), None, np.float64)(r)
            d = float(np.abs(z_var - z_ref).max() / np.abs(z_ref).max())
            ok = d <= 1e-12
            print(f"{'OK ' if ok else 'BAD'} VarMG(uniform a={a}) vs McAdams MG on {kind}: rel diff {d:.1e}")
            bad += 0 if ok else 1
    print(f"PORT CHECK {'PASS' if bad == 0 else f'FAIL ({bad} mismatches)'} ({seen} published cases)")
    return bad == 0


# ---------------------------------------------------------------- fixture export
def pad_interior(a, n, dtype):
    p = np.zeros((n + 2,) * 3, dtype=dtype)
    p[1:-1, 1:-1, 1:-1] = a
    return p


def write_xfast(path, arr_padded, dtype):
    """Padded array [i,j,k] -> file with x (i) fastest: idx = i + P*(j + P*k)."""
    arr_padded.astype(dtype).ravel(order="F").tofile(path)


def write_vec4(path, comps):
    """Four padded [i,j,k] arrays -> float32 vec4 per cell, component fastest, then x, y, z."""
    np.stack(comps, axis=-1).astype(np.float32).transpose(2, 1, 0, 3).ravel().tofile(path)


def generate(n, out_root, methods=("mgpcg", "jpcg"), dtypes=("f64", "f32")):
    out = os.path.join(out_root, f"n{n}")
    os.makedirs(out, exist_ok=True)
    cases, doms = build_cases(n)
    manifest = {
        "generator": "bench/offline/poisson_ref.py",
        "n": n, "padded": n + 2, "layout": "x-fastest padded: idx = i + P*(j + P*k), P = n + 2; j is up",
        "labels": {"AIR": AIR, "FLUID": FLUID, "SOLID": SOLID},
        "box_L_m": BOX_L, "dx_m": BOX_L / n, "g_mps2": G,
        "mg": {"levels": None, "nu_pre": 2, "nu_post": 2, "omega": "2/3", "coarse_sweeps": 60,
               "coarse_operator": "McAdams rediscretisation (open iff both coarse cells non-SOLID), nominal a_f averaged (1/4 mean)"},
        "numpy": np.__version__, "domains": {}, "fcoef": {}, "cases": [], "unit": [],
    }
    for kind, (t, F) in doms.items():
        fn = f"labels_{kind}.u8"
        write_xfast(os.path.join(out, fn), t, np.uint8)
        manifest["domains"][kind] = {"file": fn, "fluid_cells": int(F.sum())}
    manifest["mg"]["levels"] = len(MG(doms["dam_break"][0], np.float64).levels)

    # variable-coefficient field(s)
    fco = {}
    t, F = doms["tank_half_ball"]
    e, extra = var_coefficients(n, t, F)
    fco["var_ball"] = (e, extra)
    write_vec4(os.path.join(out, "fcoef_var_ball.f32"), [e[0], e[1], e[2], pad_interior(extra, n, np.float64)])
    manifest["fcoef"]["var_ball"] = {"file": "fcoef_var_ball.f32", "domain": "tank_half_ball",
                                     "note": "nominal a_f = exp(U(-1,1)) on every face, extraDiag U(0,2) on FLUID next to AIR, default_rng(21), f32"}

    def ops(kind, fc, dt):
        t, _ = doms[kind]
        if fc is None:
            return Level(t, 1.0, dt), MG(t, dt)
        e, extra = fco[fc]
        L = VarLevel(t, e, extra, dt)
        L.extra64 = extra
        return L, VarMG(t, e, extra, dt)

    # unit fixtures: A.x and one V-cycle M.r (f64 and f32 numpy) per (domain, coefficient field)
    xf_all = {}
    for kind, fc in (("dam_break", None), ("tank_half_ball", None), ("tank_half_step", None), ("tank_half_ball", "var_ball")):
        t, F = doms[kind]
        xf = np.where(F, np.random.default_rng(11).standard_normal((n, n, n)), 0.0)
        rf = np.where(F, np.random.default_rng(12).standard_normal((n, n, n)), 0.0)
        tag0 = f"{kind}{'_' + fc if fc else ''}"
        u = {"name": tag0, "domain": kind, "fcoef": fc}
        for tag, dt in (("f64", np.float64), ("f32", np.float32)):
            L, M = ops(kind, fc, dt)
            ax = L.A(xf.astype(dt))
            mr = M(rf.astype(dt))
            for what, arr in (("Ax", ax), ("Mr", mr)):
                fn = f"unit_{tag0}_{what}_{tag}.f32"
                write_xfast(os.path.join(out, fn), pad_interior(arr, n, np.float64), np.float32)
                u[f"{what}_{tag}"] = fn
        for what, arr in (("x", xf), ("r", rf)):
            fn = f"unit_{tag0}_{what}.f32"
            write_xfast(os.path.join(out, fn), pad_interior(arr, n, np.float64), np.float32)
            u[what] = fn
        manifest["unit"].append(u)
        xf_all[tag0] = xf

    for c in cases:
        t0 = time.time()
        t, F = doms[c["domain"]]
        safe = c["name"].replace("/", "__").replace("+", "_")
        fn = f"rhs_{safe}.f32"
        write_xfast(os.path.join(out, fn), pad_interior(c["b"], n, np.float64), np.float32)
        entry = {k: c[k] for k in ("name", "domain", "criterion", "tol", "note", "solve", "source", "x0_note") if k in c}
        entry["rhs"] = fn
        entry["binf"] = float(np.abs(c["b"]).max())
        entry["b2"] = float(np.linalg.norm(c["b"]))
        if c.get("fcoef"):
            entry["fcoef"] = c["fcoef"]
        x0 = c.get("x0")
        if x0 is not None:
            x0fn = f"x0_{safe}.f32"
            write_xfast(os.path.join(out, x0fn), pad_interior(x0, n, np.float64), np.float32)
            entry["x0"] = x0fn
        entry["numpy"] = {}
        for tag in dtypes:
            dt = np.float64 if tag == "f64" else np.float32
            L, Mmg = ops(c["domain"], c.get("fcoef"), dt)
            b = c["b"].astype(dt)
            # f64 starts from the exact f64 x0 (published-script parity); f32 from x0 rounded to f32,
            # the same numbers the GPU uploads
            x0d = None if x0 is None else (x0 if tag == "f64" else x0.astype(np.float32))
            for meth in methods:
                M = Mmg if meth == "mgpcg" else jacobi(L)
                res = pcg(L, b, M, c["criterion"], c["tol"], x0=x0d, maxit=200 if meth == "mgpcg" else 4000)
                entry["numpy"].setdefault(tag, {})[meth] = {
                    "iters": res["iters"], "ran": res["ran"],
                    "true_rel2": res["true_rel2"], "true_inf": res["true_inf"],
                    "hist_rel2": [h[0] for h in res["hist"]], "hist_inf": [h[1] for h in res["hist"]],
                }
        manifest["cases"].append(entry)
        summ = "  ".join(f"{tg}:{m}={entry['numpy'][tg][m]['iters']}" for tg in dtypes for m in methods)
        print(f"n{n} {c['name']:<52} binf={entry['binf']:.4g}  {summ}  ({time.time()-t0:.1f}s)", flush=True)
    with open(os.path.join(out, "manifest.json"), "w") as fh:
        json.dump(manifest, fh, indent=1)
    print(f"wrote {out}/manifest.json with {len(manifest['cases'])} cases, {len(manifest['unit'])} unit fixtures")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--n", type=int, default=64)
    ap.add_argument("--out", default=os.path.join(os.path.dirname(__file__), "..", "..", "bench-results", "gate0", "fixtures"))
    ap.add_argument("--check-port", action="store_true")
    a = ap.parse_args()
    if a.check_port:
        sys.exit(0 if check_port(a.n) else 1)
    generate(a.n, os.path.abspath(a.out))


if __name__ == "__main__":
    main()
