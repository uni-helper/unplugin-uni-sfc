---
name: unplugin-uni-sfc
description: 安装、配置和排障 @uni-helper/unplugin-uni-sfc——把 uni-app 的 TypeScript / Less SFC（.vue / .nvue）在构建阶段降级为 JavaScript / CSS 的构建插件，条件编译指令原样透传给下游。当用户提到 unplugin-uni-sfc、uni-sfc，想让 uni-app 组件库构建产物去掉 TS / less 依赖，配置 defineProps 类型宏回填，处理 #ifdef 条件编译，或遇到该插件的构建报错（条件编译写法不安全、类型解析失败、less 缺失、非 ESM 产物警告）时使用本技能。
---

# unplugin-uni-sfc

把使用 TypeScript / Less 的 [uni-app](https://uniapp.dcloud.net.cn/) SFC（`.vue` / `.nvue`）在**构建阶段**降级为 JavaScript / CSS：`lang="ts"` 的 script 与模板表达式擦除为 JS，`lang="less"` 的 style 编译为 CSS，产物中的 `.vue` 以降级后的源码直接输出。典型场景是发布 uni-app 组件库时，让产物不再依赖 TypeScript / less 编译链。

依赖解析、编译和产物组织仍交给打包工具（vite / rolldown / tsdown），插件本身**零配置**——`UnpluginUniSfc()` 不接收任何参数。

条件编译（`#ifdef` / `#ifndef` / `#if` / `#else` / `#endif`）**不执行**，而是逐字节保留在产物里交给下游 uni-app。插件只负责保证：指令还在原位，且产物在每个平台的实际投影下都是正确的 JS / CSS。

## 1. 安装

环境要求：Node.js ≥ 20.19（或 ≥ 22.12）。

```sh
pnpm add -D @uni-helper/unplugin-uni-sfc
```

以下可选 peer 依赖只服务构建过程，产物不依赖它们、下游用户无需安装；按项目实际用到再装，不用全装：

| 场景 | 需要安装 |
| --- | --- |
| SFC 使用 `defineProps<T>()` / `defineEmits<T>()` / `withDefaults` 类型宏 | `typescript`（≥ 4.5，从运行构建的目录 `process.cwd()` 解析，找不到时回退到插件自身的依赖） |
| SFC 使用 `<style lang="less">` | `less`（^3.5.0 \|\| ^4.0.0） |
| 用 tsdown 构建且脚本里 `import` 了样式文件 | `@tsdown/css` |

`sass` / `scss` 不需要装：uni-app 编译器自带 sass，`lang="scss"` 会原样保留，本插件不处理。

## 2. 配置

### vite.config.ts

```ts
import UnpluginUniSfc from '@uni-helper/unplugin-uni-sfc/vite'

export default defineConfig({
  plugins: [UnpluginUniSfc()],
  build: {
    lib: { entry: 'src/index.ts', formats: ['es'] },
    // 脚本里 import 的样式文件（如 import './x.less'）需要它才能在渲染阶段
    // 产出 CSS 资产、被插件回填成资产路径；SFC 块内样式不受此项影响，开着即可
    cssCodeSplit: true,
  },
})
```

dev server 下的 `.vue` 仍交给其它插件（如 `@vitejs/plugin-vue`）处理，本插件只接管构建产物——dev 下 `.vue` 没被它处理是预期行为。

### tsdown.config.ts（rolldown 同理）

```ts
import UnpluginUniSfc from '@uni-helper/unplugin-uni-sfc/rolldown'

export default defineConfig({
  plugins: [UnpluginUniSfc()],
  entry: ['src/index.ts'],
})
```

插件会在 ESM 产物下自动打开 `preserveModules`（tsdown 对应 `unbundle: true`），无需手动配置；产物 `.vue` 与它的 JS 模块同位，只把扩展名换回 `.vue` / `.nvue`。

## 3. 硬性约束

写配置前先核对这几条，违反时插件会报错（或警告）而不是产出坏组件：

1. **只支持 ESM 产物**：`format` 用 `es` / `esm`；`cjs` / `iife` / `umd` / `amd` 不支持。未设置时打包工具的默认值也是 ESM，一般不用管。
2. **条件编译原样透传**：`#ifdef` / `#ifndef` / `#if` / `#else` / `#endif` 会被逐字节保留给下游 uni-app，插件不执行条件编译，只保证产物在每个平台下都是正确的 JS / CSS。指令必须写在注释里，且**独占一行**：script 用 `// #ifdef` 或 `/* #ifdef */`，模板用 `<!-- #ifdef -->`，style **只能**用 `/* #ifdef */`。
3. **带 `src` 的外部块不处理**：`<script src>` / `<style src>` 既不会降级也不会进产物，改为内联。
4. **失败即中断**：类型解析失败、less 编译失败、解析失败都会抛错终止构建，不会静默产出缺 props 声明的组件。这是有意设计，不要试图绕过。

### 条件编译里会被拒绝的写法

这些写法 uni-app 自己也会做错（静默丢代码或留下失效指令），插件选择中断构建。检查覆盖 **script / template / style 三个块**，没有 TS 的组件也会检查：

| 写法 | 原因 |
| --- | --- |
| `#elif` | uni-app 的预处理不支持它，指令会残留在产物里 |
| 平台名拼写错误（`#ifdef H5-WRONG`） | uni-app 按「假」处理，整块代码会凭空消失 |
| 起始关键字大小写写错（`#IfDeF` / `#IFDEF`） | uni-app 只认小写，写错会让它内部抛错并回退成原文，整段代码在所有平台生效 |
| 缺 `#endif` / 多余的 `#endif` | uni-app 的预处理直接失败 |
| `#ifdef` 落在语句内部（对象字面量、数组、参数列表中间）且该处有 TS | 切开的片段不是合法语法，无法安全擦除 TS |
| style 里用 `// #ifdef` | less 会吃掉行注释，指令传不到产物 |
| 指令写在 less 的嵌套规则内部 | less 会把规则提到指令外面，样式会在所有平台生效 |

结束关键字的大小写**不受限制**：`#ENDIF` / `#EndIf` / `#Else` 都正常。

合法的写法（**允许**，不要误报为错误）：互斥分支里各自声明同名变量——每个平台的投影里只会剩一处，是合法代码。

```vue
<script setup lang="ts">
// #ifdef H5
const platform: string = 'h5'
// #endif
// #ifndef H5
const platform: string = 'mp'
// #endif
</script>
```

## 4. 排错速查

按报错文案对号入座：

| 报错 / 现象 | 原因 | 处理 |
| --- | --- | --- |
| `SFC 使用了 <style lang="less">，但未安装 less` | SFC 有 `lang="less"` 但项目没装 less | `pnpm add -D less` |
| `<style lang="less"> 编译失败` | less 源码有语法错误 | 按报错位置修 less 源码 |
| `使用了本插件无法安全处理的条件编译` + 逐条列出问题 | 用了上一节表格里的写法 | 按列表逐条修正；`#elif` 改用嵌套 `#ifdef` 或 `\|\|` 表达式 |
| `条件编译指令在 <平台> 下守不住对应的样式` | 指令写在 less 嵌套规则内部，规则被提到指令外面 | 把指令移到顶层规则之间 |
| `less 编译会吃掉行注释（//）` | style 里用了 `// #ifdef` | 改成 `/* #ifdef ... */` |
| `解析失败，无法降级为 JS` | script / 模板里有 TS 擦不掉或语法非法的内容 | 按报错位置修正源码 |
| 类型宏解析失败（跨文件类型、tsconfig paths 解析不出来） | `defineProps<T>()` 的类型无法静态解析 | 修正类型引用；或改用运行时声明 `defineProps({ ... })` / `defineEmits([...])` |
| `产物格式 … 不受支持：本插件产出的 .vue 是 ESM 源码，只支持 ESM 产物` | `format` 设成了 cjs / iife / umd 等 | 改为 `es` / `esm` |
| `与其它模块被合进了 …，无法换成 .vue 文件` | 打包工具把多个模块合并进一个 chunk | 确保走插件自动打开的 `preserveModules` / `unbundle`，不要手动关闭 |
| tsdown 下脚本 import 的样式整句被移除且有告警 | CSS 资产在构建收尾才产出，引用无处回填 | 装 `@tsdown/css`；编译出的 CSS 会作为资产输出，需要时自行引入 |
| 产物里没有 `.vue` 文件 | 产物非 ESM 或插件未注册 | 检查 `format` 与插件注册；非 ESM 时插件只警告不接管 |
| dev server 下 `.vue` 没被降级 | 预期行为 | 插件只管构建产物，dev 交给 `@vitejs/plugin-vue` 等其它插件 |

## 5. 验证产物

构建完成后检查：

- `dist` 中出现 `.vue` 文件，内容是降级后的源码：无 `lang="ts"`、无 TS 类型标注、无 `lang="less"`；
- 产物 JS 里对组件的引用指向 `.vue` 文件，且每条 import 都能在 `dist` 里找到对应文件（不会悬空）；
- 使用类型宏的组件，`defineProps` 调用处已回填运行时声明（props 对象 / emits 数组）；
- 用了条件编译的组件，产物里的 `#ifdef` / `#endif` 条数与源码一致，且每个平台独占的模块都出现在 `dist` 中。
