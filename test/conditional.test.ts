import type { BabelNode } from '../src/babel'
import type { PlatformContext } from '../src/conditional'
import { transformSync } from 'oxc-transform'
import { describe, expect, it } from 'vitest'
import { parseScript } from '../src/babel'
import {
  analyzeConditional,
  buildContexts,
  isRegionLive,
  PLATFORMS,
  project,
} from '../src/conditional'
import { downgradeSFC } from '../src/downgrade'
import { downgradeScriptContent } from '../src/downgrade/script'

/**
 * 条件编译的核心不变量：
 *
 *   对任意平台 p，`transform(project(产物, p))` 必须等于 `transform(project(源码, p))`
 *
 * 也就是说：产物在每个平台的实际投影下，都必须是正确的、等价的 JavaScript。
 * 指令本身则必须逐条逐字节原样保留。
 */

const SCRIPT_FORMS = ['line', 'block'] as const

/** 用下游真正会用的转换器做基准，避免测试自己实现一套擦除而与实现一起犯错 */
function transform(code: string): string {
  const result = transformSync('probe.ts', code, {
    lang: 'ts',
    typescript: { onlyRemoveTypeImports: true, allowNamespaces: true },
  })
  const fatal = result.errors.filter(error => (error.severity as string) === 'Error')
  if (fatal.length)
    throw new Error(fatal.map(error => error.message).join('; '))
  return result.code
}

function normalize(code: string): string {
  return code.replace(/[ \t]+$/gm, '').replace(/\n{2,}/g, '\n').trim()
}

