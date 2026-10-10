import { parse as babelParse } from '@babel/parser'

export interface BabelNode {
  type: string
  start: number
  end: number
  name?: string
  body?: BabelNode[]
  program?: BabelNode
  declaration?: BabelNode
  arguments?: BabelNode[]
  properties?: BabelNode[]
  specifiers?: BabelNode[]
  /** import / export-from / 动态 import / require 引用的模块 */
  source?: BabelNode | null
  key?: BabelNode
  value?: BabelNode
  callee?: BabelNode
  typeParameters?: BabelNode | null
  typeArguments?: BabelNode | null
  /** 类型实参 / 函数参数等按位置排列的子节点 */
  params?: BabelNode[]
  /** 变量声明的绑定目标（`const <id> = <init>`） */
  id?: BabelNode
  /** 变量声明的初始值 */
  init?: BabelNode
  /** 赋值模式的两侧（`a = 1`） */
  left?: BabelNode
  right?: BabelNode
}

export function isBabelNode(value: unknown): value is BabelNode {
  return !!value && typeof value === 'object' && typeof (value as BabelNode).type === 'string'
}

/**
 * 解析脚本内容。
 *
 * `tolerant` 打开 babel 的错误恢复：保留条件编译指令的源码里，
 * 互斥分支的同名声明（`#ifdef H5` 与 `#ifndef H5` 各写一次 `const platform`）在合并文本中
 * 属于重复声明，但在每个平台的实际投影里只会剩一处，是合法的。
 * 打开恢复后仍能拿到完整 AST，且各节点区间准确；调用方再用「等长投影」逐平台校验。
 * 注意恢复模式下语法错误只记录在 `ast.errors` 里，需要调用方自行判断。
 */
export function parseScript(content: string, tsx: boolean, tolerant = false): BabelNode {
  return babelParse(content, {
    sourceType: 'module',
    errorRecovery: tolerant,
    plugins: tsx ? ['typescript', 'jsx'] : ['typescript'],
  }) as unknown as BabelNode
}

export interface SourceLiteral {
  value: string
  start: number
  end: number
}

/** 节点引用的模块名字面量：import / export-from / 动态 import / require 的源，区间含引号 */
export function importSourceLiteral(node: BabelNode): SourceLiteral | undefined {
  let source: BabelNode | null | undefined
  if (
    node.type === 'ImportDeclaration'
    || node.type === 'ExportNamedDeclaration'
    || node.type === 'ExportAllDeclaration'
    || node.type === 'ImportExpression'
  ) {
    source = node.source
  }
  else if (node.type === 'CallExpression' && node.callee?.type === 'Identifier' && node.callee.name === 'require') {
    source = node.arguments?.[0]
  }

  if (!source || source.type !== 'StringLiteral')
    return
  const { value } = source as unknown as { value?: string }
  return typeof value === 'string' ? { value, start: source.start, end: source.end } : undefined
}

export function walkNode(node: BabelNode, visit: (node: BabelNode) => void): void {
  visit(node)
  for (const value of Object.values(node)) {
    if (Array.isArray(value))
      value.forEach(item => isBabelNode(item) && walkNode(item, visit))
    else if (isBabelNode(value))
      walkNode(value, visit)
  }
}
