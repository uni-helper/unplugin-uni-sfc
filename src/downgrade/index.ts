import type { SFCBlock, SFCScriptBlock, SFCTemplateBlock } from '@vue/compiler-sfc'
import type { BabelNode } from '../babel'
import type { Warn } from '../types'
import { parse } from '@vue/compiler-sfc'
import { transformSync } from 'oxc-transform'
import { parseScript, walkNode } from '../babel'
import { applyMacroRewrites, collectMacroCalls, resolveRuntimeDeclarations } from '../macro'
import { applyEdits } from '../shared'

const TS_LANG_RE = /^(?:ts|tsx|typescript)$/
const LANG_TS_ATTR_RE = /\s+lang=(["'])(?:ts|tsx|typescript)\1/i
// 同 Vue parseFor 的规则：第一个顶层 `in` / `of` 是 v-for 的分隔符
const FOR_SEPARATOR_RE = /\s+(?:in|of)\s+/

// 条件编译指令：#ifdef / #ifndef / #if / #elif / #else / #endif
const CONDITIONAL_DIRECTIVE_RE = /#\s*(?:ifdef|ifndef|if|elif|else|endif)\b[^\n]*/
// 指令必须写在注释里才会生效：JS/TS 的行注释与块注释、CSS 的块注释、模板的 HTML 注释；
// 只扫注释内的指令，模板纯文本、CSS 选择器等处的 `#ifdef` 字样不是条件编译
const COMMENT_RE = /\/\/[^\n]*|\/\*[\s\S]*?\*\/|<!--[\s\S]*?-->/g

function isTsBlock(block?: SFCBlock | null): boolean {
  return !!block?.lang && TS_LANG_RE.test(block.lang)
}

function isTsxBlock(block: SFCBlock): boolean {
  return block.lang === 'tsx'
}

/** 找出第一处条件编译，返回指令原文（如 `#ifdef H5`）和它所在的行号 */
function findConditionalCompilation(code: string): { directive: string, line: number } | undefined {
  for (const comment of code.matchAll(COMMENT_RE)) {
    const directive = CONDITIONAL_DIRECTIVE_RE.exec(comment[0])?.[0].trim()
    if (!directive)
      continue
    const offset = (comment.index ?? 0) + comment[0].indexOf(directive)
    return { directive, line: code.slice(0, offset).split('\n').length }
  }
}

function transformTs(content: string, filename: string, lang: 'ts' | 'tsx'): string {
  const { code, errors } = transformSync(filename, content, {
    lang,
    typescript: {
      // script 里的导入可能只在模板中使用（oxc 看不到模板），默认会当成未使用而删除，
      // 这里只删除显式的 `import type`，其余值导入全部保留（同 verbatimModuleSyntax 语义）
      onlyRemoveTypeImports: true,
      // 支持 TS namespace 的转换
      allowNamespaces: true,
    },
  })
  const fatal = errors.filter(error => (error.severity as string) === 'Error')
  if (fatal.length)
    throw new Error(fatal.map(error => error.codeframe ?? error.message).join('\n'))
  return code
}

/** `block.loc` 只覆盖块内容（innerLoc），这里向外找到 `<script` 开始标签的位置 */
function findScriptTagStart(code: string, block: SFCBlock): number {
  return code.lastIndexOf('<script', block.loc.start.offset)
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

  // 仅当真的存在 TS 语法节点时才改写，避免 oxc 对纯 JS 表达式的格式调整（如箭头函数参数补括号）
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
function collectTemplateEdits(template: SFCTemplateBlock, filename: string): Array<{ start: number, end: number, text: string }> {
  const expressions: TemplateExpression[] = []
  collectTemplateExpressions(template.ast, expressions)
  const edits = new Map<number, { start: number, end: number, text: string }>()
  for (const { content, loc } of expressions) {
    const text = stripExpressionTypes(content, filename)
    if (text != null)
      edits.set(loc.start.offset, { start: loc.start.offset, end: loc.end.offset, text })
  }
  return [...edits.values()]
}

/**
 * 把 SFC 中 script 块的 TS 降级为 JS，返回新的 .vue 源码。
 * script 块使用了 TS 时，模板表达式（插值、指令值）里的 TS 语法一并降级，
 * 保证产物 SFC 中不残留任何 TS。
 * 只改写这些位置自身，不做任何 vue 编译。没有需要降级的内容时返回 null；
 * SFC 解析失败时抛错中断构建（同 plugin-vue 的行为），避免 TS 原文被静默发进产物。
 * SFC 里出现 uni-app 条件编译时同样抛错中断：本插件不支持条件编译。
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

  // 整个 SFC（script / 模板 / style）都检查，且在 TS 降级之前：任何 .vue 里出现条件编译都直接中断构建
  const conditional = findConditionalCompilation(code)
  if (conditional) {
    throw new Error(
      `${filename} 第 ${conditional.line} 行使用了 uni-app 条件编译（${conditional.directive}），本插件不支持条件编译，指令会原样保留在产物中。请改用 if 分支判断（如 if (process.env.UNI_PLATFORM === 'h5') { ... }）替代。`,
    )
  }

  const blocks = [descriptor.script, descriptor.scriptSetup]
    .filter((block): block is SFCScriptBlock => !!block && !block.src && isTsBlock(block))
  // 模板表达式随 script 一起降级（Vue 仅在 script 为 ts 时才允许模板里写 TS）
  const templateEdits = blocks.length && descriptor.template?.ast && !descriptor.template.src
    ? collectTemplateEdits(descriptor.template, filename)
    : []
  if (!blocks.length && !templateEdits.length)
    return null

  const edits: Array<{ start: number, end: number, text: string }> = []
  for (const block of blocks) {
    const tsx = isTsxBlock(block)
    let content = block.content

    if (block === descriptor.scriptSetup) {
      try {
        const calls = collectMacroCalls(parseScript(content, tsx))
        if (calls.length) {
          const runtime = resolveRuntimeDeclarations(descriptor, filename, tsx, warn)
          if (runtime)
            content = applyMacroRewrites(content, calls, runtime)
        }
      }
      catch {
        // 脚本语法本身有问题时不回填，交给后续 oxc 报错
      }
    }

    const tagStart = findScriptTagStart(code, block)
    edits.push({
      start: tagStart,
      end: block.loc.start.offset,
      text: code.slice(tagStart, block.loc.start.offset).replace(LANG_TS_ATTR_RE, ''),
    })
    const jsCode = transformTs(content, filename, tsx ? 'tsx' : 'ts')
    // oxc 会修剪块内容开头的前导空白，按原文补回，避免 `<script setup>` 后直接贴上首行代码
    const leading = /^\s*/.exec(content)?.[0] ?? ''
    edits.push({ start: block.loc.start.offset, end: block.loc.end.offset, text: leading + jsCode })
  }
  return applyEdits(code, [...edits, ...templateEdits])
}
