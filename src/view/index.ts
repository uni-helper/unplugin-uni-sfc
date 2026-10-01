import type { SFCDescriptor } from '@vue/compiler-sfc'
import type { ModuleReference } from '../reference'
import type { Warn } from '../types'
import { compileScript, compileTemplate, parse } from '@vue/compiler-sfc'
import { collectReferences } from '../reference'

/** 只有模板的 SFC：编译出的 render 函数改成默认导出的组件 */
function compileTemplateOnly(descriptor: SFCDescriptor, filename: string): string {
  const { code } = compileTemplate({
    source: descriptor.template?.content ?? '',
    filename,
    id: filename,
  })
  return `${code.replace('export function render', 'function render')}\nexport default { render }\n`
}

/** 编译失败时退化成脚本原文，至少让依赖图里的引用还在 */
function toScriptFallback(descriptor: SFCDescriptor): string {
  return [
    descriptor.script?.content,
    descriptor.scriptSetup?.content,
    'export default {}',
  ].filter(Boolean).join('\n')
}

/** 降级后的 .vue 派生出的两份结果，都来自同一次解析 */
export interface ModuleView {
  /** 交给打包工具的 JS 模块视图 */
  code: string
  /** 源码里引用的模块，区间相对源码，供 generateBundle 回填引用（见 index.ts） */
  references: ModuleReference[]
}

/**
 * 把降级后的 .vue 编译成 JS 模块视图，交给打包工具做标准的模块解析。
 *
 * 模板会编译成 render 函数内联进 setup，模板里用到的绑定、组件、指令因此都会真实出现在 JS 里，
 * 打包工具能据此解析出完整的依赖图，也不会把只在模板里用到的导入当成未使用代码删掉。
 *
 * 视图只用于构建依赖图，它对应的 chunk 会被换回 .vue 文件（见 generateBundle）。
 * 引用和视图都需要源码的 descriptor，这里一次解析同时产出两者。
 */
export function toModuleView(code: string, filename: string, warn?: Warn): ModuleView {
  const { descriptor, errors } = parse(code, { filename })
  if (errors.length) {
    warn?.(`${filename} 解析失败，其中的引用不会被处理：${errors[0].message}`)
    return { code: 'export default {}', references: [] }
  }

  const references = collectReferences(descriptor)
  try {
    if (descriptor.script || descriptor.scriptSetup)
      return { code: compileScript(descriptor, { id: filename, inlineTemplate: true }).content, references }
    if (descriptor.template)
      return { code: compileTemplateOnly(descriptor, filename), references }
  }
  catch (error) {
    warn?.(`${filename} 编译成 JS 视图失败，改为按脚本内容解析引用：${(error as Error).message}`)
    return { code: toScriptFallback(descriptor), references }
  }
  return { code: 'export default {}', references }
}
