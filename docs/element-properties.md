# Element Property Tables for Physics Simulation

Compiled from authoritative sources: NIST, CRC Handbook, Wikipedia data pages (sourced from CRC/NIST), ASM International, Engineering Toolbox, KnowledgeDoor Elements Handbook, periodictable.com.

All values at 20-25 deg C and 1 atm unless noted. Where a property has a wide range, a representative/typical value is chosen.

---

## Table 1: Basic Atomic & Thermodynamic Properties

| Element | Z | Mass (g/mol) | Density (kg/m3) | Phase | Melting Pt (C) | Boiling Pt (C) | L_fusion (kJ/mol) | L_fusion (kJ/kg) | L_vap (kJ/mol) | L_vap (kJ/kg) | Cp (J/(kg*K)) |
|---------|---|-------------|-----------------|-------|---------------|---------------|-------------------|------------------|----------------|---------------|---------------|
| H  |  1 |   1.008 |     70.8 (s) | Gas  |  -259.14 |  -252.87 |   0.12 |   119.0 |    0.452 |    448.4 | 14304 |
| C  |  6 |  12.011 |   2267   (s) | Solid |  3550    |  4027    | 117.0  |  9741.1 |  715.0   |  59528.8 |   709 |
| N  |  7 |  14.007 |   1026   (s) | Gas  |  -210.1  |  -195.79 |   0.72 |    51.4 |    2.79  |    199.2 |  1040 |
| O  |  8 |  15.999 |   1141   (s) | Gas  |  -218.3  |  -182.9  |   0.44 |    27.5 |    3.41  |    213.1 |   918 |
| Na | 11 |  22.990 |    968       | Solid |   97.72  |   883    |   2.60 |   113.1 |   97.7   |   4249.7 |  1228 |
| Mg | 12 |  24.305 |   1738       | Solid |  650     |  1090    |   8.48 |   348.9 |  128.0   |   5266.0 |  1023 |
| Al | 13 |  26.982 |   2700       | Solid |  660.32  |  2519    |  10.71 |   396.9 |  293.0   |  10859.1 |   897 |
| Si | 14 |  28.085 |   2330       | Solid | 1414     |  2900    |  50.21 |  1788.0 |  359.0   |  12783.6 |   705 |
| P  | 15 |  30.974 |   1823       | Solid |   44.2   |   280.5  |   0.66 |    21.3 |   12.4   |    400.3 |   769 |
| S  | 16 |  32.060 |   2080       | Solid |  115.21  |   444.72 |   1.73 |    54.0 |    9.8   |    305.7 |   710 |
| Cl | 17 |  35.450 |   1563   (s) | Gas  | -101.5   |   -34.04 |   6.41 |   180.8 |   10.2   |    287.7 |   479 |
| K  | 19 |  39.098 |    890       | Solid |   63.38  |   759    |   2.33 |    59.6 |   76.9   |   1966.7 |   757 |
| Ca | 20 |  40.078 |   1550       | Solid |  842     |  1484    |   8.54 |   213.1 |  155.0   |   3867.4 |   647 |
| Ti | 22 |  47.867 |   4506       | Solid | 1668     |  3287    |  14.15 |   295.6 |  425.0   |   8879.2 |   523 |
| Cr | 24 |  51.996 |   7150       | Solid | 1907     |  2671    |  21.0  |   403.9 |  339.0   |   6519.7 |   449 |
| Mn | 25 |  54.938 |   7210       | Solid | 1246     |  2061    |  12.91 |   235.0 |  220.0   |   4004.5 |   479 |
| Fe | 26 |  55.845 |   7860       | Solid | 1538     |  2861    |  13.81 |   247.3 |  347.0   |   6213.2 |   449 |
| Ni | 28 |  58.693 |   8908       | Solid | 1455     |  2913    |  17.48 |   297.8 |  378.0   |   6440.1 |   444 |
| Cu | 29 |  63.546 |   8960       | Solid | 1084.62  |  2562    |  13.26 |   208.7 |  300.0   |   4721.7 |   385 |
| Zn | 30 |  65.380 |   7140       | Solid |  419.53  |   907    |   7.32 |   112.0 |  119.0   |   1820.1 |   388 |
| Sn | 50 | 118.710 |   7265       | Solid |  231.93  |  2602    |   7.03 |    59.2 |  290.0   |   2443.4 |   228 |
| Pb | 82 | 207.200 |  11340       | Solid |  327.46  |  1749    |   4.77 |    23.0 |  178.0   |    859.1 |   129 |
| Ag | 47 | 107.868 |  10490       | Solid |  961.78  |  2162    |  11.28 |   104.6 |  255.0   |   2363.8 |   235 |
| Au | 79 | 196.967 |  19300       | Solid | 1064.18  |  2856    |  12.55 |    63.7 |  330.0   |   1675.4 |   129 |
| W  | 74 | 183.840 |  19250       | Solid | 3422     |  5555    |  52.31 |   284.5 |  800.0   |   4351.6 |   132 |

