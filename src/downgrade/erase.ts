import type { BabelNode } from '../babel'
import type { Edit } from '../shared'
import { parseScript } from '../babel'

/**
 * TS 擦除：把 TypeScript 独有的语法从 AST 上定位出来，产出「纯删除」区间。
 *
 * 与直接调用 `oxc-transform` 的区别在于：这里不重新打印代码，只删除区间。
 * 代码的其余部分——注释、格式、以及条件编译指令——逐字节保持原样。
 * 这正是「保留指令」的前提：指令是注释，只要不经过打印器就不会被吞掉或搬走。
 *
 * 少量构造无法靠删除得到正确 JS（enum、namespace、构造器参数属性等），
 * 由调用方对这些区域整体重写，见 `findGenerativeNode`。
 */

/**
 * 需要「代码生成」而不是删除的构造：删掉它们会改变运行结果（enum 会失去运行时对象、
 * 构造器参数属性会丢掉赋值），必须交给真正的 TS 转换器处理。
 */
const GENERATIVE_TYPES = new Set([
  'TSEnumDeclaration',
  'TSModuleDeclaration',
  'TSParameterProperty',
  'TSImportEqualsDeclaration',
  'TSExportAssignment',
  'TSNamespaceExportDeclaration',
  'Decorator',
  'TSAbstractMethodDefinition',
  'TSAbstractPropertyDefinition',
])

/** 整个节点都是 TS 语法，直接删除；引用它们的外层导出语句也要一并删除 */
const TS_ONLY_DECLARATIONS = new Set([
  'TSInterfaceDeclaration',
  'TSTypeAliasDeclaration',
  'TSDeclareFunction',
  'TSImportEqualsDeclaration',
  'TSNamespaceExportDeclaration',
  'TSEnumDeclaration',
  'TSModuleDeclaration',
])

/** 已经是表达式的一部分，只需删除 TS 那一段 */
const EXPRESSION_WRAPPERS: Record<string, 'after' | 'before'> = {
  TSAsExpression: 'after',
  TSSatisfiesExpression: 'after',
  TSNonNullExpression: 'after',
  TSInstantiationExpression: 'after',
  TSTypeAssertion: 'before',
}

const MODIFIER_FIELDS = [
  'typeAnnotation',
  'returnType',
  'typeParameters',
  'typeArguments',
  'superTypeParameters',
  'superTypeArguments',
] as const

/** 只在类型里成立的类成员修饰符，产物里必须去掉；static / async / get / set / accessor 是 JS 语法，保留 */
const CLASS_MEMBER_MODIFIER_RE = /\b(?:public|private|protected|readonly|override)\b[ \t]*/g

const FUNCTION_NODES = new Set([
  'FunctionDeclaration',
  'FunctionExpression',
  'ArrowFunctionExpression',
  'ObjectMethod',
  'ClassMethod',
  'ClassPrivateMethod',
  'TSDeclareFunction',
  'TSEmptyBodyFunctionExpression',
])

const CLASS_MEMBER_NODES = new Set([
  'ClassProperty',
  'ClassPrivateProperty',
  'PropertyDefinition',
  'ClassAccessorProperty',
  'ClassMethod',
  'ClassPrivateMethod',
  'ClassPropertyDefinition',
  'TSAbstractPropertyDefinition',
  'TSAbstractMethodDefinition',
])

export interface ParseOptions {
  tsx?: boolean
}

/**
 * 解析 TS 源码。
 *
 * `tolerant` 打开 babel 的错误恢复：互斥分支里的同名声明（`#ifdef H5` 与 `#ifndef H5` 各写一次
 * `const platform`）在原文里是重复声明，但每个平台投影里只会剩一处，是合法代码。
 * 关闭恢复时这类输入会直接抛错，拿不到 AST。
 */
export function parseTs(code: string, options: ParseOptions & { tolerant?: boolean } = {}): BabelNode {
  return parseScript(code, !!options.tsx, !!options.tolerant)
}

/** 遍历时统一跳过的字段：位置、父引用（自己挂的，会成环）、注释缓存 */
const SKIP_KEYS = new Set(['loc', '__parent', 'leadingComments', 'trailingComments', 'innerComments', 'extra'])

