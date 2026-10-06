import type { SFCStyleBlock } from '@vue/compiler-sfc'
import type { Edit } from '../shared'
import type { Warn } from '../types'
import { findTagStart } from '../shared'

const LANG_LESS_RE = /^less$/
// 与 script 块的 lang 改写同一套规则：只处理带引号的 lang 属性
const LANG_LESS_ATTR_RE = /\s+lang=(["'])less\1/i

/** less 是可选依赖：只有 SFC 真的用到 lang="less" 时才会加载 */
async function loadLess(): Promise<typeof import('less')> {
  try {
    // less 4 的 ESM 入口只提供 default 导出，CJS 形态下模块本身就是 less 对象
    const mod = await import('less')
    return mod.default ?? mod
  }
  catch {
    throw new Error('SFC 使用了 <style lang="less">，但未安装 less；请先安装 less（如 pnpm add -D less）')
  }
}

/** 编译单个 style 块的 less；失败时抛错中断构建（同 TS 降级、SFC 解析失败的行为），避免 less 原文被发进产物 */
async function compileLess(less: typeof import('less'), source: string, filename: string): Promise<string> {
  try {
    // filename 让块内 @import 相对 .vue 解析（同 vue-loader 的行为），报错也能带上文件名
    const { css } = await less.render(source, { filename })
    return css
  }
  catch (error) {
    const detail = error as { message?: string, line?: number, column?: number }
    const location = typeof detail.line === 'number' ? ` (${detail.line}:${detail.column ?? 0})` : ''
    throw new Error(`${filename} 的 <style lang="less"> 编译失败${location}：${detail.message ?? String(error)}`)
  }
}

/**
 * 把 SFC 中 lang="less" 的 style 块编译成 CSS，返回对整份源码的替换区间：
 * 每块两条——去掉开始标签上的 lang 属性、用编译产物替换块内容。
 *
 * 带 src 的外部样式块不处理（同 script 块的规则），只提示它们不会进入产物；
 * sass / scss 由 uni-app 自带支持，原样保留；没有 less 块时不会加载 less。
 */
export async function collectStyleEdits(styles: SFCStyleBlock[], code: string, filename: string, warn?: Warn): Promise<Edit[]> {
  const blocks: SFCStyleBlock[] = []
  for (const style of styles) {
    if (!style.lang || !LANG_LESS_RE.test(style.lang))
      continue
    if (style.src) {
      warn?.(`${filename} 的 <style src="${style.src}"> 使用了 less：外部样式文件不会被降级，也不会包含在产物中，请改为内联样式或自行编译为 CSS`)
      continue
    }
    blocks.push(style)
  }
  if (!blocks.length)
    return []

  const less = await loadLess()
  const edits: Edit[] = []
  for (const block of blocks) {
    const tagStart = findTagStart(code, 'style', block)
    edits.push({
      start: tagStart,
      end: block.loc.start.offset,
      text: code.slice(tagStart, block.loc.start.offset).replace(LANG_LESS_ATTR_RE, ''),
    })
    const css = await compileLess(less, block.content, filename)
    // less 输出从行首开始且自带尾换行，原内容的首尾缩进不保留：裁掉尾换行统一补回一个，
    // 避免出现 `<style>.a {`、`}</style>` 或 `}\n\n</style>` 这样的粘连
    edits.push({ start: block.loc.start.offset, end: block.loc.end.offset, text: `\n${css.trimEnd()}\n` })
  }
  return edits
}
