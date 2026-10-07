import type { SFCBlock, SFCDescriptor } from '@vue/compiler-sfc'
import type { BabelNode } from '../babel'
import { importSourceLiteral, parseScript, walkNode } from '../babel'

/** .vue 中对其它模块的引用：specifier，以及它在整份源码中的字符串字面量区间（含引号） */
export interface ModuleReference {
  specifier: string
  start: number
  end: number
  /** 仅副作用 import（`import './x.less'`）才有：整个 import 语句的区间，供产物移除整句（见 generateBundle 的纯样式 chunk 处理） */
  statement?: { start: number, end: number }
}

function parseBlock(content: string, jsx: boolean): BabelNode | undefined {
  try {
    return parseScript(content, jsx)
  }
  catch {
    return undefined
  }
}

function collectFromBlock(block: SFCBlock, references: Map<number, ModuleReference>): void {
  // 脚本已经降级成 JS，但仍可能保留 JSX（`lang="tsx"` 的产物），两种语法都试一次
  const ast = parseBlock(block.content, true) ?? parseBlock(block.content, false)
  if (!ast)
    return

  const offset = block.loc.start.offset
  walkNode(ast, (node) => {
    const literal = importSourceLiteral(node)
    if (!literal)
      return
    const start = offset + literal.start
    // 同一个字面量只记一次；产物里的引用按位置替换，重复的 specifier 互不影响
    references.set(start, {
      specifier: literal.value,
      start,
      end: offset + literal.end,
      // 纯副作用的 import（`import './x.less'`，没有绑定值）额外记下整句区间：
      // 样式类引用的内容会被 CSS 管线抽走，产物里需要移除整句而不是改写字面量
      statement: node.type === 'ImportDeclaration' && !node.specifiers?.length
        ? { start: offset + node.start, end: offset + node.end }
        : undefined,
    })
  })
}

/**
 * 收集 SFC 脚本里引用的模块：import、export-from、动态 import、require。
 * 区间是相对整份源码的绝对偏移；模板与样式里的引用不在此列。
 * 脚本有语法错误时交给打包工具报错。
 *
 * 取 descriptor 而不是源码，是为了让调用方和 JS 视图共用同一次 `parse`（见 view/index.ts）。
 */
export function collectReferences(descriptor: SFCDescriptor): ModuleReference[] {
  const references = new Map<number, ModuleReference>()
  for (const block of [descriptor.script, descriptor.scriptSetup]) {
    if (block && !block.src)
      collectFromBlock(block, references)
  }
  return [...references.values()]
}
