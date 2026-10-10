import type { Warn } from '../types'
import process from 'node:process'

/**
 * 条件编译：识别 uni-app 的 `#ifdef` / `#ifndef` / `#if` / `#else` / `#endif` 指令。
 *
 * 本插件**不改写指令**：指令对每个平台的含义由下游 uni-app 决定，产物必须原样透传。
 * 这里做的事只有两件：
 * 1. 把源码切成「指令行」与「内容区域」，并算出每个区域在什么平台上生效；
 * 2. 生成「等长投影」——把指令行与当前平台下不生效的区域替换成同长度的空白，
 *    让投影文本的每个偏移都与源码完全相同，从而可以用它解析出一份「该平台下真实存在的代码」，
 *    再把 AST 上的改写区间用回源码。指令因此从不参与解析与打印，也就不会被改写或丢失。
 */

/** 参与条件编译判定的上下文键，取自 uni-app initScopedPreContext 的 DEFAULT_KEYS */
export const CONTEXT_KEYS = [
  'UNI_APP_X',
  'APP',
  'APP_UVUE',
  'APP_NVUE',
  'APP_PLUS',
  'APP_PLUS_NVUE',
  'APP_VUE',
  'APP_ANDROID',
  'APP_IOS',
  'APP_HARMONY',
  'H5',
  'MP',
  'MP_360',
  'MP_ALIPAY',
  'MP_BAIDU',
  'MP_HARMONY',
  'MP_QQ',
  'MP_LARK',
  'MP_TOUTIAO',
  'MP_WEIXIN',
  'MP_KUAISHOU',
  'MP_JD',
  'MP_XHS',
  'QUICKAPP_NATIVE',
  'QUICKAPP_WEBVIEW',
  'QUICKAPP_WEBVIEW_HUAWEI',
  'QUICKAPP_WEBVIEW_UNION',
  'VUE2',
  'VUE3',
  'WEB',
] as const

/**
 * 用来覆盖所有平台上下文的代表平台：每个已知平台名都会点亮一组独有的键，
 * 因此判定结果只会落在这些上下文之一里。`app` 与 `app-plus` 的上下文相同，去重后只留一个。
 *
 * `.nvue` 会额外点亮 APP_NVUE / APP_PLUS_NVUE，uni-app x 会额外点亮
 * APP_UVUE / APP_ANDROID / APP_IOS，见 buildContexts。
 */
export const PLATFORMS = [
  'h5',
  'mp-360',
  'mp-alipay',
  'mp-baidu',
  'mp-harmony',
  'mp-qq',
  'mp-lark',
  'mp-toutiao',
  'mp-weixin',
  'mp-kuaishou',
  'mp-jd',
  'mp-xhs',
  'app',
  'app-plus',
  'app-harmony',
  'quickapp-native',
  'quickapp-webview',
  'quickapp-webview-huawei',
  'quickapp-webview-union',
] as const

/** 只有 App 端才可能命中 nvue / uvue 上下文，其余平台不必展开 */
const APP_PLATFORMS = ['app', 'app-plus', 'app-harmony'] as const

/** uni-app x 里 uts 插件的目标平台，对应上下文里的 APP_ANDROID / APP_IOS */
const UTS_PLATFORMS = ['app-android', 'app-ios'] as const

/** 指令注释的形式：JS 行注释、块注释、模板的 HTML 注释 */
export type DirectiveForm = 'line' | 'block' | 'html'
export type DirectiveKind = 'ifdef' | 'ifndef' | 'if' | 'elif' | 'else' | 'endif'

const ALL_FORMS: DirectiveForm[] = ['line', 'block', 'html']

/**
 * 指令必须独占一行（允许前导缩进），与 uni-app 文档一致。
 * 关键字后允许空白与注释结束符，其余内容都是判定表达式。
 *
 * 关键字按大小写不敏感匹配，是为了能**识别出**大小写写错的指令并报错：
 * uni-app 用 `/gmi` 做匹配，但随后只认小写的 `ifdef` / `ifndef` / `if`，
 * 其它写法会让它内部抛错；而 `uniPrePlugin` 的 preprocess 把异常吞掉后**返回原文**，
 * 结果是那段代码在**所有平台**都生效——静默错误，必须在这里拦下。
 */
const DIRECTIVE_RE = /^[ \t]*(?:(?:\/\/|\/\*)[ \t]*|<!--[ \t]*)#(ifdef|ifndef|if|elif|else|endif)\b([^\n]*)$/i

