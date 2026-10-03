import { defineConfig } from 'vite'
import Unplugin from '../../src/vite'

export default defineConfig({
  plugins: [
    Unplugin(),
  ],
  build: {
    lib: {
      entry: 'src/index.ts',
      name: 'UnpluginUniSfc',
      formats: ['es'],
    },
    outDir: 'dist',
    rollupOptions: {
      // 哪些依赖保持 external 由打包工具的配置决定，插件不再自己判断
      external: ['vue'],
      // preserveModules 由插件自动打开；产物路径基准完全由打包工具决定，插件不做配置
    },
  },
})
