import { defineConfig } from 'tsdown'
import Unplugin from '../../src/rolldown'

// 端到端验证用：unbundle 模式，不带 devtools（devtools 会挂住进程）
export default defineConfig({
  plugins: [
    Unplugin(),
  ],
  entry: ['src/index.ts'],
  unbundle: true,
})
