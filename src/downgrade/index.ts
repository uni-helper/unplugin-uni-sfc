import type { SFCBlock, SFCDescriptor, SFCScriptBlock, SFCTemplateBlock } from '@vue/compiler-sfc'
import type { BabelNode } from '../babel'
import type { DirectiveForm } from '../conditional'
import type { Edit } from '../shared'
import type { Warn } from '../types'
import { parse } from '@vue/compiler-sfc'
import { transformSync } from 'oxc-transform'
import { parseScript, walkNode } from '../babel'
import {
  analyzeConditional,
  assertConditionalSupported,
  assertDirectivesPreserved,
  directiveRanges,
  SCRIPT_DIRECTIVE_FORMS as SCRIPT_FORMS,
  STYLE_DIRECTIVE_FORMS as STYLE_FORMS,
  TEMPLATE_DIRECTIVE_FORMS as TEMPLATE_FORMS,
} from '../conditional'
import { rewriteTypeMacros } from '../macro'
import { applyEdits, findTagStart, rangesOverlap } from '../shared'
import { collectStyleEdits } from './less'
import { downgradeScriptContent } from './script'

const TS_LANG_RE = /^(?:ts|tsx|typescript)$/
const LANG_TS_ATTR_RE = /\s+lang=(["'])(?:ts|tsx|typescript)\1/i
// 同 Vue parseFor 的规则：第一个顶层 `in` / `of` 是 v-for 的分隔符
const FOR_SEPARATOR_RE = /\s+(?:in|of)\s+/

/**
 * 校验 SFC 里每个块的条件编译写法都能安全透传。
 *
 * 必须逐块检查、且在任何降级动作之前：
 * - uni-app 的 html / css 规则同样不支持 `#elif`，未知平台名同样会静默丢掉整块内容，
 *   所以模板与样式里的这些写法与 script 里一样有害；
 * - 没有 TS 需要降级时（`downgradeSFC` 会提前返回）也必须检查，
 *   否则纯 JS 的组件会把坏指令原样发进产物。
 */
function assertAllBlocksSupported(descriptor: SFCDescriptor, filename: string): void {
  const blocks: Array<{ forms: DirectiveForm[], content: string | undefined, label: string }> = [
    { forms: SCRIPT_FORMS, content: descriptor.script?.content, label: '<script>' },
    { forms: SCRIPT_FORMS, content: descriptor.scriptSetup?.content, label: '<script setup>' },
    { forms: TEMPLATE_FORMS, content: descriptor.template?.content, label: '<template>' },
    ...descriptor.styles.map((style, index) => ({
      forms: STYLE_FORMS,
      content: style.content,
      label: descriptor.styles.length > 1 ? `<style #${index + 1}>` : '<style>',
    })),
  ]

  for (const block of blocks) {
    if (block.content === undefined)
      continue
    assertConditionalSupported(
      analyzeConditional(block.content, { forms: block.forms }),
      filename,
      { forms: block.forms, label: block.label },
    )
  }
}

function isTsBlock(block?: SFCBlock | null): boolean {
  return !!block?.lang && TS_LANG_RE.test(block.lang)
}

function isTsxBlock(block: SFCBlock): boolean {
  return block.lang === 'tsx'
}

/** 模板中可降级的表达式（插值与指令值），loc 是整个源文件的绝对偏移 */
interface TemplateExpression {
  content: string
  loc: { start: { offset: number }, end: { offset: number } }
}

function isTemplateExpression(value: unknown): value is TemplateExpression {
  return !!value && typeof value === 'object'
    && typeof (value as TemplateExpression).content === 'string'
    && typeof (value as TemplateExpression).loc?.start?.offset === 'number'
}

/**
 * 遍历模板 AST 收集表达式：指令值挂在 DirectiveNode.exp，插值挂在 InterpolationNode.content；
 * v-for 的别名拆分、动态指令参数等非表达式位置跳过。
 */
function collectTemplateExpressions(node: unknown, out: TemplateExpression[]): void {
  if (Array.isArray(node)) {
    node.forEach(child => collectTemplateExpressions(child, out))
    return
  }
  if (!node || typeof node !== 'object')
    return
  const record = node as Record<string, unknown>
  for (const key of ['exp', 'content']) {
    const value = record[key]
    if (isTemplateExpression(value))
      out.push(value)
  }
  for (const value of Object.values(record))
    collectTemplateExpressions(value, out)
}

/**
 * 把单个模板表达式中的 TS 语法降级为 JS（`as` 断言、非空断言、satisfies、泛型调用等）。
 * 表达式不合法或不含 TS 语法时返回 null，保持原样。
 */
function stripExpressionTypes(content: string, filename: string): string | null {
  const parseAsExpression = (source: string): BabelNode | null => {
    try {
      return parseScript(source, false)
    }
    catch {
      return null
    }
  }
  // 顶层不是表达式语句的内容必须补一层括号再转换：对象字面量开头会被解析成块语句
  // （`{ x: a as any }`），按语句转换会把块语法和分号带进模板；v-for 的 `item of items`
  // 解析失败，同样走括号重试
  const direct = parseAsExpression(content)
  const parenthesized = !direct || direct.program?.body?.[0]?.type !== 'ExpressionStatement'
  const ast = direct ?? parseAsExpression(`(${content})`)
  if (!ast) {
    // v-for 的值不是合法表达式（`item of items`），按 Vue 的规则拆出别名与迭代源分别降级
    const separator = FOR_SEPARATOR_RE.exec(content)
    if (!separator)
      return null
    const alias = content.slice(0, separator.index)
    const source = content.slice(separator.index + separator[0].length)
    const strippedSource = stripExpressionTypes(source, filename)
    const strippedAlias = stripExpressionTypes(alias, filename)
    if (strippedSource == null && strippedAlias == null)
      return null
    return `${strippedAlias ?? alias}${separator[0]}${strippedSource ?? source}`
  }

  // 仅当真的存在 TS 语法节点时才改写，避免对纯 JS 表达式做多余的格式调整
  let hasTs = false
  walkNode(ast, (node) => {
    if (node.type.startsWith('TS'))
      hasTs = true
  })
  if (!hasTs)
    return null

  const transform = (source: string): string | null => {
    const { code, errors } = transformSync(filename, source, { lang: 'ts' })
    return errors.some(error => (error.severity as string) === 'Error') ? null : code
  }
  // oxc 会去掉冗余括号，但会给语句补分号；括号形式的产物是语句 `(...)`，
  // 外层括号是为满足语句语法而存在的，修剪后才是原来的表达式
  let output = transform(parenthesized ? `(${content})` : content)?.replace(/;\s*$/, '')
  if (output && parenthesized && output.startsWith('(') && output.endsWith(')'))
    output = output.slice(1, -1)
  return output && output !== content ? output : null
}

/** 收集模板中需要降级的表达式，返回对整个源码的替换区间 */
function collectTemplateEdits(
  template: SFCTemplateBlock,
  code: string,
  filename: string,
  warn?: Warn,
): Edit[] {
  const expressions: TemplateExpression[] = []
  collectTemplateExpressions(template.ast, expressions)
  if (!expressions.length)
    return []

  const directives = directiveRanges(analyzeConditional(code, { forms: ['html'] }))
  const edits = new Map<number, Edit>()
  for (const { content, loc } of expressions) {
    const text = stripExpressionTypes(content, filename)
    if (text == null)
      continue
    // 指令是注释，模板 AST 里看不到它们；万一某个表达式的区间真的跨到了指令行上，
    // 改动它就会破坏指令，这种情况直接跳过并提示，保持原样
    if (rangesOverlap(directives, loc.start.offset, loc.end.offset)) {
      warn?.(`${filename} 的模板表达式跨越了条件编译指令，已跳过降级：${content}`)
      continue
    }
    edits.set(loc.start.offset, { start: loc.start.offset, end: loc.end.offset, text })
  }
  return [...edits.values()]
}

/**
 * 把 SFC 中 script 块的 TS 降级为 JS、style 块的 less 编译为 CSS，返回新的 .vue 源码。
 *
 * **条件编译指令原样保留**：指令对平台的含义由下游 uni-app 决定，插件只保证
 * 「产物在每一个平台的投影下都是正确的 JS / CSS」。做法是先用等长投影定位该擦除的 TS，
 * 再回到原源码上做纯删除——指令从不参与解析与打印，因此不会被改写或丢失。
 *
 * script 块使用了 TS 时，模板表达式（插值、指令值）里的 TS 语法一并降级，
 * 保证产物 SFC 中不残留任何 TS。
 * 只改写这些位置自身，不做任何 vue 编译。没有需要降级的内容时返回 null；
 * SFC 解析失败时抛错中断构建（同 plugin-vue 的行为），避免 TS 原文被静默发进产物。
 */
export async function downgradeSFC(code: string, filename: string, warn?: Warn): Promise<string | null> {
  const { descriptor, errors } = parse(code, { filename })
  if (errors.length) {
    const detail = errors
      .map((error) => {
        const start = (error as { loc?: { start?: { line?: number, column?: number } } }).loc?.start
        return start?.line ? `${error.message} (${start.line}:${start.column})` : error.message
      })
      .join('\n')
    throw new Error(`${filename} 解析失败，无法降级为 JS：\n${detail}`)
  }

  // 先逐块校验条件编译写法：合法的指令才能原样透传，不合法的必须在这里就拦下，
  // 不能等到「有 TS 要降级」时才检查（没有 TS 的组件同样会把坏指令发进产物）
  assertAllBlocksSupported(descriptor, filename)

  const blocks = [descriptor.script, descriptor.scriptSetup]
    .filter((block): block is SFCScriptBlock => !!block && !block.src && isTsBlock(block))
  // 模板表达式随 script 一起降级（Vue 仅在 script 为 ts 时才允许模板里写 TS）
  const templateEdits = blocks.length && descriptor.template?.ast && !descriptor.template.src
    ? collectTemplateEdits(descriptor.template, code, filename, warn)
    : []
  // style 块的 less 降级与 script 无关：纯 JS 的 SFC 也可能用到 less
  const styleEdits = await collectStyleEdits(descriptor.styles, code, filename, warn)
  if (!blocks.length && !templateEdits.length && !styleEdits.length)
    return null

  const edits: Edit[] = []
  for (const block of blocks) {
    const tsx = isTsxBlock(block)
    let content = block.content

    // 类型宏的运行时声明只存在于类型里，必须在擦除类型之前回填；
    // 普通 <script> 的类型声明也参与解析（两个块共享作用域）
    if (block === descriptor.scriptSetup) {
      content = rewriteTypeMacros(block, descriptor.script, tsx, filename)
      // 宏改写会替换调用处，若某次替换跨到了指令行上就会破坏指令，这里立刻发现
      // （指令写法本身已在 assertAllBlocksSupported 里校验过）
      assertDirectivesPreserved(block.content, content, filename, { forms: SCRIPT_FORMS })
    }

    const tagStart = findTagStart(code, 'script', block)
    edits.push({
      start: tagStart,
      end: block.loc.start.offset,
      text: code.slice(tagStart, block.loc.start.offset).replace(LANG_TS_ATTR_RE, ''),
    })
    const jsCode = downgradeScriptContent(content, {
      filename,
      tsx,
      label: block === descriptor.scriptSetup ? '<script setup>' : '<script>',
      // `.nvue` 的上下文多出 APP_NVUE / APP_PLUS_NVUE，`#ifdef APP-NVUE` 要靠它才能判对
      nvue: filename.endsWith('.nvue'),
      warn,
    })
    // 擦除走的是「只删区间」，缩进天然保留；仅在块内首行被整体删除时补回换行
    const leading = /^\s*/.exec(content)?.[0] ?? ''
    const needsLeading = leading.includes('\n') && !jsCode.startsWith(leading)
    edits.push({
      start: block.loc.start.offset,
      end: block.loc.end.offset,
      text: needsLeading ? leading + jsCode.replace(/^\s*/, '') : jsCode,
    })
  }
  return applyEdits(code, [...edits, ...templateEdits, ...styleEdits])
}