/** 判定表达式里可能出现的运算符之外的东西：只接受平台名这种标识符 */
const PLAIN_GUARD_RE = /^[\w\s!()|&.-]+$/

export interface Directive {
  kind: DirectiveKind
  /** 判定表达式，如 `MP-WEIXIN || H5`；`#else` / `#endif` 为空 */
  expr: string
  form: DirectiveForm
  /** 整行原文，用于原样保留 */
  text: string
  /** 相对被分析文本的区间（不含换行） */
  start: number
  end: number
  /** 相对被分析文本的行号（从 1 开始），用于报错定位 */
  line: number
}

/** 一个分支的守卫：`#ifdef X` / `#ifndef X` / `#if <expr>`，negated 表示取反（#ifndef 与 #else） */
export interface Guard {
  kind: 'ifdef' | 'ifndef' | 'if'
  expr: string
  negated: boolean
  directive: Directive
}

/** 指令之间的连续内容，没有指令行 */
export interface Region {
  index: number
  lines: string[]
  guards: Guard[]
  /** 相对被分析文本的区间：首行行首到末行行尾 */
  start: number
  end: number
}

export type ConditionalItem =
  | { kind: 'directive', directive: Directive }
  | { kind: 'region', region: Region }

export interface ConditionalIssues {
  /** `#elif`：uni-app 的预处理实现并不支持，指令会残留在产物里 */
  elif: Directive[]
  /** 未闭合的 `#ifdef` / `#ifdef` 对应的指令 */
  unclosed: Directive[]
  /** 多余的 `#endif` / `#else` */
  orphan: Directive[]
  /** 判定表达式里出现了上下文里没有的平台名（多半是拼写错误，uni-app 会静默丢掉整块代码） */
  unknown: string[]
  /** 注释形式不适用于所在块，如 style 块里的 `// #ifdef` */
  invalidForm: Directive[]
  /** 起始关键字大小写写错了（如 `#IfDeF`）：uni-app 只认小写，写错会让整段代码在所有平台生效 */
  miscased: Directive[]
  /** 表达式引用了 uniVersion，判定结果取决于编译器版本 */
  versionSensitive: boolean
}

export interface ConditionalAnalysis {
  items: ConditionalItem[]
  regions: Region[]
  directives: Directive[]
  issues: ConditionalIssues
}

export interface AnalyzeOptions {
  /** 允许的指令注释形式，默认三种都允许 */
  forms?: DirectiveForm[]
}

function toForm(line: string): DirectiveForm {
  if (/^[ \t]*<!--/.test(line))
    return 'html'
  if (/^[ \t]*\/\*/.test(line))
    return 'block'
  return 'line'
}

/** 去掉表达式两侧的注释结束符与空白 */
function cleanExpr(rest: string): string {
  return rest.replace(/\s*(?:\*\/|-->)\s*$/, '').trim()
}

/**
 * 判定表达式里「像平台名」的部分：只在表达式整体由平台名与 `||` / `&&` / `!` / 括号组成时校验，
 * 含比较、属性访问等其它运算符的表达式交给 JS 求值，不做名字检查。
 */
function unknownNamesIn(expr: string): string[] {
  if (!expr || !PLAIN_GUARD_RE.test(expr))
    return []
  const names: string[] = []
  for (const token of expr.split(/[|&\s!()]+/)) {
    const name = token.trim()
    if (!name || name === 'uniVersion')
      continue
    const key = normalizeKey(name)
    if (!(CONTEXT_KEYS as readonly string[]).includes(key))
      names.push(name)
  }
  return names
}

export function normalizeKey(name: string): string {
  return name.replace(/-/g, '_').toUpperCase()
}

