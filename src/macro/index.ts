import type { Node } from '@babel/types'
import type { SFCScriptBlock, SimpleTypeResolveContext } from '@vue/compiler-sfc'
import type { BabelNode } from '../babel'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import process from 'node:process'
import { extractRuntimeEmits, extractRuntimeProps, registerTS } from '@vue/compiler-sfc'
import { parseScript, walkNode } from '../babel'

/** 带类型参数时才需要回填运行时声明的宏 */
const TYPE_MACROS = new Set(['defineProps', 'defineEmits'])

/**
 * 生成的运行时 helper 引用统一加前缀：下游 Vue 会自己生成 `_mergeDefaults` 这类名字，
 * 用自己的前缀避免和它撞名。
 */
const HELPER_PREFIX = '__uni_sfc_'

let tsRegistered = false

/**
 * 找 TypeScript：优先从用户工程（`process.cwd()`）解析，再退回插件自身。
 *
 * 直接 `require('typescript')` 在 pnpm 的严格布局下会失败：插件被装到
 * `.pnpm/.../node_modules/@uni-helper/unplugin-uni-sfc`，从那里看不到用户的 typescript，
 * 因此显式把工程目录作为解析起点。
 */
function loadTypeScript(): unknown {
  const require = createRequire(import.meta.url)
  for (const paths of [[process.cwd()], undefined]) {
    try {
      return require(require.resolve('typescript', paths ? { paths } : undefined))
    }
    catch {
      // 换下一个解析起点
    }
  }
}

/**
 * 注册 TypeScript，让 Vue 能解析非相对路径的类型引用（`@/types`、`vue` 等）：
 * 这类引用要靠 TypeScript 按 tsconfig 的 paths 解析，不注册就只能解析相对路径。
 * TypeScript 是可选依赖，缺了也不影响相对路径，因此这里静默跳过，
 * 真正用到时由 Vue 抛出明确错误。
 */
function ensureTsRegistered(): void {
  if (tsRegistered)
    return
  tsRegistered = true
  const ts = loadTypeScript()
  if (ts)
    registerTS(() => ts as never)
}

export interface RuntimeDeclarations {
  props?: string
  emits?: string
  /** 声明里引用到的 vue 运行时 helper（如 `mergeDefaults`），需要一并导入 */
  helpers?: string[]
}

interface MacroCall {
  name: 'defineProps' | 'defineEmits' | 'withDefaults'
  start: number
  end: number
}

function isCallTo(node: BabelNode | undefined, name: string): boolean {
  return node?.type === 'CallExpression' && node.callee?.type === 'Identifier' && node.callee.name === name
}

/** 宏的类型实参：`defineProps<T>()` 里的 `T` */
function typeArgumentOf(call: BabelNode | undefined): BabelNode | undefined {
  return call ? (call.typeParameters ?? call.typeArguments)?.params?.[0] : undefined
}

function isOutermost(call: MacroCall, calls: MacroCall[]): boolean {
  return !calls.some(other => other !== call && other.start <= call.start && other.end >= call.end)
}

/**
 * 找出需要回填运行时声明的宏调用：
 * 带类型参数的 `defineProps<T>()` / `defineEmits<T>()`，以及 `withDefaults(defineProps<T>(), ...)`。
 *
 * 运行时声明（`defineProps({...})`）不需要回填；`withDefaults` 搭配运行时声明本来就非法，
 * 留给下游 Vue 报错比插件改写更清楚。
 */
function collectMacroCalls(ast: BabelNode): MacroCall[] {
  const calls: MacroCall[] = []
  walkNode(ast, (node) => {
    if (node.type !== 'CallExpression' || node.callee?.type !== 'Identifier')
      return
    const name = node.callee.name
    if (!name)
      return
    if (TYPE_MACROS.has(name) && typeArgumentOf(node)) {
      calls.push({ name: name as MacroCall['name'], start: node.start, end: node.end })
      return
    }
    // withDefaults 整体替换：默认值会合进 props，而 Vue 不允许它搭配运行时声明
    if (name === 'withDefaults' && typeArgumentOf(node.arguments?.[0]))
      calls.push({ name, start: node.start, end: node.end })
  })
  // withDefaults 内部还有一次 defineProps 调用，外层替换后内层要被丢弃
  return calls.filter(call => isOutermost(call, calls))
}

