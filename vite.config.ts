import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    fs: {
      // Allow imports from the repo root (structure.md is one level up from src/)
      allow: ['..'],
    },
  },
})
