import { defineConfig } from 'tsdown'
import Unplugin from '../../src/rolldown'

export default defineConfig({
  plugins: [
    Unplugin(),
  ],
  entry: ['src/index.ts'],
  unbundle: false,
  devtools: true,
})
