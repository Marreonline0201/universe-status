import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: [
      // Only alias bare 'three' imports → 'three/webgpu'
      // This ensures addons (MarchingCubes, OrbitControls) that do
      // `import { Mesh } from 'three'` get the WebGPU build classes,
      // preventing dual-instance WeakMap mismatches.
      // Paths like 'three/examples/...' are NOT affected.
      { find: /^three$/, replacement: 'three/webgpu' },
    ],
  },
  server: {
    fs: {
      allow: ['..'],
    },
  },
})