/** 把源码切成「指令行」与「内容区域」 */
export function analyzeConditional(code: string, options: AnalyzeOptions = {}): ConditionalAnalysis {
  const forms = options.forms ?? ALL_FORMS
  const items: ConditionalItem[] = []
  const regions: Region[] = []
  const directives: Directive[] = []
  const issues: ConditionalIssues = {
    elif: [],
    unclosed: [],
    orphan: [],
    unknown: [],
    invalidForm: [],
    miscased: [],
    versionSensitive: false,
  }

  const stack: Guard[] = []
  let current: Region | undefined
  let offset = 0
  let lineNumber = 0

  for (const text of code.split('\n')) {
    lineNumber += 1
    const start = offset
    const end = start + text.length
    offset = end + 1

    const match = DIRECTIVE_RE.exec(text)
    if (!match) {
      if (current === undefined) {
        current = { index: regions.length, lines: [], guards: stack.map(guard => ({ ...guard })), start, end }
        regions.push(current)
        items.push({ kind: 'region', region: current })
      }
      current.lines.push(text)
      current.end = end
      continue
    }

    // 关键字大小写不敏感地匹配出来，再统一成规范拼写；
    // 起始关键字写了别的形式会被记进 miscased（uni-app 只认小写，见 DIRECTIVE_RE）
    const rawKeyword = match[1]
    const kind = rawKeyword.toLowerCase() as DirectiveKind
    const expr = cleanExpr(match[2] ?? '')
    const directive: Directive = { kind, expr, form: toForm(text), text, start, end, line: lineNumber }
    directives.push(directive)
    if (!forms.includes(directive.form))
      issues.invalidForm.push(directive)
    // 只有起始关键字必须全小写：uni-app 的 switch 只认 ifdef / ifndef / if，
    // 而 #endif / #else 走的是大小写不敏感的正则，写成 #ENDIF / #Else 照常工作
    if ((kind === 'ifdef' || kind === 'ifndef' || kind === 'if') && rawKeyword !== kind)
      issues.miscased.push(directive)
    current = undefined

    if (kind === 'endif') {
      if (stack.length === 0)
        issues.orphan.push(directive)
      else
        stack.pop()
    }
    else if (kind === 'else') {
      if (stack.length === 0) {
        issues.orphan.push(directive)
      }
      else {
        const top = stack[stack.length - 1]
        stack[stack.length - 1] = { ...top, negated: !top.negated }
      }
    }
    else if (kind === 'elif') {
      issues.elif.push(directive)
      if (stack.length > 0) {
        const top = stack[stack.length - 1]
        stack[stack.length - 1] = { ...top, negated: !top.negated }
      }
    }
    else {
      stack.push({ kind, expr, negated: kind === 'ifndef', directive })
      issues.unknown.push(...unknownNamesIn(expr))
      if (/\buniVersion\b/.test(expr))
        issues.versionSensitive = true
    }

    items.push({ kind: 'directive', directive })
  }

  for (const guard of stack)
    issues.unclosed.push(guard.directive)

  return { items, regions, directives, issues }
}

export interface PlatformContext {
  key: string
  /** 上下文里的所有键，`with (context)` 求值时用它兜底 */
  values: Record<string, unknown>
  platform: string
}

export interface ContextOptions {
  /** `.nvue` 使用 nvue 上下文（多出 APP_NVUE / APP_PLUS_NVUE） */
  nvue?: boolean
  /** uni-app x */
  isX?: boolean
  /** uni-app x 的 uts 目标平台，对应 APP_ANDROID / APP_IOS */
  utsPlatform?: 'app-android' | 'app-ios'
  /** 编译器版本，对应上下文里的 uniVersion；默认取环境变量，取不到按 3 处理 */
  uniVersion?: number
  /** 额外的上下文键，对应 uni-app 的 userPreContext */
  user?: Record<string, boolean>
}

function baseUniVersion(): number {
  const fromEnv = Number.parseFloat(process.env.UNI_COMPILER_VERSION ?? '')
  return Number.isFinite(fromEnv) ? fromEnv : 3
}

function createContext(platform: string, uniVersion: number, options: ContextOptions): Record<string, unknown> {
  const values: Record<string, unknown> = {}
  for (const key of CONTEXT_KEYS)
    values[key] = false

  values.uniVersion = uniVersion
  values.VUE3 = true
  if (options.isX)
    values.UNI_APP_X = true
  values[normalizeKey(platform)] = true

  if (platform === 'app' || platform === 'app-plus' || platform === 'app-harmony') {
    values.APP = true
    if (platform === 'app-harmony') {
      values.APP_HARMONY = true
    }
    else {
      values.APP_PLUS = !options.isX
    }
    values.APP_VUE = true
    if (options.nvue) {
      values.APP_NVUE = true
      values.APP_PLUS_NVUE = true
    }
    if (options.isX) {
      values.APP_UVUE = true
      if (options.utsPlatform === 'app-android')
        values.APP_ANDROID = true
      else if (options.utsPlatform === 'app-ios')
        values.APP_IOS = true
    }
  }
  else if (platform.startsWith('mp-')) {
    values.MP = true
  }
  else if (platform.startsWith('quickapp-webview')) {
    values.QUICKAPP_WEBVIEW = true
  }
  else if (platform === 'h5') {
    values.WEB = true
  }

  for (const [key, value] of Object.entries(options.user ?? {}))
    values[normalizeKey(key)] = !!value

  return values
}

