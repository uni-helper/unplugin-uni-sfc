import type { UnpluginFactory, UnpluginOptions } from 'unplugin'
import type { ModuleReference } from './reference'
import type { Options, Warn } from './types'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { createUnplugin } from 'unplugin'
import { downgradeSFC } from './downgrade'
import { applyEdits, replaceSpecifiers, toSpecifier } from './shared'
import { toModuleView } from './view'

const SFC_RE = /\.(?:vue|nvue)$/

/** `.vue` 的请求可能带 query（`./App.vue?raw`），这里只取文件部分 */
function toId(source: string): string {
  return source.split('?')[0]
}

/**
 * 插件产出的 .vue 是 ESM 源码（降级只处理语言，不改模块语法），
 * 只有 ESM 产物能引用它：rolldown / tsdown 叫 'esm'，rollup / vite 叫 'es'；
 * 未设置 format 时打包工具的默认值也是 ESM。
 */
function isEsmFormat(format?: string): boolean {
  return !format || format === 'es' || format === 'esm'
}

/** 用到的那部分打包工具上下文。unplugin 没有声明 resolve，这里按 rollup / rolldown / vite 都提供的接口补上。 */
interface BundlerContext {
  emitFile: (file: { type: 'asset', fileName: string, originalFileName?: string, source: string }) => string
  resolve: (source: string, importer: string, options: { skipSelf: boolean }) => Promise<{ id: string, external?: boolean } | null | undefined>
  warn: Warn
}

/** 用到的那部分产物信息 */
interface OutputChunkLike {
  type: 'chunk'
  fileName: string
  code: string
  /** 该 chunk 包含的模块，键是模块 id */
  modules: Record<string, unknown>
  imports: string[]
  dynamicImports?: string[]
}

/** 用到的那部分输出配置 */
interface OutputOptionsLike {
  format?: string
}

interface OutputAssetLike {
  type: 'asset'
  fileName: string
  source: string | Uint8Array
}

type OutputBundleLike = Record<string, OutputChunkLike | OutputAssetLike>

interface SfcOutput {
  id: string
  /** 在产物中的路径；要到生成阶段才能确定（见 generateBundle） */
  fileName: string
  /** 降级后的 .vue 源码，既作为资产输出，也用来生成 JS 视图 */
  code: string
  /** 源码里引用的模块，与 JS 视图共用同一次解析（见 view/index.ts），在 load 里赋上 */
  references: ModuleReference[]
}

/**
 * 只接管 .vue：把降级后的 SFC 交给打包工具当成普通 JS 模块解析（`load` 返回模块视图），
 * 依赖图、解析、编译、产物命名全部由打包工具完成；
 * 生成阶段再把 .vue 对应的 chunk 换成真正的 .vue 文件——位置与它的 JS chunk 同位、只换回扩展名，
 * 镜像基准完全由打包工具决定，并把引用回填成 .vue。
 */