/** 找到第一个需要代码生成的构造 */
export function findGenerativeNode(ast: BabelNode): BabelNode | undefined {
  let found: BabelNode | undefined
  const visit = (node: unknown): void => {
    if (found || !node || typeof node !== 'object')
      return
    if (Array.isArray(node)) {
      for (const item of node) {
        visit(item)
        if (found)
          return
      }
      return
    }
    const record = node as BabelNode
    if (typeof record.type !== 'string')
      return
    if (GENERATIVE_TYPES.has(record.type)) {
      found = record
      return
    }
    for (const [key, value] of Object.entries(record)) {
      if (SKIP_KEYS.has(key))
        continue
      visit(value)
      if (found)
        return
    }
  }
  visit(ast)
  return found
}

/** 擦除后是否仍残留 TS 语法；用于产出前的兜底校验 */
export function hasTsSyntax(ast: BabelNode): boolean {
  let found = false
  const visit = (node: unknown): void => {
    if (found || !node || typeof node !== 'object')
      return
    if (Array.isArray(node)) {
      for (const item of node) {
        visit(item)
        if (found)
          return
      }
      return
    }
    const record = node as BabelNode
    if (typeof record.type !== 'string')
      return
    if (record.type.startsWith('TS') || record.type === 'Decorator') {
      found = true
      return
    }
    for (const [key, value] of Object.entries(record)) {
      if (SKIP_KEYS.has(key))
        continue
      visit(value)
      if (found)
        return
    }
  }
  visit(ast)
  return found
}

interface Collector {
  code: string
  edits: Edit[]
}

function deleteRange(collector: Collector, start: unknown, end: unknown): void {
  if (typeof start !== 'number' || typeof end !== 'number' || end <= start)
    return
  collector.edits.push({ start, end, text: '' })
}

/**
 * 删除列表里的一项，连同分隔用的逗号：优先吃掉它后面的逗号，最后一项则吃掉前面的。
 * 直接删区间会留下 `{ , b }` 这样的非法语法。
 */
function deleteListItem(collector: Collector, item: BabelNode, items: BabelNode[]): void {
  const index = items.indexOf(item)
  if (index < 0) {
    deleteRange(collector, item.start, item.end)
    return
  }
  const next = items[index + 1]
  const previous = items[index - 1]
  if (next)
    deleteRange(collector, item.start, next.start)
  else if (previous)
    deleteRange(collector, previous.end, item.end)
  else
    deleteRange(collector, item.start, item.end)
}

/** 在 [from, to) 里找一个标记字符；找不到返回 -1 */
function findMarker(code: string, from: number, to: number, marker: string): number {
  const index = code.indexOf(marker, from)
  return index >= 0 && index < to ? index : -1
}

/** 函数参数的 TS 修饰：`this` 参数、可选标记 `?` */
function collectParamEdits(collector: Collector, params: BabelNode[]): void {
  for (const param of params) {
    const paramRecord = param as unknown as Record<string, unknown>
    const annotation = paramRecord.typeAnnotation as BabelNode | undefined
    if (param.type === 'Identifier' && param.name === 'this') {
      deleteListItem(collector, param, params)
      continue
    }
    if (param.type !== 'Identifier' || paramRecord.optional !== true)
      continue
    // `a?: number` 里的 `?` 在参数名之后、类型注解之前
    const from = param.start + (param.name?.length ?? 0)
    const to = annotation?.start ?? param.end
    const at = findMarker(collector.code, from, to, '?')
    if (at >= 0)
      deleteRange(collector, at, at + 1)
  }
}

