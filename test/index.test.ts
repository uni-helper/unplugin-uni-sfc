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

  it('降级 SFC：lang="less" 的 style 块编译为 CSS 并移除 lang 标记', async () => {
    const app = contentOf(await buildFixture('basic'), 'App.vue')

    expect(app).toContain('<style>')
    expect(app).not.toContain('lang="less"')
    // less 变量替换、嵌套展开、@import 内联，产物不再依赖 less
    expect(app).toMatch(/\.header \{\s*color: #ff0000;/)
    expect(app).toContain('.header .title')
    expect(app).not.toContain('@header-color')
    expect(app).not.toContain('@import')
  })

  it('降级 SFC：没有 TS 的 SFC 也会降级 less 样式', async () => {
    const plain = contentOf(await buildFixture('basic'), 'Plain.vue')

    expect(plain).toContain('<script>')
    expect(plain).toContain('<style>')
    expect(plain).not.toContain('lang="less"')
    expect(plain).not.toContain('@size')
    expect(plain).toMatch(/font-size: 12px/)
  })

  it('sass 由 uni-app 自带支持，lang="scss" 原样保留', async () => {
    const app = contentOf(await buildFixture('basic'), 'App.vue')

    expect(app).toContain('lang="scss"')
    expect(app).toContain('$title-color')
  })

  it('less 编译失败会中断构建，而不是把 less 原文发进产物', async () => {
    const error = await buildFixture('broken-less').catch((error: Error) => error)

    expect(error).toBeInstanceOf(Error)
    const message = (error as Error).message
    expect(message).toContain('编译失败')
    // less 的报错信息（未定义的变量）原样带出
    expect(message).toContain('@undefined-var')
  })

  it('带 src 的外部 less 样式块不降级，只提示不会进入产物', async () => {
    const warnings: string[] = []
    const files = await buildFixture('less-src', {
      onLog(level, log, defaultHandler) {
        if (level === 'warn')
          warnings.push(String(log.message))
        defaultHandler(level, log)
      },
    })

    // 外部文件不在降级范围内：原样保留，由告警说明后果
    const app = contentOf(files, 'App.vue')
    expect(app).toContain('lang="less"')
    expect(warnings.join('\n')).toContain('不会被降级')
  })

  it('sFC 里 import 的样式文件：整句 import 从产物移除，内容由 CSS 管线抽成资产', async () => {
    const warnings: string[] = []
    // 模拟 @tsdown/css 之类的 CSS 管线：样式模块的内容被抽走，只剩一个空壳模块
    const files = await buildFixture('style-import', {
      plugins: [{
        name: 'test:fake-css-pipeline',
        load(id) {
          if (!id.endsWith('.less'))
            return
          return { code: '', moduleType: 'js', moduleSideEffects: 'no-treeshake' }
        },
      }],
      onLog(level, log, defaultHandler) {
        if (level === 'warn')
          warnings.push(String(log.message))
        defaultHandler(level, log)
      },
    })

    // 纯样式 chunk 会被 CSS 管线丢弃，.vue 不能引用它：整句 import 移除（同打包工具对 JS 的处理）
    const app = contentOf(files, 'App.vue')
    expect(app).not.toContain('global.less')
    expect(app).not.toMatch(/import ["']\.\/styles/)
    expect(warnings.join('\n')).toContain('import 已从产物中移除')
  })

  it('sFC 里 import 的样式文件：CSS 资产已产出时，引用回填成 CSS 资产的路径', async () => {
    const warnings: string[] = []
    // 模拟 vite 的 cssCodeSplit：渲染阶段就把纯样式 chunk 的 CSS 资产产出
    const files = await buildFixture('style-import', {
      plugins: [{
        name: 'test:fake-css-pipeline',
        load(id) {
          if (!id.endsWith('.less'))
            return
          return { code: '', moduleType: 'js', moduleSideEffects: 'no-treeshake' }
        },
        renderChunk(_code, chunk) {
          if (!Object.keys(chunk.modules).some(id => id.endsWith('.less')))
            return
          this.emitFile({
            type: 'asset',
            fileName: chunk.fileName.replace(/\.[cm]?js$/, '.css'),
            source: '.count {\n  color: #42b883;\n}\n',
          })
          return undefined
        },
      }],
      onLog(level, log, defaultHandler) {
        if (level === 'warn')
          warnings.push(String(log.message))
        defaultHandler(level, log)
      },
    })

    expect(contentOf(files, 'App.vue')).toMatch(/import ["']\.\/styles\/global\.css["']/)
    expect(contentOf(files, 'App.vue')).not.toContain('global.less')
    expect(warnings.join('\n')).not.toContain('import 已从产物中移除')
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

  it('类型宏：跨文件导入的类型被解析成运行时声明', async () => {
    const app = contentOf(await buildFixture('macros'), 'ImportedTypes.vue')

    // 类型擦除后 defineProps<T>() 的声明会丢失，必须回填成运行时对象
    expect(app).toMatch(/defineProps\(\{/)
    expect(app).toMatch(/title:\s*\{\s*type:\s*String,\s*required:\s*true\s*\}/)
    expect(app).toMatch(/count:\s*\{\s*type:\s*Number,\s*required:\s*false\s*\}/)
    expect(app).toMatch(/tags:\s*\{\s*type:\s*Array,\s*required:\s*false\s*\}/)
    // 联合类型退化成 String
    expect(app).toMatch(/mode:\s*\{\s*type:\s*String,\s*required:\s*true\s*\}/)
    // defineEmits<T>() 回填成事件名数组
    expect(app).toMatch(/defineEmits\(\["change",\s*"close"\]\)/)
    // 类型导入本身要被擦干净
    expect(app).not.toContain('import type')
    expect(app).not.toContain('./panel')
  })

  it('类型宏：withDefaults 的默认值合进 props，helper 从 vue 导入', async () => {
    const app = contentOf(await buildFixture('macros'), 'MergeDefaults.vue')

    // 非静态默认值走 mergeDefaults：Vue 只给占位名，插件必须自己补 import
    expect(app).toMatch(/import \{ mergeDefaults as (\w+) \} from ["']vue["']/)
    // 生成的声明里必须引用那个导入进来的 helper（而不是 Vue 自己的占位名）
    const helper = /import \{ mergeDefaults as (\w+) \}/.exec(app)?.[1]
    expect(helper).toBeTruthy()
    expect(app).toMatch(new RegExp(`defineProps\\(/\\*@__PURE__\\*/\\s*${helper}\\(`))
    // withDefaults 外层必须消失：Vue 不允许它搭配运行时声明
    expect(app).not.toContain('withDefaults')
    // 默认值原文保留（擦除只删类型，不改引号与空格）
    expect(app).toMatch(/\.\.\.\{ label: ['"]default['"] \}/)
    expect(app).toMatch(/list:\s*\(\)\s*=>\s*\[\]/)
  })

  it('类型宏：解构写法的默认值不丢失', async () => {
    const app = contentOf(await buildFixture('macros'), 'Destructured.vue')

    // `count = 1` 只存在于解构表达式里，类型声明上看不到，不回填就会丢
    expect(app).toMatch(/count:\s*\{[^}]*default:\s*1/)
    expect(app).toMatch(/other:\s*\{\s*type:\s*String,\s*required:\s*false\s*\}/)
  })

  it('只有类型导入的 <script setup> 不会残留 export {}', async () => {
    const app = contentOf(await buildFixture('macros'), 'TypeImportOnly.vue')

    // 类型导入被擦掉后可能只剩一个空模块，此时不能补 `export {}`
    // （`<script setup>` 不允许 ES 模块导出）。断言真实的导出语句，而不是文本里
    // 恰好出现的 `export {}`——fixture 的注释里就写了这四个字符。
    expect(app).not.toMatch(/(?:^|\n)[ \t]*export[ \t]*\{[ \t]*\}/)
    expect(app).toContain('<script setup>')
    // 类型导入被擦掉，但宏回填的声明还在
    expect(app).not.toContain('import type')
    expect(app).toMatch(/defineProps\(\{\s*tag:/)
  })

  it('运行时声明的 defineProps / defineEmits 原样保留', async () => {
    const app = contentOf(await buildFixture('macros'), 'RuntimeDecl.vue')

    expect(app).toMatch(/defineProps\(\{\s*label:\s*\{\s*type:\s*String/)
    expect(app).toMatch(/defineEmits\(\[['"]tap['"]\]\)/)
    // 运行时声明本来就不需要回填，不应被改写
    expect(app).not.toMatch(/mergeDefaults/)
  })

  it('类型宏：普通 <script> 里声明的类型也能被 <script setup> 引用', async () => {
    const app = contentOf(await buildFixture('macros'), 'SharedScript.vue')

    // 两个块共享作用域：类型声明在普通 <script> 里，宏在 <script setup> 里
    expect(app).toMatch(/defineProps\(\{\s*alpha:/)
    expect(app).toMatch(/alpha:\s*\{\s*type:\s*String,\s*required:\s*true\s*\}/)
    expect(app).toMatch(/beta:\s*\{\s*type:\s*Number,\s*required:\s*false\s*\}/)
  })

  it('类型解析不了时中断构建，并提示改用运行时声明', async () => {
    const error = await buildFixture('unresolved-type').catch((error: Error) => error)

    expect(error).toBeInstanceOf(Error)
    const message = (error as Error).message
    expect(message).toContain('类型宏解析失败')
    expect(message).toContain('not-exists')
    expect(message).toContain('运行时声明')
    // 不能退化成无参 defineProps()：那会静默丢掉 props 声明
    expect(message).not.toContain('defineProps()')
  })

  it('条件编译：指令原样保留在产物里，TS 同时被擦除', async () => {
    const files = await buildFixture('conditional')
    const app = contentOf(files, 'App.vue')

    // 指令逐条保留：script、模板、style 三处都在
    expect(app).toContain('// #ifdef H5')
    expect(app).toContain('// #ifndef H5')
    expect(app).toContain('// #ifdef APP-PLUS')
    expect(app).toContain('<!-- #ifdef H5 -->')
    expect(app).toContain('<!-- #ifdef MP-WEIXIN -->')
    expect(app).toContain('/* #ifndef H5 */')
    expect(app).toContain('/* #ifdef H5 */')
    // TS 被擦掉，指令留在原位（含对象字面量内部那两条）
    expect(app).not.toContain('lang="ts"')
    expect(app).not.toContain('Record<string, unknown>')
    expect(app).not.toContain(' as boolean')
    expect(app).toMatch(/deep: true,/)
    expect(app).toContain('// #ifdef APP-PLUS')
    expect(app).toContain('plus: 1,')
    // 互斥分支的同名声明各自保留，值都是擦除后的 JS
    expect(app).toMatch(/const platform = ['"]h5['"]/)
    expect(app).toMatch(/const platform = ['"]mp['"]/)
  })

  it('条件编译：产物里每条引用都指向真实存在的文件', async () => {
    const files = await buildFixture('conditional')
    const names = fileNames(files)

    // 两个平台各自的模块都要产出：产物里 .vue 的引用必须有落点
    expect(names).toContain('wx-only.js')
    expect(names).toContain('h5-only.js')

    // 逐个产物检查：任何相对引用都必须能在产物里找到。
    // 打包工具会把单引用者的叶子模块内联进 .vue 的 chunk，而那个 chunk 随后被换成
    // .vue 资产 —— 不特殊处理的话引用就会悬空（这正是本测试要挡住的回归）。
    for (const file of files) {
      const code = file.type === 'asset' ? String(file.source) : (file as OutputChunk).code
      const dir = path.posix.dirname(file.fileName)
      for (const match of code.matchAll(/(?:from\s+|import\s*\(\s*|import\s+)["']([^"']+)["']/g)) {
        const specifier = match[1]
        if (!specifier.startsWith('.'))
          continue
        const target = path.posix.normalize(path.posix.join(dir, specifier))
        expect(names, `${file.fileName} 的 ${specifier} 指向不存在的产物`).toContain(target)
      }
    }
  })

  it('条件编译：纯 JS 组件（没有 lang="ts"）的指令也原样保留', async () => {
    const files = await buildFixture('conditional')
    const plain = contentOf(files, 'Plain.vue')

    // 这类组件没有 TS 要降级，最容易在「提前返回」时漏掉校验与透传
    expect(plain).toContain('<!-- #ifdef H5 -->')
    expect(plain).toContain('<!-- #ifndef H5 -->')
    expect(plain).toContain('<!-- #endif -->')
    // 断言真实属性，而不是文本里恰好出现的字样（fixture 的注释里就写了 lang="ts"）
    expect(plain).not.toMatch(/<script[^>]*\slang=/)
    expect(plain).toContain('export default')
  })

  it('条件编译：只有 template 的 SFC 也能产出', async () => {
    const files = await buildFixture('conditional')
    const only = contentOf(files, 'TemplateOnly.vue')

    expect(only).toContain('<!-- #ifdef MP-WEIXIN -->')
    expect(only).toContain('<!-- #ifdef H5 -->')
    expect(only).toContain('<!-- #endif -->')
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
