import type { SFCDescriptor } from '@vue/compiler-sfc'
import type { ConditionalAnalysis, PlatformContext } from '../conditional'
import type { ModuleReference } from '../reference'
import type { Warn } from '../types'
import { compileScript, compileTemplate, parse } from '@vue/compiler-sfc'
import { parseScript } from '../babel'
import { analyzeConditional, buildContexts, isRegionLive, project } from '../conditional'
import { collectReferences } from '../reference'

/** 指令形式：模板用 HTML 注释，script 用 JS 注释，两种都要认 */
const VIEW_FORMS = ['line', 'block', 'html'] as const

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
 * 按「活跃区域组合」给平台去重：判定结果相同的平台投影完全一样，编译一次就够。
 * 组合数通常是个位数，而不是平台数。
 */
function uniqueContexts(analysis: ConditionalAnalysis, nvue: boolean): PlatformContext[] {
  const seen = new Set<string>()
  const unique: PlatformContext[] = []
  for (const context of buildContexts(analysis, { nvue })) {
    const signature = analysis.regions.map(region => (isRegionLive(region, context.values) ? '1' : '0')).join('')
    if (seen.has(signature))
      continue
    seen.add(signature)
    unique.push(context)
  }
  return unique
}

/** 取出一段 JS 里的 import 语句原文，按内容去重 */
function collectImportStatements(code: string, tsx: boolean): string[] {
  let ast
  try {
    ast = parseScript(code, tsx, true)
  }
  catch {
    return []
  }
  const body = ast.program?.body ?? ast.body ?? []
  const statements: string[] = []
  const seen = new Set<string>()
  for (const node of body) {
    if (node.type !== 'ImportDeclaration')
      continue
    const text = code.slice(node.start, node.end)
    const key = text.replace(/\s+/g, ' ').trim()
    if (seen.has(key))
      continue
    seen.add(key)
    statements.push(text)
  }
  return statements
}

/**
 * 把其它平台变体的 import 合并进基准变体，保证依赖图覆盖每个平台用到的模块。
 *
 * 一律用副作用导入（`import './x'`）：
 * - 不同平台的同名导入可能指向不同模块（`import { login } from './a'` 与 `from './b'`），
 *   并存是重复声明，退化成副作用导入正好绕开；
 * - 视图只用于建依赖图，绑定的实际解析由基准变体负责，这里不需要引入绑定。
 */
function mergeVariantImports(base: string, variants: string[], tsx: boolean): string {
  const seenText = new Set(collectImportStatements(base, tsx).map(text => text.replace(/\s+/g, ' ').trim()))
  const extra: string[] = []
  for (const variant of variants) {
    for (const statement of collectImportStatements(variant, tsx)) {
      const key = statement.replace(/\s+/g, ' ').trim()
      if (seenText.has(key))
        continue
      seenText.add(key)
      const source = importSourceOf(statement, tsx)
      if (!source)
        continue
      extra.push(`import ${JSON.stringify(source)}`)
    }
  }
  if (!extra.length)
    return base
  // import 必须留在模块顶层，插到文件最前面
  return `${extra.join('\n')}\n${base}`
}

/** import 语句的来源模块说明符 */
function importSourceOf(statement: string, tsx: boolean): string | undefined {
  let ast
  try {
    ast = parseScript(statement, tsx, true)
  }
  catch {
    return
  }
  for (const node of ast.program?.body ?? ast.body ?? []) {
    if (node.type !== 'ImportDeclaration')
      continue
    const value = (node.source as unknown as { value?: string } | undefined)?.value
    if (typeof value === 'string')
      return value
  }
}

/**
 * 把降级后的 .vue 编译成 JS 模块视图，交给打包工具做标准的模块解析。
 *
 * 模板会编译成 render 函数内联进 setup，模板里用到的绑定、组件、指令因此都会真实出现在 JS 里，
 * 打包工具能据此解析出完整的依赖图，也不会把只在模板里用到的导入当成未使用代码删掉。
 *
 * **条件编译**：产物里的指令对每个平台含义不同，直接把整份产物丢给 Vue 会因为
 * 互斥分支的同名声明（`#ifdef H5` / `#ifndef H5` 各写一次 `const platform`）解析失败，
 * 视图退化成空模块、引用全部丢失。所以这里按「活跃区域组合」逐平台投影后各编译一次，
 * 再把各变体的 import 合并进来——依赖图必须覆盖每一个平台会用到的模块。
 *
 * 视图只用于构建依赖图，它对应的 chunk 会被换回 .vue 文件（见 generateBundle）。
 */
export function toModuleView(code: string, filename: string, warn?: Warn): ModuleView {
  const { descriptor, errors } = parse(code, { filename })
  if (errors.length) {
    warn?.(`${filename} 解析失败，其中的引用不会被处理：${errors[0].message}`)
    return { code: 'export default {}', references: [] }
  }

  const references = collectReferences(descriptor)
  const analysis = analyzeConditional(code, { forms: [...VIEW_FORMS] })
  const tsx = descriptor.script?.lang === 'tsx' || descriptor.scriptSetup?.lang === 'tsx'

  const compile = (descriptor: SFCDescriptor): string => {
    if (descriptor.script || descriptor.scriptSetup)
      return compileScript(descriptor, { id: filename, inlineTemplate: true }).content
    if (descriptor.template)
      return compileTemplateOnly(descriptor, filename)
    return 'export default {}'
  }

  try {
    // 没有条件编译时只有一种投影，走原来的单次编译
    // `.nvue` 的上下文多出 APP_NVUE / APP_PLUS_NVUE，视图的活跃组合要按它算
    const contexts = uniqueContexts(analysis, filename.endsWith('.nvue'))
    if (contexts.length <= 1)
      return { code: compile(descriptor), references }

    const variants: string[] = []
    for (const context of contexts) {
      const projected = project(code, analysis, context.values)
      const parsed = parse(projected, { filename })
      if (parsed.errors.length)
        continue
      variants.push(compile(parsed.descriptor))
    }
    if (!variants.length)
      return { code: toScriptFallback(descriptor), references }

    // 以引用最全的变体为基准，再补上其它平台独有的 import
    const base = variants.reduce((longest, current) => (current.length > longest.length ? current : longest), variants[0])
    return { code: mergeVariantImports(base, variants, tsx), references }
  }
  catch (error) {
    warn?.(`${filename} 编译成 JS 视图失败，改为按脚本内容解析引用：${(error as Error).message}`)
    return { code: toScriptFallback(descriptor), references }
  }
}