/** 类成员上的 TS 修饰：`declare` / `abstract` 成员整体删除，其余修饰符逐个删掉 */
function collectClassMemberEdits(collector: Collector, member: BabelNode, body: BabelNode[]): void {
  const record = member as unknown as Record<string, unknown>
  const keyStart = (member.key as BabelNode | undefined)?.start

  // `declare x: number` 只是类型声明，产物里不该出现
  if (record.declare === true || member.type === 'TSAbstractMethodDefinition' || member.type === 'TSAbstractPropertyDefinition') {
    deleteListItem(collector, member, body)
    return
  }
  // 抽象方法 / 重载签名没有函数体，产物里同样不该出现
  if ((member.type === 'ClassMethod' || member.type === 'ClassPrivateMethod') && !record.body) {
    deleteListItem(collector, member, body)
    return
  }

  if (typeof keyStart === 'number') {
    const header = collector.code.slice(member.start, keyStart)
    for (const match of header.matchAll(CLASS_MEMBER_MODIFIER_RE))
      deleteRange(collector, member.start + match.index, member.start + match.index + match[0].length)
  }

  // 可选标记 `?` 与明确赋值断言 `!`，都在键名之后、类型注解或初始值之前
  if (record.optional === true || record.definite === true) {
    const from = (member.key as BabelNode | undefined)?.end
    const to = (record.typeAnnotation as BabelNode | undefined)?.start
      ?? (record.value as BabelNode | undefined)?.start
      ?? member.end
    if (typeof from === 'number') {
      for (const marker of ['?', '!']) {
        const at = findMarker(collector.code, from, to, marker)
        if (at >= 0)
          deleteRange(collector, at, at + 1)
      }
    }
  }
}

/** 类声明上的 TS 修饰：`declare` 整体删除，`abstract` / `implements` / 类型参数逐个删掉 */
function collectClassEdits(collector: Collector, node: BabelNode, statementList?: BabelNode[]): void {
  const record = node as unknown as Record<string, unknown>
  const idStart = (node.id as BabelNode | undefined)?.start ?? node.start
  const body = node.body as BabelNode | undefined

  if (record.declare === true) {
    if (statementList)
      deleteListItem(collector, node, statementList)
    else
      deleteRange(collector, node.start, node.end)
    return
  }

  if (record.abstract === true) {
    const header = collector.code.slice(node.start, idStart)
    const match = /\babstract\b[ \t]*/.exec(header)
    if (match)
      deleteRange(collector, node.start + match.index, node.start + match.index + match[0].length)
  }

  const implementsList = record.implements as BabelNode[] | undefined
  if (implementsList?.length && body) {
    // `implements C, D` 连同关键字一起删到类体之前
    const first = implementsList[0]
    const keyword = collector.code.lastIndexOf('implements', first.start)
    if (keyword >= 0 && keyword < body.start)
      deleteRange(collector, keyword, body.start)
  }
}

/** 导入 / 导出语句里的类型部分 */
function collectModuleEdits(collector: Collector, node: BabelNode): boolean {
  const record = node as unknown as Record<string, unknown>
  const specifiers = (record.specifiers ?? []) as BabelNode[]

  // `import type { A } from 'a'` / `export type { B }`：整句都是类型
  if (record.importKind === 'type' || record.exportKind === 'type') {
    deleteRange(collector, node.start, node.end)
    return true
  }

  const declaration = record.declaration as BabelNode | undefined
  if (declaration && (TS_ONLY_DECLARATIONS.has(declaration.type) || (declaration as unknown as Record<string, unknown>).declare === true)) {
    // `export interface X {}` / `export declare const x` 整体删除，否则会留下悬空的 `export`
    deleteRange(collector, node.start, node.end)
    return true
  }

  for (const specifier of specifiers) {
    const specifierRecord = specifier as unknown as Record<string, unknown>
    if (specifierRecord.importKind === 'type' || specifierRecord.exportKind === 'type')
      deleteListItem(collector, specifier, specifiers)
  }
  return false
}