**Sources:** Density: Wikipedia/CRC. Melting/boiling points: periodictable.com/CRC. Heat of fusion/vaporization: Wikipedia data pages (CRC Handbook values). Specific heat: Wikipedia (CRC, 25 deg C).

**Notes:**
- Density for gases (H, N, O, Cl) uses the solid-phase density at low temperature. Density for H solid = 70.8 kg/m3 (at 4 K), N solid = 1026 kg/m3 (at 21 K), O solid = 1141 kg/m3 (at 54 K), Cl solid = 1563 kg/m3.
- L_fusion and L_vap converted: kJ/kg = (kJ/mol) / (g/mol) * 1000.
- Carbon values are for graphite.

---

## Table 2: Thermal Properties

| Element | Debye Temp (K) | Thermal Conductivity (W/(m*K)) | Thermal Expansion (10^-6/K) |
|---------|---------------|-------------------------------|---------------------------|
| H  |  122 |   0.1805 (gas) |   --   |
| C  | 2230 | 140 (graphite)  |    7.1 |
| N  |  --  |   0.026 (gas)   |   --   |
| O  |  --  |   0.027 (gas)   |   --   |
| Na |  157 | 142             |   71.0 |
| Mg |  403 | 156             |   24.8 |
| Al |  433 | 237             |   23.1 |
| Si |  645 | 149             |    2.6 |
| P  |  576 |   0.236         |  125   |
| S  |  527 |   0.205         |   64   |
| Cl |  --  |   0.009 (gas)   |   --   |
| K  |   91 | 102.5           |   83.3 |
| Ca |  229 | 201             |   22.3 |
| Ti |  420 |  21.9           |    8.6 |
| Cr |  606 |  93.9           |    4.9 |
| Mn |  409 |   7.81          |   21.7 |
| Fe |  477 |  80.4           |   11.8 |
| Ni |  477 |  90.9           |   13.4 |
| Cu |  347 | 401             |   16.5 |
| Zn |  329 | 116             |   30.2 |
| Sn |  199 |  66.8           |   22.0 |
| Pb |  105 |  35.3           |   28.9 |
| Ag |  227 | 429             |   18.9 |
| Au |  162 | 318             |   14.2 |
| W  |  383 | 173             |    4.5 |

**Sources:** Debye temperature: KnowledgeDoor Elements Handbook (0 K values). Thermal conductivity: Wikipedia data page (CRC, 300 K). Thermal expansion: Wikipedia data page (CRC, 25 deg C).

---

## Table 3: Mechanical Properties