/** 属性的静态名字；计算属性等动态键返回 undefined */
function staticKeyOf(property: BabelNode): string | undefined {
  const key = property.key
  if (!key)
    return
  if (key.type === 'Identifier')
    return key.name
  const value = (key as unknown as { value?: unknown }).value
  return typeof value === 'string' ? value : undefined
}

/**
 * 复刻 Vue 的 processPropsDestructure：记录解构写法带来的默认值。
 * `const { count = 1 } = defineProps<T>()` 的默认值只存在于解构表达式里，
 * 类型声明上看不到，不交给 extractRuntimeProps 就会丢掉。
 */
function collectDestructuredDefaults(pattern: BabelNode): SimpleTypeResolveContext['propsDestructuredBindings'] {
  const bindings: SimpleTypeResolveContext['propsDestructuredBindings'] = {}
  for (const property of pattern.properties ?? []) {
    if (property.type !== 'ObjectProperty')
      continue
    const name = staticKeyOf(property)
    if (!name)
      continue
    const value = property.value
    if (value?.type === 'AssignmentPattern' && value.left)
      bindings[name] = { local: value.left.name ?? name, default: value.right as never }
    else if (value?.type === 'Identifier')
      bindings[name] = { local: value.name ?? name }
  }
  return bindings
}

interface MacroDeclarations {
  propsTypeDecl?: BabelNode
  emitsTypeDecl?: BabelNode
  propsRuntimeDefaults?: BabelNode
  propsDestructuredBindings: SimpleTypeResolveContext['propsDestructuredBindings']
}

/** 从脚本 AST 里取出类型宏的声明：类型实参、withDefaults 的默认值、解构默认值 */
function collectMacroDeclarations(ast: BabelNode): MacroDeclarations {
  const result: MacroDeclarations = { propsDestructuredBindings: {} }
  walkNode(ast, (node) => {
    if (node.type !== 'CallExpression')
      return
    if (isCallTo(node, 'defineProps')) {
      const type = typeArgumentOf(node)
      if (type)
        result.propsTypeDecl = type
    }
    else if (isCallTo(node, 'defineEmits')) {
      const type = typeArgumentOf(node)
      if (type)
        result.emitsTypeDecl = type
    }
    else if (isCallTo(node, 'withDefaults')) {
      result.propsRuntimeDefaults = node.arguments?.[1]
    }
  })

  // 解构写法：`const { count = 1 } = defineProps<T>()`
  walkNode(ast, (node) => {
    if (node.type === 'VariableDeclarator' && node.id?.type === 'ObjectPattern' && isCallTo(node.init, 'defineProps'))
      result.propsDestructuredBindings = collectDestructuredDefaults(node.id)
  })
  return result
}

interface ResolveOutcome {
  declarations: RuntimeDeclarations
  error?: string
}

/**
 * 用官方的 `extractRuntimeProps` / `extractRuntimeEmits` 从类型声明生成运行时声明。
 *
 * 这两个函数需要一个 TypeResolveContext：官方没有导出 `ScriptCompileContext`
 * （只在 .d.ts 里声明，各构建产物都没有），因此按官方文档给出的
 * SimpleTypeResolveContext 形态自己组装。
 * 类型解析只依赖 AST，且节点区间相对脚本块内容，所以 `source` / `getString` 都按块内容切片。
 *
 * `statements` 是普通 `<script>` 与 `<script setup>` 两个块的语句合并结果（同 Vue 的
 * ctxToScope）：`<script setup>` 可以直接引用普通 `<script>` 里声明的类型。
 */
function resolveDeclarations(
  script: string,
  ast: BabelNode,
  statements: Node[],
  filename: string,
): ResolveOutcome {
  const declarations: RuntimeDeclarations = {}
  const { propsTypeDecl, emitsTypeDecl, propsRuntimeDefaults, propsDestructuredBindings }
    = collectMacroDeclarations(ast)
  if (!propsTypeDecl && !emitsTypeDecl)
    return { declarations }

  const helpers: string[] = []
  const ctx: SimpleTypeResolveContext = {
    filename,
    source: script,
    options: {},
    ast: statements as SimpleTypeResolveContext['ast'],
    isCE: false,
    error(message: string, node?: Node): never {
      const start = node?.loc?.start
      throw new Error(start ? `${message}（${start.line}:${start.column + 1}）` : message)
    },
    warn() {},
    helper(key: string) {
      helpers.push(key)
      return `${HELPER_PREFIX}${key}`
    },
    getString(node: Node) {
      return script.slice(node.start ?? 0, node.end ?? 0)
    },
    propsTypeDecl: propsTypeDecl as never,
    propsRuntimeDefaults: propsRuntimeDefaults as never,
    propsDestructuredBindings,
    emitsTypeDecl: emitsTypeDecl as never,
    fs: {
      fileExists: file => fs.existsSync(file),
      readFile: file => fs.readFileSync(file, 'utf-8'),
    },
  }

  try {
    if (propsTypeDecl) {
      const props = extractRuntimeProps(ctx)
      if (props)
        declarations.props = props
    }
    if (emitsTypeDecl)
      declarations.emits = `[${[...extractRuntimeEmits(ctx)].map(name => JSON.stringify(name)).join(', ')}]`
    if (helpers.length)
      declarations.helpers = [...new Set(helpers)]
    return { declarations }
  }
  catch (error) {
    return { declarations, error: (error as Error).message }
  }
}