function visitNode(collector: Collector, node: unknown): void {
  if (!node || typeof node !== 'object')
    return
  if (Array.isArray(node)) {
    for (const item of node)
      visitNode(collector, item)
    return
  }
  const current = node as BabelNode
  if (typeof current.type !== 'string')
    return
  const record = current as unknown as Record<string, unknown>

  // 需要代码生成的构造不在这里处理：整个区域会交给 TS 转换器重写
  if (GENERATIVE_TYPES.has(current.type))
    return

  // import / export 语句可能需要带走整句，先处理
  if (current.type === 'ImportDeclaration' || current.type === 'ExportNamedDeclaration' || current.type === 'ExportAllDeclaration') {
    if (collectModuleEdits(collector, current))
      return
  }
  else if (TS_ONLY_DECLARATIONS.has(current.type)) {
    deleteRange(collector, current.start, current.end)
    return
  }
  else if (current.type === 'VariableDeclaration' && record.declare === true) {
    deleteRange(collector, current.start, current.end)
    return
  }
  else if (current.type === 'TSIndexSignature' || current.type === 'TSCallSignatureDeclaration'
    || current.type === 'TSConstructSignatureDeclaration' || current.type === 'TSPropertySignature'
    || current.type === 'TSMethodSignature' || current.type === 'TSDeclareMethod') {
    deleteRange(collector, current.start, current.end)
    return
  }

  // `x as T` / `x satisfies T` / `x!` / `<T>x`：只删 TS 那一段，保留表达式
  const wrapper = EXPRESSION_WRAPPERS[current.type]
  if (wrapper) {
    const expression = record.expression as BabelNode | undefined
    if (expression) {
      if (wrapper === 'after')
        deleteRange(collector, expression.end, current.end)
      else
        deleteRange(collector, current.start, expression.start)
      visitNode(collector, expression)
    }
    return
  }

  if (current.type === 'ClassDeclaration' || current.type === 'ClassExpression')
    collectClassEdits(collector, current)

  if (CLASS_MEMBER_NODES.has(current.type)) {
    const parent = (current as unknown as { __parent?: BabelNode }).__parent
    const parentBody = parent ? ((parent.body as BabelNode | undefined)?.body as BabelNode[] | undefined) : undefined
    collectClassMemberEdits(collector, current, parentBody ?? [])
  }

  // 通用：类型注解、返回类型、泛型参数一律删除
  for (const field of MODIFIER_FIELDS)
    deleteRange(collector, (record[field] as BabelNode | undefined)?.start, (record[field] as BabelNode | undefined)?.end)

  if (FUNCTION_NODES.has(current.type) && Array.isArray(record.params))
    collectParamEdits(collector, record.params as BabelNode[])

  for (const [key, value] of Object.entries(record)) {
    if (key === 'loc' || key === '__parent' || key === 'leadingComments' || key === 'trailingComments' || key === 'innerComments' || key === 'extra')
      continue
    // 上面已经单独处理过的字段不再递归
    if ((MODIFIER_FIELDS as readonly string[]).includes(key))
      continue
    visitNode(collector, value)
  }
}

/** 给节点挂上父引用，类成员的删除需要知道自己在哪个列表里 */
function attachParents(node: unknown, parent?: BabelNode): void {
  if (!node || typeof node !== 'object')
    return
  if (Array.isArray(node)) {
    for (const item of node)
      attachParents(item, parent)
    return
  }
  const current = node as BabelNode
  if (typeof current.type !== 'string')
    return
  if (parent)
    (current as unknown as { __parent?: BabelNode }).__parent = parent
  for (const [key, value] of Object.entries(current)) {
    if (key === 'loc' || key === '__parent')
      continue
    attachParents(value, current)
  }
}

/**
 * 收集把这段 TS 擦成 JS 所需的删除区间。
 *
 * 区间之间可能重叠（`export interface` 会先删整句、里面的成员又各删一次），
 * 调用方用 `mergeEdits` 合并后再应用。
 */
export function collectErasureEdits(ast: BabelNode, code: string): Edit[] {
  attachParents(ast)
  const collector: Collector = { code, edits: [] }
  visitNode(collector, ast)
  return collector.edits
}

/** 合并重叠区间；全部是删除，直接取并集即可 */
export function mergeEdits(edits: Edit[]): Edit[] {
  const sorted = [...edits].sort((a, b) => a.start - b.start || a.end - b.end)
  const merged: Edit[] = []
  for (const edit of sorted) {
    const last = merged[merged.length - 1]
    if (last && edit.start <= last.end)
      last.end = Math.max(last.end, edit.end)
    else
      merged.push({ ...edit })
  }
  return merged
}

/** 区间是否与给定区间相交 */
export function intersects(ranges: Array<{ start: number, end: number }>, start: number, end: number): boolean {
  return ranges.some(range => start < range.end && end > range.start)
}
