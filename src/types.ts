export type Warn = (message: string) => void

/**
 * 插件没有可配置项。
 *
 * .vue 在产物中的位置与其 JS 模块同位（只把扩展名换回 `.vue` / `.nvue`），
 * 镜像基准完全由打包工具决定（rolldown / rollup 的 `preserveModules` 规则，tsdown `unbundle` 下的 `root`）。
 * 插件本质上是做降级处理，不拥有任何产物形态的配置。保留此类型是为了让 `UnpluginUniSfc()` 的调用形态稳定。
 */
export type Options = Record<string, never>