/** 宏调用的替换文本 */
function replacementFor(call: MacroCall, runtime: RuntimeDeclarations): string {
  if (call.name === 'defineEmits')
    return `defineEmits(${runtime.emits ?? '[]'})`
  // withDefaults 也换成 defineProps：默认值已合进 props 里
  return `defineProps(${runtime.props ?? '{}'})`
}

/** 把宏调用替换成运行时声明，并按需补上 helper 的导入 */
function applyMacroRewrites(content: string, calls: MacroCall[], runtime: RuntimeDeclarations): string {
  let result = content
  for (const call of [...calls].sort((a, b) => b.start - a.start))
    result = result.slice(0, call.start) + replacementFor(call, runtime) + result.slice(call.end)

  if (runtime.helpers?.length) {
    // helper 只出现在这里生成的声明里，下游 Vue 看不到它的来源，必须由插件导入
    const leading = /^\s*/.exec(result)?.[0] ?? ''
    const specifiers = runtime.helpers.map(key => `${key} as ${HELPER_PREFIX}${key}`).join(', ')
    result = `${leading}import { ${specifiers} } from 'vue'\n${result.slice(leading.length)}`
  }
  return result
}

/**
 * 把 `<script setup>` 里类型宏（`defineProps<T>()` 等）的运行时声明回填到原宏调用处。
 *
 * 这些声明只存在于类型里，类型擦除后会丢失，因此先用官方的
 * `extractRuntimeProps` / `extractRuntimeEmits` 生成运行时声明再回填。
 *
 * 普通 `<script>` 块的语句一并带上：`<script setup>` 可以引用那里声明的类型
 * （两个块共享作用域，与 Vue 的处理一致）。
 *
 * 类型解析失败时抛错中断构建：此时生成的声明无法确定，继续下去会把「没有 props 声明」的
 * 组件发进产物（props 静默退化成 attrs，运行期才发现），不如让构建失败并给出原因。
 * 脚本本身有语法错误时不处理，交给后续的类型擦除报错（那里有更准确的定位）。
 */
export function rewriteTypeMacros(
  block: SFCScriptBlock,
  scriptBlock: SFCScriptBlock | null | undefined,
  tsx: boolean,
  filename: string,
): string {
  const script = block.content
  let ast: BabelNode
  try {
    ast = parseScript(script, tsx)
  }
  catch {
    return script
  }

  const calls = collectMacroCalls(ast)
  if (!calls.length)
    return script

  // 普通 <script> 的类型声明也要参与解析：`<script setup>` 里可以直接引用它
  const statements: Node[] = []
  if (scriptBlock && !scriptBlock.src) {
    try {
      statements.push(...(parseScript(scriptBlock.content, tsx).program?.body ?? []) as unknown as Node[])
    }
    catch {
      // 普通 <script> 语法有问题：交给后续的类型擦除报错
    }
  }
  statements.push(...(ast.program?.body ?? []) as unknown as Node[])

  ensureTsRegistered()
  const outcome = resolveDeclarations(script, ast, statements, filename)
  if (outcome.error) {
    throw new Error(
      `${filename} 的类型宏解析失败，无法生成 defineProps / defineEmits 的运行时声明：${outcome.error}\n`
      + '请修正类型引用（相对路径、tsconfig 的 paths，或安装 typescript），或改用运行时声明 defineProps({ ... }) / defineEmits([...])。',
    )
  }
  return applyMacroRewrites(script, calls, outcome.declarations)
}
