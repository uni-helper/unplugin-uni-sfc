import type { Plugin as VitePlugin } from 'vite'
import type { Options } from './types'
import { createVitePlugin } from 'unplugin'
import { unpluginFactory } from '.'

const vitePlugin = createVitePlugin(unpluginFactory)

/**
 * 只接管构建产物：dev server 下的 .vue 交给其它插件（如 @vitejs/plugin-vue）处理，
 * 本插件在 dev 下既不输出 .vue 资产，也不改写引用。
 */
export default function unpluginVite(options?: Options): VitePlugin {
  // unplugin 的类型把单个插件与插件数组合在一起，这里只有一个插件
  const plugin = vitePlugin(options) as VitePlugin
  return { ...plugin, apply: 'build' }
}