/**
 * 列出需要投影的上下文：覆盖所有代表平台、nvue / uvue 变体；
 * 判定用到了 uniVersion 时再补上「版本最低 / 最高」两种，避免因为猜错版本而漏掉某个平台上真实存在的代码。
 *
 * nvue / uvue 只在 App 端存在，所以只对 App 平台展开，避免无谓地多出十几个上下文。
 */
export function buildContexts(analysis: ConditionalAnalysis, options: ContextOptions = {}): PlatformContext[] {
  const versions = analysis.issues.versionSensitive
    ? [Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY]
    : [options.uniVersion ?? baseUniVersion()]

  // `#ifdef APP-NVUE` / `#ifdef APP-UVUE` / `#ifdef APP-ANDROID` 的判定结果
  // 只在 App 端与别的平台不同，这里把 App 平台的这几种上下文都补上
  const variants: ContextOptions[] = [{ ...options }]
  for (const platform of APP_PLATFORMS) {
    if (platform === 'app' || platform === 'app-plus') {
      variants.push({ ...options, nvue: true })
      variants.push({ ...options, isX: true })
    }
  }
  for (const uts of UTS_PLATFORMS)
    variants.push({ ...options, isX: true, utsPlatform: uts })

  const contexts: PlatformContext[] = []
  const seen = new Set<string>()
  for (const platform of PLATFORMS) {
    for (const variant of variants) {
      // nvue / uvue 变体只对 App 平台有意义
      const isApp = (APP_PLATFORMS as readonly string[]).includes(platform)
      if ((variant.nvue || variant.isX) && !isApp)
        continue
      for (const version of versions) {
        const values = createContext(platform, version, variant)
        const key = JSON.stringify(values)
        if (seen.has(key))
          continue
        seen.add(key)
        contexts.push({ key, values, platform })
      }
    }
  }
  return contexts
}

/**
 * 判定单个守卫是否成立。
 *
 * 与 uni-app 的 `getTestTemplate` 保持一致：`-` 全部换成 `_` 后按 JS 表达式求值，
 * 求值失败（引用了上下文里没有的名字等）按不成立处理。
 */
export function evaluateGuard(expr: string, values: Record<string, unknown>): boolean {
  const test = expr.trim() || 'true'
  try {
    // eslint-disable-next-line no-new-func
    const fn = new Function('context', `with (context || {}) { return ( ${test.replace(/-/g, '_')} ); }`)
    return !!fn(values)
  }
  catch {
    return false
  }
}

export function isRegionLive(region: Region, values: Record<string, unknown>): boolean {
  return region.guards.every((guard) => {
    const passed = evaluateGuard(guard.expr, values)
    return guard.negated ? !passed : passed
  })
}

function blank(text: string): string {
  return ' '.repeat(text.length)
}

/**
 * 等长投影：指令行与当前平台下不生效的区域都换成同长度的空白。
 * 投影文本与源码逐偏移对齐，可以直接拿去解析，解析结果里的区间也能原样用回源码。
 */
export function project(code: string, analysis: ConditionalAnalysis, values: Record<string, unknown>): string {
  const out: string[] = []
  for (const item of analysis.items) {
    if (item.kind === 'directive') {
      out.push(blank(item.directive.text))
      continue
    }
    const live = isRegionLive(item.region, values)
    for (const line of item.region.lines)
      out.push(live ? line : blank(line))
  }
  return out.join('\n')
}

/** 只把指令行换成空白、所有区域都保留的投影：用来在不看到指令的前提下解析整块内容 */
export function blankDirectives(code: string, analysis: ConditionalAnalysis): string {
  const out: string[] = []
  for (const item of analysis.items)
    out.push(item.kind === 'directive' ? blank(item.directive.text) : item.region.lines.join('\n'))
  return out.join('\n')
}

/** 指令行的区间表，用来保证任何改写都不会碰到指令 */
export function directiveRanges(analysis: ConditionalAnalysis): Array<{ start: number, end: number }> {
  return analysis.directives.map(directive => ({ start: directive.start, end: directive.end }))
}

