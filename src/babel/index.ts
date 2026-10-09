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

export function parseScript(content: string, tsx: boolean): BabelNode {
  return babelParse(content, {
    sourceType: 'module',
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
