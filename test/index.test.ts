import type { InputOptions, OutputAsset, OutputChunk, OutputOptions, RolldownPluginOption } from 'rolldown'
import path from 'node:path'
import { build } from 'rolldown'
import { describe, expect, it } from 'vitest'
import { unplugin } from '../src/index'

type OutputFile = OutputChunk | OutputAsset

interface BuildFixtureOptions {
  /** 复用同一个插件实例，用来验证跨构建的状态 */
  plugin?: RolldownPluginOption
  /** 入口文件，默认 src/index.ts */
  entry?: string
  plugins?: RolldownPluginOption[]
  output?: OutputOptions
  onLog?: InputOptions['onLog']
}

/** 按 tsdown unbundle 的配置构建：产物按源目录结构镜像，node_modules 依赖交给 external 配置 */
async function buildFixture(name: string, options: BuildFixtureOptions = {}): Promise<OutputFile[]> {
  const dir = path.resolve(import.meta.dirname, 'fixtures', name)
  const srcDir = path.join(dir, 'src')
  const bundle = await build({
    input: path.join(srcDir, options.entry ?? 'index.ts'),
    cwd: dir,
    external: ['vue'],
    resolve: {
      alias: { '@': srcDir },
    },
    plugins: [options.plugin ?? unplugin.rolldown(), ...(options.plugins ?? [])],
    onLog: options.onLog,
    output: {
      preserveModules: true,
      preserveModulesRoot: srcDir,
      ...options.output,
    },
    write: false,
  })
  const results = Array.isArray(bundle) ? bundle : [bundle]
  return results.flatMap(result => result.output) as OutputFile[]
}

function fileNames(files: OutputFile[]): string[] {
  return files.map(file => file.fileName)
}

function contentOf(files: OutputFile[], fileName: string): string {
  const file = files.find(item => item.fileName === fileName)
  expect(file, `缺少产物文件 ${fileName}`).toBeTruthy()
  return file?.type === 'asset' ? String(file.source) : (file as OutputChunk).code
}

