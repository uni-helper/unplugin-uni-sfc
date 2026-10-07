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
    // lib 模式默认关闭 cssCodeSplit（构建结束时才从入口收集合并 CSS，收集不到被插件
    // 换成 .vue 资产的那段 chunk 链）；打开后每个样式 chunk 的 CSS 资产在渲染阶段就产出，
    // 插件能把 .vue 里的样式 import 回填成 CSS 资产的路径
    cssCodeSplit: true,
    outDir: 'dist',
    rollupOptions: {
      // 哪些依赖保持 external 由打包工具的配置决定，插件不再自己判断
      external: ['vue'],
      // preserveModules 由插件自动打开；产物路径基准完全由打包工具决定，插件不做配置
    },
  },
})