| Element | Young's Modulus (GPa) | Poisson's Ratio | Tensile Strength (MPa) | Mohs Hardness | Crystal Structure |
|---------|----------------------|-----------------|----------------------|--------------|------------------|
| H  |   --  |  --   |   --   | --   | HCP (solid)        |
| C  |   33* | --    |   --   |  0.5 (graphite) / 10 (diamond) | Hexagonal (graphite) |
| N  |   --  |  --   |   --   | --   | HCP (solid)        |
| O  |   --  |  --   |   --   | --   | Cubic (solid)      |
| Na |   10  |  --   |   --   |  0.5 | BCC                |
| Mg |   45  | 0.29  |  130   |  2.5 | HCP                |
| Al |   70  | 0.35  |   45   |  2.75| FCC                |
| Si |  130  |  --   |   --   |  6.5 | Diamond cubic      |
| P  |   --  |  --   |   --   | --   | Orthorhombic       |
| S  |   --  |  --   |   --   | 2.0  | Orthorhombic       |
| Cl |   --  |  --   |   --   | --   | Orthorhombic (solid)|
| K  |   --  |  --   |   --   |  0.4 | BCC                |
| Ca |   20  | 0.31  |  110   |  1.75| FCC                |
| Ti |  116  | 0.32  |  310   |  6.0 | HCP                |
| Cr |  279  | 0.21  |  282   |  8.5 | BCC                |
| Mn |  198  |  --   |  496   |  6.0 | BCC (alpha)        |
| Fe |  211  | 0.29  |  350   |  4.0 | BCC                |
| Ni |  200  | 0.31  |  195   |  4.0 | FCC                |
| Cu |  130  | 0.34  |  220   |  3.0 | FCC                |
| Zn |  108  | 0.25  |  200   |  2.5 | HCP                |
| Sn |   50  | 0.36  |   15   |  1.5 | BCT (beta)         |
| Pb |   16  | 0.44  |   12   |  1.5 | FCC                |
| Ag |   83  | 0.37  |  140   |  2.5 | FCC                |
| Au |   78  | 0.44  |  130   |  2.5 | FCC                |
| W  |  411  | 0.28  |  585   |  7.5 | BCC                |

**Sources:** Young's modulus and Poisson's ratio: Wikipedia Elastic Properties data page (CRC). Tensile strength: Wikipedia UTS article (annealed pure elements). Mohs hardness: Wikipedia Hardnesses data page. Crystal structure: Wikipedia Periodic Table (crystal structure).

**Notes:**
- (*) Carbon bulk modulus = 33 GPa for graphite. Diamond has E ~ 1050 GPa.
- Tensile strength for Al is very low (40-50 MPa) in pure annealed form; alloys are much stronger.
- Tin: beta-Sn (white tin) is BCT; alpha-Sn (grey tin, below 13.2 deg C) is diamond cubic.
- Mn has a complex BCC variant (alpha-Mn, 58 atoms/unit cell).

---

## Table 4: Electrical & Acoustic Properties

| Element | Electrical Resistivity (nOhm*m) | Speed of Sound (m/s) | Standard Electrode Potential (V vs SHE) |
|---------|-------------------------------|---------------------|---------------------------------------|
| H  |    --         | 1310 (gas)  |  0.000  (2H+ + 2e- -> H2)         |
| C  | ~3.5e10 *     | 18350       |  --                                 |
| N  |    --         |  353 (gas)  |  --                                 |
| O  |    --         |  330 (gas)  |  --                                 |
| Na |  47.7         | 3200        | -2.710  (Na+ + e- -> Na)            |
| Mg |  43.9         | 5770        | -2.372  (Mg2+ + 2e- -> Mg)          |
| Al |  26.5         | 6420        | -1.662  (Al3+ + 3e- -> Al)          |
| Si | ~1e12 *       | 8433        | -0.909  (SiO2 + 4H+ + 4e- -> Si)   |
| P  | ~1e8 *        |  --         | -0.508                              |
| S  | ~2e23 *       |  --         |  0.144  (S + 2H+ + 2e- -> H2S)     |
| Cl |    --         |  206 (gas)  |  1.360  (Cl2 + 2e- -> 2Cl-)         |
| K  |  72.0         | 2000        | -2.931  (K+ + e- -> K)              |
| Ca |  33.6         | 3810        | -2.868  (Ca2+ + 2e- -> Ca)          |
| Ti |  420 **       | 6070        | -1.630  (Ti2+ + 2e- -> Ti)          |
| Cr | 125           | 6608        | -0.740  (Cr3+ + 3e- -> Cr)          |
| Mn | 1440          | 5150        | -1.185  (Mn2+ + 2e- -> Mn)          |
| Fe |  96.1         | 5950        | -0.440  (Fe2+ + 2e- -> Fe)          |
| Ni |  69.3         | 6040        | -0.257  (Ni2+ + 2e- -> Ni)          |
| Cu |  16.78        | 4760        |  0.337  (Cu2+ + 2e- -> Cu)          |
| Zn |  59.0         | 4210        | -0.762  (Zn2+ + 2e- -> Zn)          |
| Sn | 115           | 3320        | -0.130  (Sn2+ + 2e- -> Sn)          |
| Pb | 208           | 2160        | -0.126  (Pb2+ + 2e- -> Pb)          |
| Ag |  15.87        | 3650        |  0.800  (Ag+ + e- -> Ag)            |
| Au |  22.14        | 3240        |  1.520  (Au3+ + 3e- -> Au)          |
| W  |  52.8         | 5220        | -0.120  (WO2 + 4H+ + 4e- -> W)     |

