import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  // electron-store v10 is ESM-only.  Bundling it keeps the CommonJS Electron
  // main entry from trying to require() an ESM package at startup.
  main: { plugins: [externalizeDepsPlugin({ exclude: ['electron-store'] })] },
  preload: { plugins: [externalizeDepsPlugin()] },
  renderer: {
    plugins: [vue()],
    // hatch-pet packages live at resources/pets/<id>/{pet.json,spritesheet.webp}
    publicDir: resolve('resources')
  }
})