describe('unplugin-uni-sfc', () => {
  it('只把 .vue 输出成资产，引用的其它文件由打包工具产出', async () => {
    const files = await buildFixture('basic')

    expect(fileNames(files)).toContain('index.js')
    expect(fileNames(files)).toContain('App.vue')
    expect(fileNames(files)).toContain('Child.vue')
    expect(fileNames(files)).toContain('constant.js')
    expect(fileNames(files)).toContain('nested/magic.js')
    // TS 文件不应以原始扩展名出现在产物中，.vue 也不应留下 JS chunk
    expect(fileNames(files)).not.toContain('constant.ts')
    expect(fileNames(files)).not.toContain('nested/magic.ts')
    expect(fileNames(files)).not.toContain('App.js')
    expect(fileNames(files)).not.toContain('Child.js')
  })

  it('入口产物保留对 .vue 的引用', async () => {
    const code = contentOf(await buildFixture('basic'), 'index.js')
    expect(code).toMatch(/import .* from ["']\.\/App\.vue["']/)
  })

  it('降级 SFC：移除 lang="ts"、擦除类型，且保留模板中使用的导入', async () => {
    const app = contentOf(await buildFixture('basic'), 'App.vue')

    expect(app).toContain('<script setup>')
    // oxc 会修剪块内容开头的前导空白，回填时需按原文补回，`<script setup>` 后必须换行
    expect(app).toMatch(/<script setup>\r?\n/)
    expect(app).not.toContain('lang="ts"')
    expect(app).not.toContain(': number')
    // 仅在模板中使用的导入不能被当作未使用代码删掉
    expect(app).toMatch(/import \{ HEADER \} from ["']\.\/constant\.js["']/)
    expect(app).toMatch(/import Child from ["']\.\/Child\.vue["']/)
    // external 由打包工具的配置决定，插件不做判断
    expect(app).toMatch(/import \{ ref \} from ["']vue["']/)
  })

  it('只在模板里用到的导出不会被 tree-shaking 丢掉', async () => {
    const files = await buildFixture('basic')

    // HEADER 只在 App.vue 的模板里出现，产物里必须仍然导出它
    expect(contentOf(files, 'constant.js')).toMatch(/export \{[^}]*HEADER/)
  })

  it('降级 SFC：模板表达式中的 TS 语法被擦除', async () => {
    const app = contentOf(await buildFixture('basic'), 'App.vue')

    expect(app).toContain('<p>count10: {{ count + 10 }}</p>')
    expect(app).toContain('<p>{{ { x: count } }}</p>')
    expect(app).toContain('<p v-if="count > 0">')
    expect(app).toMatch(/v-for="item of list"/)
    expect(app).not.toContain(' as number')
    expect(app).not.toContain('count!')
  })

  it('chunk 里与被换产物同名的普通字符串不会被误改', async () => {
    const files = await buildFixture('shared')

    // docs.js 里的 './App.js' 是用户数据而不是引用语句，必须原样保留；
    // 入口对 App 的真引用仍要改写成 './App.vue'
    expect(contentOf(files, 'docs.js')).toMatch(/["']\.\/App\.js["']/)
    expect(contentOf(files, 'index.js')).toMatch(/from ["']\.\/App\.vue["']/)
  })

  it('引用被回填成打包工具产出的位置，.vue 之间的引用指向 .vue', async () => {
    const files = await buildFixture('basic')

    const constant = contentOf(files, 'constant.js')
    expect(constant).not.toContain(': string')
    expect(constant).toMatch(/from ["']\.\/nested\/magic\.js["']/)

    const app = contentOf(files, 'App.vue')
    expect(app).toMatch(/from ["']\.\/constant\.js["']/)
    // 别名 `@/Child.vue` 也要回填成产物里的相对路径
    expect(app).toMatch(/from ["']\.\/Child\.vue["']/)

    const child = contentOf(files, 'Child.vue')
    expect(child).toContain('<script setup>')
    expect(child).not.toContain('lang="ts"')
    expect(child).toMatch(/from ["']\.\/nested\/magic\.js["']/)

    expect(contentOf(files, 'nested/magic.js')).not.toContain(': string')
  })

  it('引用的文件由打包工具的插件链处理，而不是插件自己编译', async () => {
    const transformed: string[] = []
    const files = await buildFixture('basic', {
      plugins: [{
        name: 'test:mark-dependencies',
        transform(code, id) {
          if (!id.endsWith('.ts'))
            return
          transformed.push(id)
          // 带副作用的标记：打包工具会保留它，用来证明这个文件真的走过了打包工具的插件链
          return `${code}\nglobalThis.__handled_by_bundler__ = true\n`
        },
      }],
    })

    // 打包工具的插件看到了 .vue 引用的文件
    expect(transformed.some(id => id.endsWith('constant.ts'))).toBe(true)
    expect(transformed.some(id => id.endsWith('magic.ts'))).toBe(true)
    expect(contentOf(files, 'constant.js')).toContain('__handled_by_bundler__')
    expect(contentOf(files, 'nested/magic.js')).toContain('__handled_by_bundler__')
  })

  it('打包工具的命名模式决定 .vue 在产物中的位置', async () => {
    const files = await buildFixture('basic', {
      output: { entryFileNames: 'entries/[name].js' },
    })

    // rolldown 把所有模块 chunk 都放进 entries/，.vue 资产与它自己的 JS chunk 同位，只换回扩展名
    expect(fileNames(files)).toContain('entries/index.js')
    expect(fileNames(files)).toContain('entries/App.vue')
    expect(contentOf(files, 'entries/index.js')).toMatch(/from ["']\.\/App\.vue["']/)
  })

  it('用户没有配置时，插件自己把 preserveModules 打开', async () => {
    const files = await buildFixture('basic', {
      output: { preserveModules: false, preserveModulesRoot: undefined },
    })

    // 没有 preserveModules 时 .vue 会和入口合进一个 chunk，插件按模块产出后就能换成 .vue
    expect(fileNames(files)).toContain('App.vue')
    expect(fileNames(files)).toContain('constant.js')
    expect(fileNames(files)).not.toContain('App.js')
    expect(contentOf(files, 'index.js')).toMatch(/from ["']\.\/App\.vue["']/)
  })

  it('非 ESM 产物格式不受支持：保留 JS 产物并提示只支持 ESM', async () => {
    const warnings: string[] = []
    const files = await buildFixture('basic', {
      output: { format: 'iife', name: 'fixture', preserveModules: false, preserveModulesRoot: undefined },
      onLog(level, log, defaultHandler) {
        if (level === 'warn')
          warnings.push(String(log.message))
        defaultHandler(level, log)
      },
    })

    // 非 ESM 时插件不接管产物：合并后的 JS 产物保留（不能删掉，否则会连入口一起丢掉），
    // 降级后的 .vue 仍作为资产输出，但不会换回、也不会回填引用
    expect(warnings.join('\n')).toContain('ESM')
    expect(fileNames(files)).toContain('App.vue')
    expect(fileNames(files).some(name => contentOf(files, name).includes('fixture'))).toBe(true)
  })

  it('cjs 产物格式同样不受支持并提示', async () => {
    const warnings: string[] = []
    const files = await buildFixture('basic', {
      output: { format: 'cjs', preserveModules: false, preserveModulesRoot: undefined },
      onLog(level, log, defaultHandler) {
        if (level === 'warn')
          warnings.push(String(log.message))
        defaultHandler(level, log)
      },
    })

    expect(warnings.join('\n')).toContain('ESM')
    expect(fileNames(files)).toContain('App.vue')
    // cjs 下不再把 .vue 换回资产，模块按普通 JS 产出
    expect(fileNames(files).some(name => name.endsWith('.js') || name.endsWith('.cjs'))).toBe(true)
  })

  it('同一个文件被入口和 .vue 同时引用时只产出一份', async () => {
    const files = await buildFixture('shared')

    expect(fileNames(files).filter(name => name === 'constant.js')).toHaveLength(1)
    expect(contentOf(files, 'App.vue')).toMatch(/from ["']\.\/constant\.js["']/)
    expect(contentOf(files, 'index.js')).toMatch(/from ["']\.\/constant\.js["']/)
  })

  it('.vue 之间循环引用也能各自输出成 .vue', async () => {
    const files = await buildFixture('cycle')

    expect(fileNames(files)).toContain('App.vue')
    expect(fileNames(files)).toContain('Child.vue')
    expect(contentOf(files, 'App.vue')).toMatch(/from ["']\.\/Child\.vue["']/)
    expect(contentOf(files, 'Child.vue')).toMatch(/from ["']\.\/App\.vue["']/)
  })

  it('以 .vue 作为入口时同样输出成 .vue', async () => {
    const files = await buildFixture('cycle', { entry: 'App.vue' })

    expect(fileNames(files)).toContain('App.vue')
    expect(fileNames(files)).toContain('Child.vue')
    expect(fileNames(files)).not.toContain('App.js')
  })

  it('解析失败的 SFC 会中断构建，而不是把 TS 原文发进产物', async () => {
    await expect(buildFixture('broken')).rejects.toThrow(/解析失败/)
  })

  it('.vue 的产物路径完全由打包工具决定，而不是插件或入口目录', async () => {
    const files = await buildFixture('wide', {
      // 用户把镜像基准抬高到 fixture 目录（src 的上一级），打包工具按它镜像所有模块
      output: { preserveModulesRoot: path.resolve(import.meta.dirname, 'fixtures', 'wide') },
    })

    // .vue 与其它模块一样按基准镜像到 src/ 下，基准之外的 shared.ts 退化为文件名；
    // 插件不做任何自己的推导，若按入口目录推导会得到根下的 App.vue
    expect(fileNames(files)).toContain('shared.js')
    expect(fileNames(files)).toContain('src/index.js')
    expect(fileNames(files)).toContain('src/App.vue')
    expect(fileNames(files)).toContain('src/Child.vue')
    expect(fileNames(files)).not.toContain('App.vue')
    expect(contentOf(files, 'src/index.js')).toMatch(/from ["']\.\/App\.vue["']/)
  })

  it('同一个插件实例连续构建时，产物路径始终跟随打包工具的配置', async () => {
    const plugin = unplugin.rolldown()
    await buildFixture('nested', { plugin })
    const files = await buildFixture('nested', { plugin, entry: 'deep/index.ts' })

    // 两次构建的基准都是打包工具配置的 preserveModulesRoot（src）：第二次入口在 deep/ 下，
    // .vue 照样镜像到 deep/ —— 插件不按入口做任何推导，也不残留上一次构建的状态
    expect(fileNames(files)).toContain('deep/index.js')
    expect(fileNames(files)).toContain('deep/Deep.vue')
    expect(fileNames(files)).not.toContain('Deep.vue')
    expect(contentOf(files, 'deep/index.js')).toMatch(/from ["']\.\/Deep\.vue["']/)
  })
})
