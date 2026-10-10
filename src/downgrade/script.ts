import type { BabelNode } from '../babel'
import type { ConditionalAnalysis, Region } from '../conditional'
import type { Edit } from '../shared'
import type { Warn } from '../types'
import { transformSync } from 'oxc-transform'
import {
  analyzeConditional,
  assertConditionalSupported,
  assertDirectivesPreserved,
  blankDirectives,
  buildContexts,
  directiveRanges,
  project,
  SCRIPT_DIRECTIVE_FORMS as SCRIPT_FORMS,
  uniqueContexts,
} from '../conditional'
import { applyEdits, rangesOverlap } from '../shared'
import { collectErasureEdits, findGenerativeNode, hasTsSyntax, mergeEdits, parseTs } from './erase'

export interface ScriptDowngradeOptions {
  filename: string
  /** `<script lang="tsx">` */
  tsx: boolean
  /** 报错时用来指明是哪个块 */
  label: string
  /** 是否按 `.nvue` 的上下文判定条件编译（多出 APP_NVUE / APP_PLUS_NVUE） */
  nvue?: boolean
  warn?: Warn
}

/** 需要重写区域时用的 oxc 选项，与降级 less 的策略保持一致：只删显式类型导入，保留值导入 */
const OXC_OPTIONS = {
  typescript: {
    onlyRemoveTypeImports: true,
    allowNamespaces: true,
  },
} as const

function isBlank(text: string): boolean {
  return !text.trim()
}

/**
 * 去掉 oxc 自行补上的 `export {}`。
 *
 * 一段代码里只有类型导入时，oxc 会补一个空的 `export {}` 来维持「这是模块」的语义；
 * 但 `<script setup>` 不允许出现 ES 模块导出，Vue 会直接报错。
 * 只删 oxc 新补的：源码里本来就写着的 `export {}` 原样保留。
 */
function stripInjectedEmptyExport(code: string, source: string, tsx: boolean): string {
  if (!/(?:^|\n)[ \t]*export[ \t]*\{[ \t]*\}[ \t]*;?/.test(code))
    return code

  const isEmptyExport = (node: BabelNode): boolean =>
    node.type === 'ExportNamedDeclaration' && !node.declaration && !node.source && !node.specifiers?.length

  let sourceAst: BabelNode
  try {
    sourceAst = parseTs(source, { tsx, tolerant: true })
  }
  catch {
    return code
  }
  if ((sourceAst.program?.body ?? []).some(isEmptyExport))
    return code

  let outputAst: BabelNode
  try {
    outputAst = parseTs(code, { tsx, tolerant: true })
  }
  catch {
    return code
  }
  const injected = (outputAst.program?.body ?? []).find(isEmptyExport)
  if (!injected)
    return code
  // 连同它前面的空白一起删掉，避免留下空行
  const start = code.slice(0, injected.start).replace(/[ \t]*$/, '').replace(/\n$/, '').length
  return code.slice(0, start) + code.slice(injected.end)
}

/** 用 oxc 把一段独立代码里的 TS 换成 JS；区域由指令行分隔，区域内部不含指令，重写不会碰到指令 */
function rewriteRegion(text: string, filename: string, tsx: boolean): string {
  const { code, errors } = transformSync(filename, text, {
    lang: tsx ? 'tsx' : 'ts',
    ...OXC_OPTIONS,
  })
  const fatal = errors.filter(error => (error.severity as string) === 'Error')
  if (fatal.length)
    throw new Error(fatal.map(error => error.codeframe ?? error.message).join('\n'))
  return stripInjectedEmptyExport(code.replace(/\n$/, ''), text, tsx)
}

/** oxc 会修剪块内容开头的前导空白，按原文补回，避免把首行代码贴上标签 */
function rewriteRegionKeepingIndent(text: string, filename: string, tsx: boolean): string {
  const leading = /^\s*/.exec(text)?.[0] ?? ''
  return leading + rewriteRegion(text.replace(/^\s+/, ''), filename, tsx)
}