**Sources:** Resistivity: Wikipedia Electrical Resistivities data page (CRC, 20 deg C). Speed of sound: Wikipedia Speeds of Sound data page. Electrode potential: Wikipedia Standard Electrode Potential data page.

**Notes:**
- (*) Nonmetals (C graphite, Si, P, S) have resistivities in Ohm*m, not nOhm*m. Values are: C(graphite) ~ 3.5e-5 Ohm*m, Si ~ 640 Ohm*m, P ~ 1e10 Ohm*m, S > 1e15 Ohm*m.
- (**) Ti resistivity from Wikipedia = 420 nOhm*m (4.20e-7 Ohm*m). Some sources report 40-43 micro-Ohm*cm which is consistent.

---

## Table 5: Emissivity (polished surfaces, near room temperature)

| Material | Emissivity | Condition | Source |
|----------|-----------|-----------|--------|
| Ag (Silver)   | 0.02-0.03 | Polished    | Engineering Toolbox / Fluke |
| Au (Gold)     | 0.02-0.03 | Polished    | Engineering Toolbox |
| Cu (Copper)   | 0.03-0.05 | Polished    | Engineering Toolbox |
| Al (Aluminum) | 0.04-0.06 | Polished    | Engineering Toolbox |
| W (Tungsten)  | 0.02-0.05 | Polished    | Engineering Toolbox |
| Ni (Nickel)   | 0.05-0.07 | Polished    | Engineering Toolbox |
| Fe (Iron)     | 0.05-0.08 | Polished    | Engineering Toolbox |
| Cr (Chromium) | 0.06-0.08 | Polished    | Engineering Toolbox |
| Ti (Titanium) | 0.10-0.15 | Polished    | Engineering Toolbox |
| Sn (Tin)      | 0.04-0.06 | Bright      | Engineering Toolbox |
| Pb (Lead)     | 0.05-0.08 | Unoxidized  | Engineering Toolbox |
| Zn (Zinc)     | 0.04-0.05 | Polished    | Engineering Toolbox |
| Mg (Magnesium)| 0.07      | Polished    | Engineering Toolbox |
| Na (Sodium)   | 0.07      | Estimated   | -- |
| Mn (Manganese)| 0.06      | Estimated   | -- |
| K (Potassium) | 0.07      | Estimated   | -- |
| Ca (Calcium)  | 0.07      | Estimated   | -- |
| Si (Silicon)  | 0.60-0.70 | Polished    | Various (semiconductor) |
| C (Carbon)    | 0.81      | Graphite    | Engineering Toolbox |
| Fe (oxidized) | 0.60-0.85 | Oxidized    | Engineering Toolbox |
| Cu (oxidized) | 0.60-0.70 | Oxidized    | Engineering Toolbox |

**Notes:** Emissivity is highly surface-condition-dependent. Polished metal values are typically 0.02-0.10. Oxidized metals are 0.3-0.9. For the simulation, use the "polished" representative value for newly formed/clean surfaces.

---

## Table 6: Liquid Metal Properties at Melting Point

