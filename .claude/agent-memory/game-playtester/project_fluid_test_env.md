---
name: Fluid Test Environment — WebGPU Playwright Limitation
description: Headless Playwright cannot run WebGPU — fluid sim always shows black canvas with INITIALIZING GPU. Visual tests require a real browser session with GPU access.
type: project
---

Playwright (headless Chromium) does not expose `navigator.gpu`, so the WebGPU-dependent fluid sim (MLS-MPM + SSFR) never initializes. All buttons (+10K, +50K, DROP BALL, materials) are gated behind `gpuReady` state and remain disabled. Every screenshot shows a black canvas, FPS: 0, N: 0.

**Why:** The app calls `if (!navigator.gpu) return` at setup time. Headless Chromium even with `--enable-unsafe-webgpu` flags returns `No available adapters` and falls back to WebGL2, but Three.js WebGPU renderer still fails to extract a `GPUDevice` from the backend.

**How to apply:** For visual verification of fluid rendering, SSFR compositing, ball depth ordering, or FPS at high particle counts — use a real Chromium browser on the user's machine (Windows 11 with discrete GPU). Playwright is only useful for checking: navigation/routing, UI element presence, console error capture, and non-WebGPU pages. Screenshots from playtest sessions in this environment will always be blank for the fluid test specifically.

The prior console-warnings.log (5174 port) shows 190 `[Buffer (unlabeled)] used in submit while destroyed` WebGPU warnings — this is a different known bug (dummy textures created per-frame rather than once) that was subsequently fixed by creating them in init() as persistent resources.