interface RegionRewrite {
  region: Region
  text: string
}

/**
 * 兜底路径：整块无法解析时，逐个区域交给 oxc 重写。
 *
 * 区域由指令行分隔，因此重写不可能碰到指令。区域本身可能是语句的片段
 * （`#ifdef` 写在对象字面量或参数列表内部），这种情况 oxc 无法解析，向上报错。
 */
function rewriteAllRegions(
  content: string,
  analysis: ConditionalAnalysis,
  options: ScriptDowngradeOptions,
): string {
  const edits: Edit[] = []
  for (const region of analysis.regions) {
    const text = content.slice(region.start, region.end)
    if (isBlank(text))
      continue
    let rewritten: string
    try {
      rewritten = rewriteRegionKeepingIndent(text, options.filename, options.tsx)
    }
    catch (error) {
      throw new Error(
        `${options.filename} 的 ${options.label} 无法降级为 JS：${(error as Error).message}\n`
        + '条件编译指令把一段语句切开了（例如 #ifdef 写在对象字面量、数组或参数列表内部），'
        + '这段代码在部分平台下本来就不是合法语法。请把指令移到完整的语句或声明外面。',
      )
    }
    edits.push({ start: region.start, end: region.end, text: rewritten })
  }
  return applyEdits(content, edits)
}

/**
 * 主路径：用「等长投影」逐个平台定位该擦除的 TS，再回到原源码上做纯删除。
 *
 * 投影把指令行与本平台不生效的区域换成同长度空白，因此投影里的偏移与源码完全一致，
 * AST 上的区间可以直接用回源码。指令从不参与解析，也就不会被改写或丢失。
 *
 * 返回 null 表示这条路径不适用（原文解析不了、或改写区间碰到了指令），由调用方走兜底路径。
 */
function eraseByProjection(
  content: string,
  analysis: ConditionalAnalysis,
  options: ScriptDowngradeOptions,
): string | null {
  try {
    parseTs(content, { tsx: options.tsx, tolerant: true })
  }
  catch {
    return null
  }

  const directiveRangeList = directiveRanges(analysis)
  const regenerated = new Map<number, RegionRewrite>()
  const edits: Edit[] = []

  // 除各平台投影外，再补一次「所有区域都保留、只挖空指令行」的解析：
  // 在所有平台下都不生效的区域（如恒假的 #else 分支）不会被任何投影覆盖，
  // 但它同样躺在产物里，里面的 TS 也必须擦掉。
  const projections: string[] = [
    blankDirectives(content, analysis),
    ...uniqueContexts(analysis, buildContexts(analysis, { nvue: options.nvue }))
      .map(context => project(content, analysis, context.values)),
  ]

  for (const projected of projections) {
    let projectedAst: BabelNode
    try {
      // tolerant：投影挖空了死区，可能留下 `export { a }` 而 a 已不存在这类「语义」报错。
      // 这是挖空的正常副产物，语法本身是好的，因此要容忍；真正的语法错误仍会抛错。
      projectedAst = parseTs(projected, { tsx: options.tsx, tolerant: true })
    }
    catch {
      // 该平台的投影本身不是合法语法：源码在这个平台下就是坏的，跳过它
      continue
    }

    // 需要代码生成的构造无法用删除表达，改为整段区域重写
    for (const region of analysis.regions) {
      if (regenerated.has(region.index))
        continue
      const text = content.slice(region.start, region.end)
      if (isBlank(text))
        continue
      let regionAst: BabelNode
      try {
        regionAst = parseTs(text, { tsx: options.tsx, tolerant: true })
      }
      catch {
        continue
      }
      if (!findGenerativeNode(regionAst))
        continue
      try {
        regenerated.set(region.index, {
          region,
          text: rewriteRegionKeepingIndent(text, options.filename, options.tsx),
        })
      }
      catch (error) {
        throw new Error(
          `${options.filename} 的 ${options.label} 里的一段代码需要 TypeScript 的代码生成`
          + `（enum / namespace / 构造器参数属性等），但降级失败：${(error as Error).message}`,
        )
      }
    }

    for (const edit of collectErasureEdits(projectedAst, projected)) {
      // 投影与源码逐偏移对齐，越界说明解析器给出了不可用的区间
      if (edit.end > content.length)
        continue
      // 兜底：任何触碰指令行的改写都不可接受
      if (rangesOverlap(directiveRangeList, edit.start, edit.end))
        return null
      edits.push(edit)
    }
  }

  // 已整体重写的区域：与之重叠的擦除区间作废
  const rewriteRanges = [...regenerated.values()].map(({ region }) => ({ start: region.start, end: region.end }))
  const kept = mergeEdits(edits).filter(edit => !rangesOverlap(rewriteRanges, edit.start, edit.end))

  const all: Edit[] = [...kept]
  for (const { region, text } of regenerated.values())
    all.push({ start: region.start, end: region.end, text })

  if (!all.length)
    return content

  const output = applyEdits(content, all)
  // 兜底检查：指令必须逐条原样保留
  assertDirectivesPreserved(content, output, options.filename, { forms: [...SCRIPT_FORMS] })

  // 兜底检查：产物在每个平台的投影下都必须是合法语法，否则说明擦除方向错了
  const outputAnalysis = analyzeConditional(output, { forms: [...SCRIPT_FORMS] })
  for (const projected of [
    blankDirectives(output, outputAnalysis),
    ...uniqueContexts(analysis, buildContexts(analysis, { nvue: options.nvue }))
      .map(context => project(output, outputAnalysis, context.values)),
  ]) {
    try {
      parseTs(projected, { tsx: options.tsx, tolerant: true })
    }
    catch {
      return null
    }
  }
  return output
}

