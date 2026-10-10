import type { SFCBlock } from '@vue/compiler-sfc'
import type { BabelNode } from '../babel'
import path from 'node:path'
import { importSourceLiteral, parseScript, walkNode } from '../babel'

/** 从产物文件 fromFileName 指向产物文件 toFileName 的相对引用 */
export function toSpecifier(fromFileName: string, toFileName: string): string {
  const specifier = path.posix.relative(path.posix.dirname(fromFileName), toFileName)
  return specifier.startsWith('.') ? specifier : `./${specifier}`
}

export interface Edit {
  start: number
  end: number
  text: string
}

/** 区间 [start, end) 是否与任意一个给定区间相交 */
export function rangesOverlap(ranges: Array<{ start: number, end: number }>, start: number, end: number): boolean {
  return ranges.some(range => start < range.end && end > range.start)
}

/** 按区间替换源码，区间之间不能重叠 */
export function applyEdits(code: string, edits: Edit[]): string {
  let result = code
  for (const { start, end, text } of edits.sort((a, b) => b.start - a.start))
    result = result.slice(0, start) + text + result.slice(end)
  return result
}

/** `block.loc` 只覆盖块内容（innerLoc），这里向外找到 `<tag` 开始标签的位置 */
export function findTagStart(code: string, tag: string, block: SFCBlock): number {
  return code.lastIndexOf(`<${tag}`, block.loc.start.offset)
}

/**
 * 把 chunk 代码里 import / export-from / 动态 import / require 语句中的引用字面量
 * 从 replacements 的键换成对应的值。
 *
 * 只按语法位置替换，代码里内容恰好相同的普通字符串（文档、路径常量等）不受影响；
 * 代码解析失败时退回整串替换——宁可冒误伤的风险，也要保证引用不会指向已被删除的 chunk。
 */
export function replaceSpecifiers(code: string, replacements: Map<string, string>): string {
  if (![...replacements.keys()].some(from => code.includes(from)))
    return code

  let ast: BabelNode | undefined
  try {
    ast = parseScript(code, true)
  }
  catch {
    ast = undefined
  }
  if (!ast) {
    let result = code
    for (const [from, to] of replacements)
      result = result.split(`'${from}'`).join(`'${to}'`).split(`"${from}"`).join(`"${to}"`)
    return result
  }

  const edits: Edit[] = []
  walkNode(ast, (node) => {
    const literal = importSourceLiteral(node)
    const to = literal && replacements.get(literal.value)
    if (!literal || !to)
      return
    const raw = code.slice(literal.start, literal.end)
    const quote = raw[0]
    if (raw.length > 1 && (quote === '\'' || quote === '"') && raw.endsWith(quote))
      edits.push({ start: literal.start + 1, end: literal.end - 1, text: to })
  })
  return edits.length ? applyEdits(code, edits) : code
}