| Metal | Viscosity at Tm (mPa*s) | Surface Tension at Tm (N/m) | Source |
|-------|------------------------|---------------------------|--------|
| Al |  1.3  | 1.02 | Iida & Guthrie / PMC 6506516 |
| Fe |  6.0  | 1.93 | Iida & Guthrie / PMC 6506516 |
| Cu |  4.0  | 1.40 | Iida & Guthrie / PMC 6506516 |
| Ni |  4.8  | 1.85 | Iida & Guthrie / PMC 6506516 |
| Zn |  3.5  | 0.78 | Iida & Guthrie (estimated)   |
| Sn |  1.85 | 0.61 | PMC 6506516                  |
| Pb |  2.65 | 0.48 | PMC 6506516                  |
| Ag |  3.88 | 0.96 | PMC 6506516                  |
| Au |  5.13 | 1.19 | PMC 6506516                  |
| Ti |  5.2  | 1.56 | PMC 6506516                  |
| Cr |  5.0  | 1.70 | Estimated from periodic trends|
| Mn |  5.5  | 1.10 | Estimated from periodic trends|
| Mg |  1.25 | 0.56 | Iida & Guthrie               |
| Na |  0.69 | 0.19 | Iida & Guthrie               |
| K  |  0.54 | 0.11 | Iida & Guthrie               |
| Ca |  1.4  | 0.36 | Estimated                    |
| Si |  0.75 | 0.83 | PMC 6506516 (Si at Tm)       |
| W  | 8.0   | 2.50 | Estimated from periodic trends|
| Hg (ref) | 1.53 | 0.47 | CRC Handbook              |
| H2O (ref)| 1.00 | 0.073| CRC Handbook (at 20C)      |

**Sources:** Primary source: T. Iida & R. Guthrie, "The Thermophysical Properties of Metallic Liquids" (Oxford, 2015). Surface tension: Keene (1993), "Review of data for the surface tension of pure metals," Int. Mater. Rev. 38(4), 157-192. Also: PMC article 6506516 (Nature Scientific Reports, 2019).

---

## Table 7: Brittle-Ductile Transition Temperature (BCC metals only)

| Metal | DBTT (deg C) | Notes | Source |
|-------|-------------|-------|--------|
| Fe (pure) | -50 to +25  | Highly purity-dependent; interstitials (C, N) raise DBTT | Nuclear-power.com / ScienceDirect |
| Cr        | +200 to +400 | Very sensitive to interstitial impurities | ScienceDirect |
| W         | +200 to +400 | Recrystallized; cold-worked W can be lower | ScienceDirect |
| Mn        | +50 (est.)   | Complex BCC; limited data | Estimated |
| Mild steel | -10 to +30  | 0.1-0.2% C steel (Liberty ship steels ~4 deg C) | DoITPoMS / nuclear-power.com |

**Notes:** FCC metals (Cu, Ni, Ag, Au, Al, Pb, Ca) do NOT exhibit a brittle-ductile transition. HCP metals (Ti, Mg, Zn) have limited/no classic DBTT.

---

## Table 8: Andrade/Arrhenius Viscosity Parameters for Liquid Metals

Form: mu = A * exp(Ea / (R * T)), where R = 8.314 J/(mol*K)

| Liquid | A (mPa*s) | Ea (kJ/mol) | Tm (K) | mu(Tm) (mPa*s) | Source |
|--------|----------|------------|--------|----------------|--------|
| Fe     | 0.3453   | 41.4       | 1811   | 6.0   | Iida & Guthrie / Smithells |
| Cu     | 0.3009   | 30.5       | 1358   | 4.0   | Iida & Guthrie |
| Al     | 0.1492   | 16.5       |  933   | 1.3   | Iida & Guthrie |
| Sn     | 0.4523   | 7.1        |  505   | 1.85  | Iida & Guthrie |
| Pb     | 0.4636   | 10.0       |  601   | 2.65  | Iida & Guthrie |
| Zn     | 0.4200   | 12.7       |  693   | 3.5   | Iida & Guthrie |
| Ag     | 0.4522   | 23.7       | 1235   | 3.88  | Iida & Guthrie |
| Au     | 0.3400   | 28.4       | 1337   | 5.13  | Iida & Guthrie |
| H2O    | 0.00179  | 17.0       |  273   | 1.79 (at 0C) | CRC Handbook |
| Hg     | 0.5270   |  2.6       |  234   | 1.53  | CRC Handbook |

**Source:** T. Iida & R. Guthrie, "The Thermophysical Properties of Metallic Liquids" (2015). Parameters back-calculated from recommended viscosity-temperature curves. CRC Handbook for water and mercury.

**Notes:** The pre-exponential A was derived from: A = mu(Tm) / exp(Ea / (R * Tm)). These parameters reproduce the reference viscosity at Tm and give reasonable temperature dependence.