/** 源码与产物里的指令序列 */
function directivesOf(code: string): string[] {
  return [...code.matchAll(/^[ \t]*(?:(?:\/\/|\/\*)[ \t]*|<!--[ \t]*)#(?:ifdef|ifndef|if|elif|else|endif)\b[^\n]*$/gm)]
    .map(match => match[0])
}

/** 去掉指令行后的文本（保留其余内容与偏移） */
function withoutDirectives(code: string): string {
  return code
    .split('\n')
    .filter(line => !/^[ \t]*(?:(?:\/\/|\/\*)[ \t]*|<!--[ \t]*)#(?:ifdef|ifndef|if|elif|else|endif)\b/.test(line))
    .join('\n')
}

interface EquivalenceReport {
  /** 指令逐条一致 */
  directivesIntact: boolean
  /** 逐平台比对的结果；ok 为 false 时带上两边的实际输出 */
  results: Array<{ platform: string, ok: boolean, actual?: string, expected?: string }>
}

/** 校验「产物在每个平台的投影下都等于源码的该平台投影」 */
function checkEquivalence(source: string, artifact: string, forms: readonly string[] = SCRIPT_FORMS): EquivalenceReport {
  const before = directivesOf(source)
  const after = directivesOf(artifact)
  const directivesIntact = before.length === after.length && before.every((item, index) => item === after[index])

  const contexts: PlatformContext[] = buildContexts(
    analyzeConditional(source, { forms: [...forms] as never }),
    { uniVersion: 3 },
  )
  const results: EquivalenceReport['results'] = []
  const seen = new Set<string>()
  for (const context of contexts) {
    const sourceAnalysis = analyzeConditional(source, { forms: [...forms] as never })
    const artifactAnalysis = analyzeConditional(artifact, { forms: [...forms] as never })
    const signature = artifactAnalysis.regions.map(region => (isRegionLive(region, context.values) ? '1' : '0')).join('')
    const sourceSignature = sourceAnalysis.regions.map(region => (isRegionLive(region, context.values) ? '1' : '0')).join('')
    const key = `${sourceSignature}|${signature}`
    if (seen.has(key))
      continue
    seen.add(key)

    const expectedInput = withoutDirectives(project(source, sourceAnalysis, context.values))
    const actualInput = withoutDirectives(project(artifact, artifactAnalysis, context.values))
    let expected: string
    let actual: string
    try {
      expected = normalize(transform(expectedInput))
    }
    catch (error) {
      // 源码在该平台下本来就不是合法 TS：只要产物同样报错（或同样解析不了）就算通过
      try {
        actual = normalize(transform(actualInput))
        results.push({ platform: context.platform, ok: false, actual, expected: `<<源码不合法：${(error as Error).message}>>` })
      }
      catch {
        results.push({ platform: context.platform, ok: true })
      }
      continue
    }
    try {
      actual = normalize(transform(actualInput))
    }
    catch (error) {
      results.push({ platform: context.platform, ok: false, actual: `<<产物不合法：${(error as Error).message}>>`, expected })
      continue
    }
    results.push({ platform: context.platform, ok: actual === expected, actual, expected })
  }
  return { directivesIntact, results }
}

function expectEquivalent(source: string, artifact: string, label: string): void {
  const report = checkEquivalence(source, artifact)
  expect(report.directivesIntact, `${label}：条件编译指令被改动了`).toBe(true)
  const failed = report.results.filter(item => !item.ok)
  expect(
    failed,
    `${label}：以下平台的投影不等价\n${failed.map(item => `[${item.platform}]\n  产物: ${item.actual}\n  期望: ${item.expected}`).join('\n')}`,
  ).toEqual([])
  expect(report.results.length, `${label}：没有比对任何平台`).toBeGreaterThan(0)
}

function downgrade(source: string, label = '<script setup>'): string {
  return downgradeScriptContent(source, { filename: 'App.vue', tsx: false, label })
}

describe('条件编译：指令原样保留', () => {
  it('script 里的指令逐条保留，同时擦除 TS', () => {
    const source = [
      `const name: string = 'conditional'`,
      `// #ifdef H5`,
      `const platform: string = 'h5'`,
      `// #endif`,
    ].join('\n')
    const artifact = downgrade(source)

    expect(artifact).toBe([
      `const name = 'conditional'`,
      `// #ifdef H5`,
      `const platform = 'h5'`,
      `// #endif`,
    ].join('\n'))
    expectEquivalent(source, artifact, 'script')
  })

  it('互斥分支里的同名声明不会让降级失败', () => {
    // 合并文本里 `platform` 声明了两次，但任一平台的投影里只有一处，是合法代码
    const source = [
      `// #ifdef H5`,
      `const platform: string = 'h5'`,
      `// #endif`,
      `// #ifndef H5`,
      `const platform: string = 'mp'`,
      `// #endif`,
    ].join('\n')
    const artifact = downgrade(source)

    expect(directivesOf(artifact)).toEqual(directivesOf(source))
    expect(artifact).toContain(`const platform = 'h5'`)
    expect(artifact).toContain(`const platform = 'mp'`)
    expect(artifact).not.toContain(': string')
    expectEquivalent(source, artifact, '互斥分支同名声明')
  })

  it('指令写在对象字面量内部时也原样保留', () => {
    // oxc 的打印器会吞掉字面量内部的注释，这类位置必须走「只删区间」的擦除路径
    const source = [
      `const config: Record<string, unknown> = {`,
      `  deep: true as boolean,`,
      `  // #ifdef APP-PLUS`,
      `  plus: 1 as number,`,
      `  // #endif`,
      `}`,
      `export const c = config`,
    ].join('\n')
    const artifact = downgrade(source)

    expect(artifact).toContain('// #ifdef APP-PLUS')
    expect(artifact).toContain('// #endif')
    expect(artifact).toContain('deep: true,')
    expect(artifact).toContain('plus: 1,')
    expectEquivalent(source, artifact, '对象字面量内部')
  })

  it('指令写在数组与函数参数内部时也原样保留', () => {
    const source = [
      `const list: number[] = [`,
      `  1,`,
      `  // #ifdef H5`,
      `  2,`,
      `  // #endif`,
      `]`,
      `function f(a: string, b?: number): string { return a }`,
      `export { list, f }`,
    ].join('\n')
    const artifact = downgrade(source)

    expect(artifact).toContain('// #ifdef H5')
    expect(artifact).toContain('// #endif')
    expectEquivalent(source, artifact, '数组内部')
  })

  it('嵌套与 #else 分支里的 TS 都会被擦除', () => {
    const source = [
      `// #ifdef H5`,
      `// #ifdef VUE3`,
      `export const v: number = 3`,
      `// #else`,
      `export const v: number = 2`,
      `// #endif`,
      `// #endif`,
      `export const tail: string = 'x'`,
    ].join('\n')
    const artifact = downgrade(source)

    expect(directivesOf(artifact)).toEqual(directivesOf(source))
    expect(artifact).not.toContain(': number')
    expect(artifact).not.toContain(': string')
    expectEquivalent(source, artifact, '嵌套 #else')
  })

  it('块注释形式的指令同样保留', () => {
    const source = [
      `/* #ifdef H5 */`,
      `export const v: number = 1`,
      `/* #endif */`,
    ].join('\n')
    const artifact = downgrade(source)

    expect(artifact).toContain('/* #ifdef H5 */')
    expect(artifact).toContain('/* #endif */')
    expect(artifact).not.toContain(': number')
    expectEquivalent(source, artifact, '块注释指令')
  })

  it('分支里 import 不同模块时，两边的引用都保留', () => {
    const source = [
      `// #ifdef MP-WEIXIN`,
      `import { login } from './wx-login'`,
      `// #endif`,
      `// #ifdef H5`,
      `import { login } from './h5-login'`,
      `// #endif`,
      `export const doLogin = (): void => login()`,
    ].join('\n')
    const artifact = downgrade(source)

    expect(artifact).toContain(`from './wx-login'`)
    expect(artifact).toContain(`from './h5-login'`)
    expect(artifact).not.toContain(': void')
    expectEquivalent(source, artifact, '分支 import')
  })

  it('enum 等需要代码生成的构造在分支里也能正确降级', () => {
    const source = [
      `// #ifdef H5`,
      `enum Mode { A = 1, B = 2 }`,
      `// #endif`,
      `export const m: Mode = Mode.A`,
    ].join('\n')
    const artifact = downgrade(source)

    expect(directivesOf(artifact)).toEqual(directivesOf(source))
    // enum 不能只删掉：它在运行时是个对象
    expect(artifact).toContain('Mode')
    expect(artifact).not.toMatch(/\benum\b/)
    expectEquivalent(source, artifact, 'enum 分支')
  })

  it('没有任何指令时，注释与格式仍然保持原样', () => {
    const source = [
      `// 普通注释`,
      `const a: string = 'a' // 行尾注释`,
      `export default a`,
    ].join('\n')
    const artifact = downgrade(source)

    expect(artifact).toContain('// 普通注释')
    expect(artifact).toContain('// 行尾注释')
    expect(artifact).toBe([
      `// 普通注释`,
      `const a = 'a' // 行尾注释`,
      `export default a`,
    ].join('\n'))
  })

  it('字符串里的 #ifdef 字样不是指令，也不会被当成指令处理', () => {
    const source = `const s: string = '#ifdef H5'\nexport default s`
    const artifact = downgrade(source)

    expect(artifact).toBe(`const s = '#ifdef H5'\nexport default s`)
    expect(directivesOf(artifact)).toEqual([])
  })
})

describe('条件编译：平台判定与 uni-app 一致', () => {
  const evaluate = (source: string, platform: string): string => {
    const analysis = analyzeConditional(source, { forms: [...SCRIPT_FORMS] })
    const context = buildContexts(analysis, { uniVersion: 3 })
      .find(item => item.platform === platform)
    expect(context, `缺少平台 ${platform}`).toBeTruthy()
    return project(source, analysis, context!.values)
  }

  it('#ifdef 只让目标平台的代码存活', () => {
    const source = `// #ifdef MP-WEIXIN\nalive\n// #endif`
    expect(evaluate(source, 'mp-weixin')).toContain('alive')
    expect(evaluate(source, 'h5')).not.toContain('alive')
  })

  it('#ifndef 与 #ifdef 相反', () => {
    const source = `// #ifndef H5\nalive\n// #endif`
    expect(evaluate(source, 'h5')).not.toContain('alive')
    expect(evaluate(source, 'mp-weixin')).toContain('alive')
  })

  it('派生的平台标志成立：#ifdef MP / APP-PLUS / WEB', () => {
    // uni-app 里 mp-weixin 会同时点亮 MP，app 会点亮 APP 与 APP-PLUS，h5 会点亮 WEB
    expect(evaluate(`// #ifdef MP\nalive\n// #endif`, 'mp-weixin')).toContain('alive')
    expect(evaluate(`// #ifdef MP\nalive\n// #endif`, 'h5')).not.toContain('alive')
    expect(evaluate(`// #ifdef APP-PLUS\nalive\n// #endif`, 'app')).toContain('alive')
    expect(evaluate(`// #ifdef APP-PLUS\nalive\n// #endif`, 'h5')).not.toContain('alive')
    expect(evaluate(`// #ifdef WEB\nalive\n// #endif`, 'h5')).toContain('alive')
    expect(evaluate(`// #ifdef WEB\nalive\n// #endif`, 'app')).not.toContain('alive')
  })

  it('#if 表达式按 JS 求值，支持 ||、! 与括号', () => {
    expect(evaluate(`// #if MP-WEIXIN || H5\nalive\n// #endif`, 'mp-weixin')).toContain('alive')
    expect(evaluate(`// #if MP-WEIXIN || H5\nalive\n// #endif`, 'h5')).toContain('alive')
    expect(evaluate(`// #if MP-WEIXIN || H5\nalive\n// #endif`, 'app')).not.toContain('alive')
    expect(evaluate(`// #if !H5\nalive\n// #endif`, 'app')).toContain('alive')
    expect(evaluate(`// #if !H5\nalive\n// #endif`, 'h5')).not.toContain('alive')
  })

  it('#else 取反，且每个平台恰好命中一个分支', () => {
    const source = `// #ifdef H5\nexport const v = 'h5'\n// #else\nexport const v = 'other'\n// #endif`
    expect(evaluate(source, 'h5')).toContain(`'h5'`)
    expect(evaluate(source, 'h5')).not.toContain(`'other'`)
    expect(evaluate(source, 'mp-weixin')).toContain(`'other'`)
    expect(evaluate(source, 'mp-weixin')).not.toContain(`'h5'`)
  })
})

describe('条件编译：无法安全处理时中断构建', () => {
  const expectFailure = (source: string, pattern: RegExp): void => {
    let error: Error | undefined
    try {
      downgrade(source)
    }
    catch (caught) {
      error = caught as Error
    }
    expect(error, '本应中断构建但没有报错').toBeTruthy()
    expect(error!.message).toMatch(pattern)
  }

  it('#elif 会被 uni-app 原样留在产物里，因此直接报错', () => {
    // uni-app 的预处理实现并不支持 #elif：条件成立时它那一行会留在产物里
    expectFailure([
      `// #ifdef H5`,
      `const a = 1`,
      `// #elif MP-WEIXIN`,
      `const a = 2`,
      `// #endif`,
    ].join('\n'), /#elif/)
  })

  it('平台名拼写错误会报错，而不是静默丢掉整块代码', () => {
    // uni-app 对认不出的名字按假处理，代码会凭空消失
    expectFailure([
      `// #ifdef H5-WRONG`,
      `const a: number = 1`,
      `// #endif`,
    ].join('\n'), /H5-WRONG|平台名/)
  })

  it('缺少 #endif 时报错', () => {
    expectFailure([
      `// #ifdef H5`,
      `const a: number = 1`,
    ].join('\n'), /#endif/)
  })

  it('多余的 #endif 时报错', () => {
    expectFailure([
      `const a: number = 1`,
      `// #endif`,
    ].join('\n'), /#endif/)
  })

  it('指令切开语句、且被切开的区域里有 TS 时给出可操作的报错', () => {
    // #ifdef 落在对象字面量内部，中间那段只在部分平台下才拼成完整语句：
    // 此时无法安全地把 TS 擦掉（区域自身不是合法语法），必须报错而不是产出坏代码
    expectFailure([
      `// #ifdef APP-PLUS`,
      `export const opts = {`,
      `// #endif`,
      `  deep: true as boolean,`,
      `// #ifdef APP-PLUS`,
      `}`,
      `// #endif`,
    ].join('\n'), /无法降级|指令|语句/)
  })

  it('指令切开语句但区域里没有 TS 时原样透传', () => {
    // 没有 TS 要擦除，插件不该多管：这类写法在各平台下是否成立由下游决定
    const source = [
      `// #ifdef APP-PLUS`,
      `export const opts = {`,
      `// #endif`,
      `  deep: true,`,
      `// #ifdef APP-PLUS`,
      `}`,
      `// #endif`,
    ].join('\n')
    expect(downgrade(source)).toBe(source)
  })
})

describe('条件编译：每个块都会被校验', () => {
  const expectRejected = async (source: string, pattern: RegExp): Promise<void> => {
    await expect(downgradeSFC(source, 'App.vue')).rejects.toThrow(pattern)
  }

  // uni-app 的 html / css 规则与 js 规则一样不支持 #elif、也一样会把认不出的平台名
  // 当假处理，所以模板与样式里的这些写法必须和 script 里一样被拦下。
  // 这些用例覆盖过一个真实盲区：早先只有 TS script 块会被校验。
  it.each([
    ['script', `<script setup lang="ts">\n// #ifdef H5\nconst a: number = 1\n// #elif MP-WEIXIN\nconst a: number = 2\n// #endif\n</script>`],
    ['template', `<script setup lang="ts">\nconst a: number = 1\n</script>\n<template>\n<!-- #ifdef H5 -->\n<p>{{ a }}</p>\n<!-- #elif MP-WEIXIN -->\n<p>{{ a }}</p>\n<!-- #endif -->\n</template>`],
    ['style', `<script setup lang="ts">\nconst a: number = 1\n</script>\n<template><p>{{ a }}</p></template>\n<style>\n/* #ifdef H5 */\n.a { color: red; }\n/* #elif MP-WEIXIN */\n.a { color: blue; }\n/* #endif */\n</style>`],
  ])('%s 块里的 #elif 会被拒绝', async (_label, source) => {
    await expectRejected(source, /#elif/)
  })

  it.each([
    ['template', `<script setup lang="ts">\nconst a: number = 1\n</script>\n<template>\n<!-- #ifdef H5-WRONG -->\n<p>{{ a }}</p>\n<!-- #endif -->\n</template>`],
    ['style', `<script setup lang="ts">\nconst a: number = 1\n</script>\n<template><p>{{ a }}</p></template>\n<style>\n/* #ifdef H5-WRONG */\n.a { color: red; }\n/* #endif */\n</style>`],
  ])('%s 块里的未知平台名会被拒绝（否则整块内容会静默消失）', async (_label, source) => {
    await expectRejected(source, /H5-WRONG|平台名/)
  })

  it('模板里缺少 #endif 会被拒绝', async () => {
    await expectRejected(
      `<script setup lang="ts">\nconst a: number = 1\n</script>\n<template>\n<!-- #ifdef H5 -->\n<p>{{ a }}</p>\n</template>`,
      /#endif/,
    )
  })

  it('完全没有 TS 的组件也会被校验，不会把坏指令原样发进产物', async () => {
    // 这种情况最容易漏：没有任何降级需求时 downgradeSFC 本来会直接返回 null
    await expectRejected(
      `<script>\n// #ifdef H5\nconst a = 1\n// #elif MP-WEIXIN\nconst a = 2\n// #endif\n</script>\n<template><p>{{ a }}</p></template>`,
      /#elif/,
    )
  })

  it('只有 template 的组件也会被校验', async () => {
    await expectRejected(
      `<template>\n<!-- #ifdef H5-WRONG -->\n<p>x</p>\n<!-- #endif -->\n</template>`,
      /H5-WRONG|平台名/,
    )
  })

  it('报告里指明是哪个块', async () => {
    await expect(
      downgradeSFC(`<script setup lang="ts">\nconst a: number = 1\n</script>\n<template>\n<!-- #ifdef H5-WRONG -->\n<p>{{ a }}</p>\n<!-- #endif -->\n</template>`, 'App.vue'),
    ).rejects.toThrow(/<template>/)
  })

  it('纯 JS 组件里的合法指令照样放行', async () => {
    const source = `<script>\nconst a = 1\n// #ifdef H5\nconst b = 2\n// #endif\n</script>\n<template>\n<view>\n<!-- #ifdef H5 -->\n<text>{{ b }}</text>\n<!-- #endif -->\n</view>\n</template>`
    // 没有需要降级的内容，仍返回 null（原样），但校验已经跑过
    expect(await downgradeSFC(source, 'App.vue')).toBeNull()
  })
})

describe('条件编译：关键字大小写', () => {
  // uni-app 用大小写不敏感的正则匹配指令，但只认小写的 ifdef / ifndef / if，
  // 其它写法会让它内部抛错；uniPrePlugin 把异常吞掉后返回原文，
  // 于是那段代码在**所有平台**都生效。这类写法必须拦下。
  it.each([
    ['#IfDeF', `// #IfDeF H5`],
    ['#IFDEF', `// #IFDEF H5`],
    ['#IfNdEf', `// #IfNdEf H5`],
    ['#IF', `// #IF H5`],
  ])('起始关键字 %s 会被拒绝', async (_label, directive) => {
    const source = `<script setup lang="ts">\n${directive}\nconst a: number = 1\n// #endif\n</script>\n<template><p>{{ a }}</p></template>`
    await expect(downgradeSFC(source, 'App.vue')).rejects.toThrow(/小写|大小写/)
  })

  it.each([
    ['#ENDIF', `// #ENDIF`],
    ['#EndIf', `// #EndIf`],
  ])('结束关键字 %s 会被接受（uni-app 侧本就不敏感）', async (_label, endDirective) => {
    const source = `<script setup lang="ts">\n// #ifdef H5\nconst a: number = 1\n${endDirective}\n</script>\n<template><p>{{ a }}</p></template>`
    const artifact = await downgradeSFC(source, 'App.vue')
    // 指令原样保留，大小写不改写
    expect(artifact).toContain('#ifdef H5')
    expect(artifact).toContain(endDirective.slice(3))
  })

  it('#Else 会被接受', async () => {
    const source = `<script setup lang="ts">\n// #ifdef H5\nconst a: number = 1\n// #Else\nconst a: number = 2\n// #endif\n</script>\n<template><p>{{ a }}</p></template>`
    await expect(downgradeSFC(source, 'App.vue')).resolves.toBeTruthy()
  })

  it('全小写的常规写法不受影响', async () => {
    const source = `<script setup lang="ts">\n// #ifdef H5\nconst a: number = 1\n// #endif\n</script>\n<template><p>{{ a }}</p></template>`
    await expect(downgradeSFC(source, 'App.vue')).resolves.toBeTruthy()
  })
})

describe('条件编译：style 块', () => {
  const wrap = (style: string): string => `<template><view>x</view></template>\n\n${style}`

  it('less 里的块注释指令穿过编译保留下来', async () => {
    const source = wrap([
      `<style lang="less">`,
      `/* #ifdef H5 */`,
      `.a { color: blue; }`,
      `/* #endif */`,
      `.b { color: green; }`,
      `</style>`,
    ].join('\n'))
    const artifact = await downgradeSFC(source, 'App.vue')

    expect(artifact).toContain('/* #ifdef H5 */')
    expect(artifact).toContain('/* #endif */')
    expect(artifact).not.toContain('lang="less"')
    expect(artifact).toMatch(/\.a \{\s*color: blue;/)
  })

  it('less 里的行注释指令会报错：less 会吃掉 // 注释', async () => {
    const source = wrap([
      `<style lang="less">`,
      `// #ifdef H5`,
      `.a { color: blue; }`,
      `// #endif`,
      `</style>`,
    ].join('\n'))

    await expect(downgradeSFC(source, 'App.vue')).rejects.toThrow(/#ifdef|行注释/)
  })

  it('嵌套规则里的指令脱钩时报错，而不是让样式在所有平台生效', async () => {
    // less 会把 .outer .inner 提到指令外面，光比对指令序列发现不了
    const source = wrap([
      `<style lang="less">`,
      `.outer {`,
      `  /* #ifdef MP-WEIXIN */`,
      `  .inner { color: pink; }`,
      `  /* #endif */`,
      `}`,
      `</style>`,
    ].join('\n'))

    await expect(downgradeSFC(source, 'App.vue')).rejects.toThrow(/守不住|嵌套/)
  })

  it('顶层规则之间的指令是安全的', async () => {
    const source = wrap([
      `<style lang="less">`,
      `/* #ifndef H5 */`,
      `view { color: red; }`,
      `/* #endif */`,
      `/* #ifdef H5 */`,
      `text { color: blue; }`,
      `/* #endif */`,
      `</style>`,
    ].join('\n'))
    const artifact = await downgradeSFC(source, 'App.vue')

    expect(artifact).toContain('/* #ifndef H5 */')
    expect(artifact).toContain('/* #ifdef H5 */')
    expect(artifact).toMatch(/view \{\s*color: red;/)
    expect(artifact).toMatch(/text \{\s*color: blue;/)
  })
})

describe('条件编译：平台上下文覆盖', () => {
  it('内置平台列表覆盖 uni-app 的全部平台别名', () => {
    const known = new Set<string>(PLATFORMS)
    // 官方文档里的平台标识，缺一个就可能漏掉某个平台的代码
    for (const platform of ['h5', 'mp-weixin', 'mp-alipay', 'mp-baidu', 'mp-qq', 'mp-toutiao', 'app', 'app-harmony', 'quickapp-webview'])
      expect(known.has(platform), `缺少平台 ${platform}`).toBe(true)
  })

  it('每个判定键都至少被一个代表平台点亮，不会出现永远不生效的区域', () => {
    // 扫描所有键：若某个键在所有内置平台上都是 false，说明平台列表漏了这个键，
    // 用它的 #ifdef 会永远不生效（死区），代码会被静默丢掉
    const analysis = analyzeConditional('', { forms: [...SCRIPT_FORMS] })
    const contexts = buildContexts(analysis, { uniVersion: 3 })
    const alwaysFalse: string[] = []
    for (const key of ['H5', 'MP', 'MP_WEIXIN', 'APP', 'APP_PLUS', 'APP_VUE', 'APP_NVUE', 'APP_ANDROID', 'APP_IOS', 'APP_HARMONY', 'WEB', 'QUICKAPP_WEBVIEW', 'QUICKAPP_NATIVE', 'VUE3']) {
      if (!contexts.some(context => context.values[key] === true))
        alwaysFalse.push(key)
    }
    expect(alwaysFalse, `这些判定键不会被任何平台点亮：${alwaysFalse.join(', ')}`).toEqual([])
  })
})

describe('条件编译：分析器本身', () => {
  it('指令必须独占一行，行内出现的 #ifdef 不算指令', () => {
    const analysis = analyzeConditional(`const a = 1 // #ifdef H5`, { forms: [...SCRIPT_FORMS] })
    expect(analysis.directives).toHaveLength(0)
  })

  it('投影保持偏移不变，便于把 AST 区间用回源码', () => {
    const source = [
      `const a: string = 'a'`,
      `// #ifdef H5`,
      `const b: string = 'b'`,
      `// #endif`,
    ].join('\n')
    const analysis = analyzeConditional(source, { forms: [...SCRIPT_FORMS] })
    const context = buildContexts(analysis).find(item => item.platform === 'h5')!
    const projected = project(source, analysis, context.values)

    expect(projected).toHaveLength(source.length)
    // 存活区域的文本与源码逐偏移一致
    const offset = source.indexOf(`const b`)
    expect(projected.slice(offset, offset + 15)).toBe(source.slice(offset, offset + 15))
    // 指令行与死区都被挖成空白
    expect(projected.slice(source.indexOf('// #ifdef'), source.indexOf('// #ifdef') + 12).trim()).toBe('')
  })

  it('解析出的 AST 区间可以直接用在源码上（含互斥分支的同名声明）', () => {
    const source = [
      `// #ifdef H5`,
      `const platform: string = 'h5'`,
      `// #endif`,
      `// #ifndef H5`,
      `const platform: string = 'mp'`,
      `// #endif`,
    ].join('\n')
    // 恢复模式：合并文本里的重复声明不该妨碍拿到完整 AST
    const ast = parseScript(source, false, true) as BabelNode
    const declarators: Array<{ start: number, end: number }> = []
    for (const statement of ast.program?.body ?? []) {
      const declaration = (statement as unknown as { declarations?: BabelNode[] }).declarations?.[0]
      const annotation = (declaration?.id as unknown as { typeAnnotation?: BabelNode } | undefined)?.typeAnnotation
      if (annotation)
        declarators.push({ start: annotation.start, end: annotation.end })
    }
    expect(declarators).toHaveLength(2)
    for (const range of declarators)
      expect(source.slice(range.start, range.end)).toBe(': string')
  })
})