export const unpluginFactory: UnpluginFactory<Options | undefined, false> = () => {
  // .vue 源文件 -> 产物
  const outputs = new Map<string, SfcOutput>()
  // .vue 视图里的引用：specifier -> 打包工具解析出的模块 id（null 表示外部依赖或解析不到）
  const resolvedImports = new Map<string, Map<string, string | null>>()
  // 兜底产物路径 -> 源文件，用来发现重名
  const fallbackNames = new Map<string, string>()

  /** 打包工具没有给出模块位置（如被 tree-shaking 丢掉）时的兜底路径：退化为文件名，重名时补一段源文件哈希 */
  function toFallbackFileName(id: string, warn: Warn): string {
    const fileName = path.basename(id)
    const taken = fallbackNames.get(fileName)
    if (!taken || taken === id) {
      fallbackNames.set(fileName, id)
      return fileName
    }
    const extension = path.extname(fileName)
    const unique = `${fileName.slice(0, fileName.length - extension.length)}-${createHash('sha1').update(id).digest('hex').slice(0, 6)}${extension}`
    warn(`${id} 的产物路径与 ${taken} 重名，已改用 ${unique}`)
    fallbackNames.set(unique, id)
    return unique
  }

  /** .vue 的资产与它的 JS chunk 同位：镜像基准、去重都是打包工具算好的，这里只把扩展名换回源文件的 */
  function toAssetFileName(chunkFileName: string, id: string): string {
    const chunkExtension = path.posix.extname(chunkFileName)
    const stem = chunkExtension ? chunkFileName.slice(0, chunkFileName.length - chunkExtension.length) : chunkFileName
    return `${stem}${path.extname(id)}`
  }

  /** 读取 .vue 并降级 TS；资产统一在生成阶段产出，因为位置要到那时才能确定 */
  async function loadSfc(id: string, warn: Warn): Promise<SfcOutput | undefined> {
    const existing = outputs.get(id)
    if (existing)
      return existing

    let source: string
    try {
      source = fs.readFileSync(id, 'utf-8')
    }
    catch (error) {
      warn(`${id} 读取失败，产物中不会包含它：${(error as Error).message}`)
      return
    }

    // 先登记：模块视图里的 resolveId 要靠它认出 .vue 的引用
    const output: SfcOutput = { id, fileName: '', code: source, references: [] }
    outputs.set(id, output)

    // null 表示没有需要降级的内容，保留原文；SFC 解析失败由 downgradeSFC 抛错中断构建
    output.code = (await downgradeSFC(source, id, warn)) ?? source
    return output
  }

  return {
    name: 'unplugin-uni-sfc',
    enforce: 'pre',
    buildStart() {
      outputs.clear()
      resolvedImports.clear()
      fallbackNames.clear()
    },
    async resolveId(this: BundlerContext, source: string, importer: string | undefined) {
      // 只记录 .vue 视图里的引用：解析本身还是交给打包工具，生成阶段用它回填 .vue 里的路径
      if (!importer)
        return
      const sfcId = toId(importer)
      if (!outputs.has(sfcId))
        return
      const resolved = await this.resolve(source, importer, { skipSelf: true })
      let record = resolvedImports.get(sfcId)
      if (!record)
        resolvedImports.set(sfcId, record = new Map())
      record.set(source, resolved && !resolved.external ? toId(resolved.id) : null)
      // 直接复用打包工具解析出来的结果，避免同一个引用被解析两次
      return resolved ?? undefined
    },
    async load(this: BundlerContext, id: string) {
      const fileId = toId(id)
      // 带 query 的请求（如 `?raw`）与虚拟模块不属于本插件处理范围
      if (id !== fileId || !SFC_RE.test(fileId) || !fs.existsSync(fileId))
        return

      const warn: Warn = message => this.warn(message)
      const output = await loadSfc(fileId, warn)
      if (!output)
        return

      // 交给打包工具一个 JS 模块视图，让它按标准流程解析 .vue 里的引用；
      // 视图和引用共用同一次解析，generateBundle 直接复用引用，不再重复解析源码
      const view = toModuleView(output.code, fileId, warn)
      output.references = view.references
      return view.code
    },
    outputOptions(this: BundlerContext, options: OutputOptionsLike) {
      // 本插件只支持 ESM 产物（见 isEsmFormat），非 ESM 格式（cjs / iife / umd 等）
      // 不接管按模块产出，按用户配置原样输出，由 generateBundle 给出统一提示。
      // ESM 下 .vue 必须一个模块一个产物才能换回 .vue 文件，这里直接替用户打开 preserveModules；
      // 镜像基准（preserveModulesRoot 等）是打包工具的配置，插件不碰。
      if (!isEsmFormat(options.format))
        return
      return { ...options, preserveModules: true }
    },
    generateBundle(this: BundlerContext, options: OutputOptionsLike, bundle: OutputBundleLike) {
      const warn: Warn = message => this.warn(message)

      // 非 ESM 产物无法引用 ESM 源码的 .vue 资产：此时不接管产物，JS 按打包工具
      // 默认行为输出，降级后的 .vue 仍作为资产保留，提示后直接返回
      if (!isEsmFormat(options.format)) {
        warn(`产物格式 ${options.format} 不受支持：本插件产出的 .vue 是 ESM 源码，只支持 ESM 产物（'esm' / 'es'）；本次构建不会把 .vue 模块换回 .vue 文件，引用也不会回填`)
        for (const output of outputs.values()) {
          output.fileName = toFallbackFileName(output.id, warn)
          this.emitFile({ type: 'asset', fileName: output.fileName, originalFileName: output.id, source: output.code })
        }
        return
      }

      // 1. 找出 .vue 的 chunk，并记下每个模块最终落在哪个产物里
      const outputByModuleId = new Map<string, string>()
      const sfcChunks = new Map<string, SfcOutput>()
      for (const [fileName, item] of Object.entries(bundle)) {
        if (item.type !== 'chunk')
          continue
        const moduleIds = Object.keys(item.modules)
        const sfcModules = moduleIds.filter(id => outputs.has(id))
        // 一个 chunk 只装一个 .vue 模块时，才能换成 .vue 文件
        if (sfcModules.length === 1 && moduleIds.length === 1) {
          const output = outputs.get(sfcModules[0])!
          output.fileName = toAssetFileName(fileName, sfcModules[0])
          sfcChunks.set(fileName, output)
          continue
        }
        if (sfcModules.length) {
          warn(`${sfcModules.join('、')} 与其它模块被合进了 ${fileName}，无法换成 .vue 文件；需要打包工具按模块产出（rolldown preserveModules / tsdown unbundle）`)
        }
        for (const id of moduleIds)
          outputByModuleId.set(id, fileName)
      }

      // 2. 删掉 .vue 的 chunk，把引用改回 .vue 产物
      for (const chunkFileName of sfcChunks.keys())
        delete bundle[chunkFileName]

      for (const item of Object.values(bundle)) {
        if (item.type !== 'chunk')
          continue
        const replacements = new Map<string, string>()
        for (const [chunkFileName, output] of sfcChunks) {
          const from = toSpecifier(item.fileName, chunkFileName)
          const to = toSpecifier(item.fileName, output.fileName)
          if (from === to)
            continue
          replacements.set(from, to)
          // 产物之间的引用一并更新（如 vite 的 manifest / html）
          item.imports = item.imports.map(name => (name === chunkFileName ? output.fileName : name))
          if (item.dynamicImports?.length)
            item.dynamicImports = item.dynamicImports.map(name => (name === chunkFileName ? output.fileName : name))
        }
        if (replacements.size)
          item.code = replaceSpecifiers(item.code, replacements)
      }

      // 3. 登记每个 .vue 在产物中的最终位置：没有对应 chunk 的（如被 tree-shaking 丢掉的模块）按文件名兜底；
      //    全部登记完才开始回填，.vue 之间的循环引用才有据可依
      for (const output of outputs.values()) {
        if (!output.fileName)
          output.fileName = toFallbackFileName(output.id, warn)
        outputByModuleId.set(output.id, output.fileName)
      }

      // 4. 回填 .vue 里的引用：用打包工具解析出的模块 + 它们的产物位置，然后把降级后的源码作为资产产出
      for (const output of outputs.values()) {
        const resolutions = resolvedImports.get(output.id)
        const edits = []
        if (resolutions?.size) {
          for (const reference of output.references) {
            const resolvedId = resolutions.get(reference.specifier)
            const fileName = resolvedId ? outputByModuleId.get(resolvedId) : undefined
            if (!fileName)
              continue
            const specifier = toSpecifier(output.fileName, fileName)
            if (specifier !== reference.specifier)
              edits.push({ start: reference.start, end: reference.end, text: JSON.stringify(specifier) })
          }
        }
        this.emitFile({
          type: 'asset',
          fileName: output.fileName,
          originalFileName: output.id,
          source: edits.length ? applyEdits(output.code, edits) : output.code,
        })
      }
    },
  } as unknown as UnpluginOptions
}

export const unplugin = /* #__PURE__ */ createUnplugin(unpluginFactory)

export default unplugin