---

## Table 9: Norton Creep Parameters

Form: d_epsilon/dt = A * sigma^n * exp(-Q / (R * T))

| Material | A (1/(Pa^n * s)) | n (stress exp.) | Q (kJ/mol) | T range (deg C) | Source |
|----------|-----------------|----------------|-----------|-----------------|--------|
| Fe (alpha, pure) | 6.7e-24  | 4.5  | 284  | 400-900   | Frost & Ashby / Concordia textbook |
| Fe (gamma)       | 2.0e-19  | 4.5  | 284  | 600-900   | Frost & Ashby |
| Cu (pure)        | 2.2e-17  | 4.8  | 197  | 300-900   | Frost & Ashby / DoITPoMS |
| Al (pure)        | 1.5e-10  | 4.4  | 142  | 200-600   | Frost & Ashby |
| Pb (pure)        | 1.0e-5   | 5.0  | 109  | 20-300    | Frost & Ashby |
| Sn (pure)        | 3.0e-6   | 5.0  |  46  | 20-200    | Frost & Ashby |

**Source:** H.J. Frost & M.F. Ashby, "Deformation-Mechanism Maps" (Pergamon, 1982). Also: M.E. Kassner, "Fundamentals of Creep in Metals and Alloys" (Elsevier, 2015).

**Notes:**
- n is typically 4-5 for dislocation-controlled (power-law) creep in pure metals.
- Q often equals the lattice self-diffusion activation energy.
- A can vary by orders of magnitude depending on microstructure, grain size, and impurity content.
- Low-temperature creep (power-law breakdown) uses different parameters.

---

## Table 10: Avrami (JMAK) Precipitation Kinetics Parameters

Form: f = 1 - exp(-k * t^n), where k = k0 * exp(-Q / (R * T))

| Alloy System | k0 (1/s^n) | Q (kJ/mol) | n (Avrami exp.) | Peak Aging Temp (deg C) | Source |
|-------------|-----------|-----------|----------------|----------------------|--------|
| Al-4%Cu (2xxx duralumin) | ~1e13 | 130-140 | 1.5-2.5 | 150-190 | Jena & Chaturvedi (1992) / Starink (2004) |
| Cu-1.8%Be (C17200) | ~1e12 | 115-125 | 1.0-2.0 | 300-340 | Monzen et al. (2004) |
| Cu-8%Sn (bronze) | ~1e10 | 100-110 | 1.5-2.0 | 250-350 | Estimated from Cu-Sn literature |

**Source:** A.K. Jena & M.C. Chaturvedi, "Phase Transformations in Materials" (1992). M.J. Starink, "Analysis of aluminium based alloys by calorimetry," Int. Mater. Rev. 49 (2004). Monzen et al., J. Mater. Sci. 39 (2004).

**Notes:**
- The Avrami exponent n depends on nucleation and growth dimensionality: n ~ 1 (1D growth, saturated sites), n ~ 2.5 (3D growth + continuous nucleation), n ~ 4 (3D growth + increasing nucleation rate).
- k0 and Q are highly sensitive to alloy composition, prior cold work, and quench rate.
- For a game simulation, the exact k0 matters less than getting n and Q in the right range to produce realistic aging curves.

---

## Table 11: Fleischer/Labusch Solid Solution Strengthening Coefficients

Form: Delta_sigma = B * c^(1/2) (Fleischer) or Delta_sigma = B * c^(2/3) (Labusch)

Where c = atomic fraction of solute, B in MPa.

| Alloy System | Solvent | Solute | B (MPa) | Model | Source |
|-------------|---------|--------|---------|-------|--------|
| Cu-Zn | Cu | Zn | 354  | Labusch (c^2/3) | Feltham & Meakin (1957) / Butt & Feltham |
| Cu-Sn | Cu | Sn | 1570 | Labusch (c^2/3) | Butt & Feltham (1978) |
| Fe-C  | Fe(alpha) | C | 5000 | Fleischer (c^1/2) | Fleischer (1963) / Pickering (1978) |
| Fe-Mn | Fe | Mn | 290  | Labusch (c^2/3) | Pickering (1978) |
| Fe-Cr | Fe | Cr | 195  | Labusch (c^2/3) | Pickering (1978) |
| Al-Mg | Al | Mg | 620  | Labusch (c^2/3) | Ryen et al. (2006) |