export function overlapsDirective(ranges: Array<{ start: number, end: number }>, start: number, end: number): boolean {
  return ranges.some(range => start < range.end && end > range.start)
}

/** 指令序列（种类 + 表达式），用于校验改写前后指令逐条不变 */
export function directiveSignature(analysis: ConditionalAnalysis): string[] {
  return analysis.directives.map(directive => `${directive.kind} ${directive.expr}`.trim())
}

/**
 * 校验改写后的文本里指令逐条未变。
 * 这是「原样透传」的兜底检查：任何一次改写如果动了指令，都在这里立刻失败，而不是把坏产物发出去。
 */
export function assertDirectivesPreserved(
  source: string,
  output: string,
  filename: string,
  options: AnalyzeOptions = {},
): void {
  const before = directiveSignature(analyzeConditional(source, options))
  const after = directiveSignature(analyzeConditional(output, options))
  if (before.length === after.length && before.every((item, index) => item === after[index]))
    return
  throw new Error(
    `${filename} 的内部错误：降级过程改动了条件编译指令（原 ${before.length} 条，现 ${after.length} 条）。`
    + '请提交 issue 并附上这个文件。',
  )
}

/**
 * 把分析结果里「必须中断构建」的问题报出来。
 *
 * 这些都是 uni-app 自己会静默做错的地方：`#elif` 会残留在产物里、未知平台名会让整块代码消失、
 * 指令不配对会让预处理直接失败。与其产出坏组件，不如在这里说清楚。
 */
export function assertConditionalSupported(
  analysis: ConditionalAnalysis,
  filename: string,
  options: AnalyzeOptions & { label?: string } = {},
): void {
  const where = options.label ? `${filename} 的 ${options.label}` : filename
  const problems: string[] = []

  for (const directive of analysis.issues.elif)
    problems.push(`第 ${directive.line} 行的 ${directive.text.trim()}：uni-app 不支持 #elif`)

  for (const directive of analysis.issues.invalidForm)
    problems.push(`第 ${directive.line} 行的 ${directive.text.trim()}：该位置只支持 ${describeForms(options.forms)} 指令`)

  for (const directive of analysis.issues.miscased) {
    problems.push(
      `第 ${directive.line} 行的 ${directive.text.trim()}：起始关键字必须全小写（#ifdef / #ifndef / #if）。`
      + 'uni-app 对大小写写错的指令会处理失败并回退成原文，整段代码会在所有平台生效',
    )
  }

  for (const directive of analysis.issues.orphan)
    problems.push(`第 ${directive.line} 行的 ${directive.text.trim()}：没有与之配对的 #ifdef / #ifndef / #if`)

  for (const directive of analysis.issues.unclosed)
    problems.push(`第 ${directive.line} 行的 ${directive.text.trim()}：缺少配对的 #endif`)

  const unknown = [...new Set(analysis.issues.unknown)]
  if (unknown.length) {
    problems.push(
      `判定条件里的 ${unknown.map(name => `\`${name}\``).join('、')} 不是 uni-app 的平台名：`
      + 'uni-app 对认不出的名字会静默丢掉整块代码。可用的平台名见 '
      + 'https://uniapp.dcloud.net.cn/tutorial/platform.html',
    )
  }

  if (!problems.length)
    return

  throw new Error(
    `${where}使用了本插件无法安全处理的条件编译：\n${
      problems.map(problem => `  - ${problem}`).join('\n')
    }\n#elif 请改用嵌套的 #ifdef 或 \`||\` 表达式；平台名拼写请对照官方文档。`,
  )
}

function describeForms(forms?: DirectiveForm[]): string {
  const list = forms ?? ALL_FORMS
  const names: Record<DirectiveForm, string> = {
    line: '// #ifdef',
    block: '/* #ifdef */',
    html: '<!-- #ifdef -->',
  }
  return list.map(form => names[form]).join(' / ')
}

/** 需要用到条件编译分析时统一从这里取，避免各处重复解析 */
export function analyzeOnce(
  code: string,
  filename: string,
  warn: Warn | undefined,
  options: AnalyzeOptions & { label?: string } = {},
): ConditionalAnalysis {
  const analysis = analyzeConditional(code, options)
  try {
    assertConditionalSupported(analysis, filename, options)
  }
  catch (error) {
    warn?.((error as Error).message)
    throw error
  }
  return analysis
}
