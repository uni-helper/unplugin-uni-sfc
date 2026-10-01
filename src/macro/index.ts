import type { SFCDescriptor } from '@vue/compiler-sfc'
import type { BabelNode } from '../babel'
import type { Warn } from '../types'
import fs from 'node:fs'
import { compileScript } from '@vue/compiler-sfc'
import { parseScript, walkNode } from '../babel'

export interface RuntimeDeclarations {
  props?: string
  emits?: string
}

export interface MacroCall {
  name: 'defineProps' | 'defineEmits' | 'withDefaults'
  start: number
  end: number
}

/**
 * 找出 `<script setup>` 中需要回填运行时声明的宏调用：
 * 带类型参数的 `defineProps<T>()` / `defineEmits<T>()`，以及 `withDefaults(...)`
 */
export function collectMacroCalls(ast: BabelNode): MacroCall[] {
  const calls: MacroCall[] = []
  walkNode(ast, (node) => {
    if (node.type !== 'CallExpression' || node.callee?.type !== 'Identifier')
      return
    const name = node.callee.name
    if (name !== 'defineProps' && name !== 'defineEmits' && name !== 'withDefaults')
      return
    if (name === 'withDefaults' || node.typeParameters || node.typeArguments)
      calls.push({ name, start: node.start, end: node.end })
  })
  // withDefaults 内部还有一次 defineProps 调用，外层替换后内层要被丢弃
  return calls.filter(call =>
    !calls.some(other => other !== call && other.start <= call.start && other.end >= call.end),
  )
}

function propertyName(property: BabelNode): string | undefined {
  const key = property.key
  if (!key)
    return
  if (key.type === 'Identifier')
    return key.name
  const { value } = key as unknown as { value?: unknown }
  return typeof value === 'string' ? value : undefined
}

/**
 * 从 `compileScript` 的产物中取出 `props` / `emits` 的运行时声明源码
 */
export function extractRuntimeDeclarations(generated: string, tsx: boolean): RuntimeDeclarations {
  const file = parseScript(generated, tsx)
  const program = file.program ?? file
  const exported = program.body?.find(node => node.type === 'ExportDefaultDeclaration')?.declaration
  const options = exported?.type === 'ObjectExpression'
    ? exported
    : exported?.type === 'CallExpression' ? exported.arguments?.[0] : undefined
  if (options?.type !== 'ObjectExpression')
    return {}

  const result: RuntimeDeclarations = {}
  for (const property of options.properties ?? []) {
    if (property.type !== 'ObjectProperty' || !property.value)
      continue
    const name = propertyName(property)
    if (name === 'props' || name === 'emits')
      result[name] = generated.slice(property.value.start, property.value.end)
  }
  return result
}

/**
 * 类型宏（`defineProps<T>()` 等）的运行时声明只存在于类型里，类型擦除后会丢失，
 * 因此用 `compileScript` 编译一次，把生成的 props / emits 运行时对象回填到原宏调用处。
 * 编译失败（例如解析不了外部类型）时返回 null，由调用方降级为纯类型擦除。
 */
export function resolveRuntimeDeclarations(
  descriptor: SFCDescriptor,
  filename: string,
  tsx: boolean,
  warn?: Warn,
): RuntimeDeclarations | null {
  try {
    const { content } = compileScript(descriptor, {
      id: filename,
      fs: {
        fileExists: file => fs.existsSync(file),
        readFile: file => fs.readFileSync(file, 'utf-8'),
      },
    })
    return extractRuntimeDeclarations(content, tsx)
  }
  catch (error) {
    warn?.(`解析 ${filename} 的类型宏失败，defineProps<T>() / defineEmits<T>() 的运行时声明将丢失：${(error as Error).message}`)
    return null
  }
}

export function applyMacroRewrites(content: string, calls: MacroCall[], runtime: RuntimeDeclarations): string {
  let result = content
  for (const call of [...calls].sort((a, b) => b.start - a.start)) {
    const replacement = call.name === 'defineEmits'
      ? `defineEmits(${runtime.emits ?? '[]'})`
      : `defineProps(${runtime.props ?? '{}'})`
    result = result.slice(0, call.start) + replacement + result.slice(call.end)
  }
  return result
}