/**
 * 把一段 script 内容里的 TS 降级为 JS，同时原样保留条件编译指令。
 *
 * 没有条件编译指令时也走擦除路径：纯删除比「解析-再打印」更能保住注释与格式，
 * 产物里的指令（以及用户自己的注释）都不会被动。
 */
export function downgradeScriptContent(content: string, options: ScriptDowngradeOptions): string {
  const analysis = analyzeConditional(content, { forms: [...SCRIPT_FORMS] })
  assertConditionalSupported(analysis, options.filename, { forms: [...SCRIPT_FORMS], label: options.label })

  if (!analysis.regions.length) {
    // 没有内容区域（整块都是指令行）时无需降级
    return content
  }

  const erased = eraseByProjection(content, analysis, options)
  const output = erased ?? rewriteAllRegions(content, analysis, options)
  // 最后一道防线：擦除清单漏掉某种 TS 构造时，解析不会报错，必须显式检查
  assertNoTsResidue(output, options.filename, options.label, options.tsx)
  return output
}

/**
 * 校验降级后的内容里没有残留 TypeScript 语法。
 *
 * 这是擦除路径的最后一道防线：擦除靠的是一张「哪些节点是 TS」的清单，
 * 清单漏掉某种构造时，产物会带着 TS 语法发出去，而**解析本身不会报错**
 * （babel / oxc 都能解析 TS），所以必须显式检查。
 *
 * 用 `tolerant` 解析：保留指令的合并文本里，互斥分支的同名声明会报错，
 * 但那不影响 AST 的完整性，仍然可以遍历。
 */
export function assertNoTsResidue(content: string, filename: string, label: string, tsx: boolean): void {
  let ast: BabelNode
  try {
    ast = parseTs(content, { tsx, tolerant: true })
  }
  catch {
    // 语法错误交给下游报错，这里只管「有没有 TS 残留」
    return
  }
  if (!hasTsSyntax(ast))
    return
  throw new Error(
    `${filename} 的 ${label} 降级后仍残留 TypeScript 语法。`
    + '这是插件的缺陷，请提交 issue 并附上这个文件。',
  )
}