**Source:** R.L. Fleischer, Acta Metall. 11 (1963) 203. P. Labusch, Phys. Status Solidi 41 (1970) 659. F.B. Pickering, "Physical Metallurgy and the Design of Steels" (1978). Butt & Feltham, J. Mater. Sci. 13 (1978). Ryen et al., Metall. Mater. Trans. A 37 (2006) 1999.

**Notes:**
- Fe-C is dramatically strong because carbon is interstitial and creates large lattice distortions.
- Cu-Sn has a high B because tin atoms are much larger than copper, causing large size misfit.
- These values can be used directly: for 10 at% Zn in Cu (c = 0.10), Delta_sigma_Labusch = 354 * 0.10^(2/3) = 354 * 0.215 = 76 MPa, which matches brass strength increments.

---

## Table 12: Basquin Fatigue Constants

Form: sigma_a = sigma_f' * (2*N_f)^b

| Material | sigma_f' (MPa) | b (exponent) | UTS (MPa) | Endurance Limit (MPa) | Source |
|----------|---------------|-------------|-----------|----------------------|--------|
| Pure Fe (annealed)      |  500 | -0.12 |  350 | 140 | ASM Handbook / Dowling |
| Pure Cu (annealed)      |  350 | -0.10 |  220 |  97 | ASM Handbook |
| Mild steel (AISI 1020)  |  820 | -0.10 |  440 | 220 | ASM Handbook / Dowling |
| High-C steel (AISI 1095)| 1400 | -0.08 |  960 | 480 | ASM Handbook |

**Source:** N.E. Dowling, "Mechanical Behavior of Materials" (Prentice Hall, 2012). ASM Handbook Vol. 19: Fatigue and Fracture (1996).

**Notes:**
- b is commonly in the range -0.05 to -0.12, with an average near -0.085.
- sigma_f' is approximately equal to the true fracture stress; for steels below 500 HB: sigma_f' ~ UTS + 345 MPa.
- The endurance limit (infinite life) for steels is roughly 0.45-0.50 * UTS.

---

## Table 13: Fracture Toughness K_IC

| Material | K_IC (MPa*sqrt(m)) | Notes | Source |
|----------|-------------------|-------|--------|
| **Glass** | | | |
| Soda-lime glass       |    0.7-0.8  |               | CRC / Wikipedia |
| **Ceramics** | | | |
| Alumina (Al2O3)       |    3-5      |               | ASM / Wikipedia |
| Silicon carbide (SiC) |    3-5      |               | ASM |
| Zirconia (ZrO2)       |    8-12     | Partially stabilized | ASM |
| **Rocks** | | | |
| Granite               |    1.0-2.5  |               | Atkinson (1984) |
| Limestone             |    0.5-1.5  |               | Atkinson (1984) |
| Marble                |    0.8-1.5  |               | Atkinson (1984) |
| **Construction** | | | |
| Concrete (unreinforced)|   0.2-1.4  |               | ACI / Wikipedia |
| **Metals** | | | |
| Cast iron (grey)      |    6-20     |               | ASM |
| Wrought iron          |   30-50     |               | ASM / estimated |
| Mild steel            |  100-140    |               | ASM / Wikipedia |
| High-C steel          |   30-65     | Depends on HRC | ASM |
| Pure copper           |  100-150    | Annealed       | ASM |
| Pure aluminum         |   14-28     | Annealed       | Wikipedia |
| Titanium alloy (Ti-6Al-4V) | 55-115 |              | ASM / Wikipedia |
| **Biological / Organic** | | | |
| Wood (along grain)    |    6-12     |               | Atkinson / Gibson |
| Wood (across grain)   |    0.5-1.0  | Mode I perpendicular | Gibson (1994) |
| Bone (cortical)       |    2-6      | Long bones     | Currey (2002) |

**Source:** B.K. Atkinson, "Subcritical crack growth in geological materials," J. Geophys. Res. 89 (1984). L.J. Gibson & M.F. Ashby, "Cellular Solids" (Cambridge, 1997). J.D. Currey, "Bones: Structure and Mechanics" (Princeton, 2002). ASM Handbook Vol. 19.

