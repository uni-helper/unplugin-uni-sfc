import type { SFCStyleBlock } from '@vue/compiler-sfc'
import type { Edit } from '../shared'
import type { Warn } from '../types'
import {
  analyzeConditional,
  assertDirectivesPreserved,
  buildContexts,
  project,
  STYLE_DIRECTIVE_FORMS as STYLE_FORMS,
} from '../conditional'
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
 * 条件编译指令原样保留：less 会保留块注释，指令因此能穿过编译过程。
 * 编译前后逐条比对指令，少一条就中断构建，而不是把失去平台约束的样式发进产物。
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
    // 行注释形式的指令会被 less 吃掉，必须在编译前就拒绝
    const analysis = analyzeConditional(style.content, { forms: STYLE_FORMS })
    const invalid = analysis.issues.invalidForm
    if (invalid.length) {
      throw new Error(
        `${filename} 的 <style lang="less"> 第 ${invalid[0].line} 行用了 ${invalid[0].text.trim()}：`
        + 'less 编译会吃掉行注释（`//`），条件编译指令必须写成 `/* #ifdef ... */` 才能保留到产物里。',
      )
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
    // 指令必须穿过 less 编译：少一条说明它被吃掉了，中断构建
    assertDirectivesPreserved(block.content, css, filename, { forms: STYLE_FORMS })
    const drift = await findGuardDrift(less, block.content, css, filename)
    if (drift)
      throw new Error(drift)
    // less 输出从行首开始且自带尾换行，原内容的首尾缩进不保留：裁掉尾换行统一补回一个，
    // 避免出现 `<style>.a {`、`}</style>` 或 `}\n\n</style>` 这样的粘连
    edits.push({ start: block.loc.start.offset, end: block.loc.end.offset, text: `\n${css.trimEnd()}\n` })
  }
  return edits
}

/**
 * 校验条件编译指令在 less 编译前后「守住的是同一批样式」。
 *
 * less 会把嵌套规则提到外层，于是出现这种情况：
 *
 * ```less
 * .outer {
 *   /* #ifdef MP-WEIXIN *&#47;
 *   .inner { color: pink; }
 *   /* #endif *&#47;
 * }
 * ```
 *
 * 编译后 `.outer .inner` 被提到指令**外面**，两条指令却还留在原地 —— 样式于是在所有平台
 * 都生效了。指令条数没变，光比对指令序列发现不了。
 *
 * 判据是「先投影再编译」必须等于「先编译再投影」：
 * 前者是该平台真正应该得到的样式，后者是产物实际会给出的样式。
 * 两者不一致就说明指令与它守护的样式脱钩了，此时中断构建而不是产出静默错误的样式。
 *
 * @returns 报错信息；一切正常时返回 undefined
 */
async function findGuardDrift(
  less: typeof import('less'),
  source: string,
  css: string,
  filename: string,
): Promise<string | undefined> {
  const sourceAnalysis = analyzeConditional(source, { forms: STYLE_FORMS })
  if (!sourceAnalysis.directives.length)
    return
  const cssAnalysis = analyzeConditional(css, { forms: STYLE_FORMS })

  // 只比较「有没有样式、样式是什么」，忽略选择器外壳的空白差异
  const normalize = (text: string): string =>
    text
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\s+/g, ' ')
      .replace(/[{};]/g, ' ')
      .trim()

  for (const context of buildContexts(sourceAnalysis)) {
    // 该平台真正应该得到的样式：先按平台投影，再编译
    const projected = project(source, sourceAnalysis, context.values)
    if (!projected.trim())
      continue
    let expected: string
    try {
      expected = normalize((await less.render(projected, { filename })).css)
    }
    catch {
      // 投影后编译不了（指令把规则切开了）：交给下面的实际值判断
      expected = ''
    }
    // 产物实际会给出的样式：先编译，再按平台投影
    const actual = normalize(project(css, cssAnalysis, context.values))

    // 源码在该平台下不该有这些样式，产物却有 —— 指令脱钩，样式漏到所有平台了
    if (!expected && actual) {
      return `${filename} 的 <style lang="less"> 里，条件编译指令在 ${context.platform} 下守不住对应的样式：\n`
        + `  less 会把嵌套规则提到指令外面，产物在该平台多出了「${actual}」\n`
        + '请把指令移到顶层规则之间（不要写在某个规则的内部），或改用不依赖嵌套的写法。'
    }
  }
}