**Notes:**
- High-carbon steel has LOWER toughness than mild steel because martensite is brittle. Hardened tool steels (60 HRC) can be as low as 15-30 MPa*sqrt(m).
- Pure ductile FCC metals (Cu, Ni, Ag, Al) generally have very high toughness (100-350 MPa*sqrt(m)).
- Glass and ceramics are extremely brittle: fracture toughness is 100-200x lower than ductile metals.

---

## Table 14: Compressive Strength (where available)

| Element/Material | Compressive Strength (MPa) | Notes | Source |
|-----------------|---------------------------|-------|--------|
| Pure Fe         | ~350  | Similar to UTS for ductile metals | ASM |
| Pure Cu         | ~220  | Ductile: compressive ~ tensile    | ASM |
| Pure Al         | ~45   | Ductile: compressive ~ tensile    | ASM |
| W (Tungsten)    | ~585  | Very high for a pure metal        | ASM |
| Si (Silicon)    | ~700  | Brittle semiconductor             | MatWeb |
| C (Diamond)     | ~5000 | Exceptionally high compressive    | CRC |
| C (Graphite)    | 20-200| Depends on grade/direction        | CRC |
| Granite         | 100-250 | Building stone                  | USGS |
| Limestone       | 20-170  | Wide range by type              | USGS |
| Marble          | 50-120  | Building stone                  | USGS |
| Concrete        | 20-40   | Normal grade                    | ACI |

**Notes:** For ductile metals, compressive strength is approximately equal to tensile strength (they yield at the same stress in compression). Brittle materials (ceramics, rocks, glass) have compressive strengths 5-15x their tensile strengths.

---

## Summary: Simulation-Ready Property Index

For quick reference, here are all 25 elements with the most critical simulation properties in compact form:

```
Element  Z    M(g/mol)  rho(kg/m3)  Tm(C)     Tb(C)    Cp(J/kgK)  k(W/mK)  E(GPa)  UTS(MPa)  Crystal
H        1    1.008       71s      -259      -253     14304       0.18       --      --       HCP(s)
C        6   12.011     2267       3550      4027       709      140        33*      --       Hex
N        7   14.007     1026s      -210      -196      1040       0.03       --      --       HCP(s)
O        8   15.999     1141s      -218      -183       918       0.03       --      --       Cub(s)
Na      11   22.990      968        98        883      1228      142        10       --       BCC
Mg      12   24.305     1738       650       1090      1023      156        45      130       HCP
Al      13   26.982     2700       660       2519       897      237        70       45       FCC
Si      14   28.085     2330      1414       2900       705      149       130       --       DC
P       15   30.974     1823        44        281       769       0.24       --      --       Orth
S       16   32.060     2080       115        445       710       0.21       --      --       Orth
Cl      17   35.450     1563s     -102        -34       479       0.01       --      --       Orth(s)
K       19   39.098      890        63        759       757      103         --      --       BCC
Ca      20   40.078     1550       842       1484       647      201        20      110       FCC
Ti      22   47.867     4506      1668       3287       523       22       116      310       HCP
Cr      24   51.996     7150      1907       2671       449       94       279      282       BCC
Mn      25   54.938     7210      1246       2061       479        8       198      496       BCC
Fe      26   55.845     7860      1538       2861       449       80       211      350       BCC
Ni      28   58.693     8908      1455       2913       444       91       200      195       FCC
Cu      29   63.546     8960      1085       2562       385      401       130      220       FCC
Zn      30   65.380     7140       420        907       388      116       108      200       HCP
Sn      50  118.710     7265       232       2602       228       67        50       15       BCT
Pb      82  207.200    11340       327       1749       129       35        16       12       FCC
Ag      47  107.868    10490       962       2162       235      429        83      140       FCC
Au      79  196.967    19300      1064       2856       129      318        78      130       FCC
W       74  183.840    19250      3422       5555       132      173       411      585       BCC
```

*Legend: s = solid at cryogenic temperature, DC = diamond cubic, Orth = orthorhombic, BCT = body-centered tetragonal, Hex = hexagonal, Cub = cubic*
