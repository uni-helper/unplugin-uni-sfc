---
name: unplugin-uni-sfc
description: 安装、配置和排障 @uni-helper/unplugin-uni-sfc——把 uni-app 的 TypeScript / Less SFC（.vue / .nvue）在构建阶段降级为 JavaScript / CSS 的构建插件。当用户提到 unplugin-uni-sfc、uni-sfc，想让 uni-app 组件库构建产物去掉 TS / less 依赖，配置 defineProps 类型宏回填，或遇到该插件的构建报错（条件编译、类型解析失败、less 缺失、非 ESM 产物警告）时使用本技能。
---

# unplugin-uni-sfc

把使用 TypeScript / Less 的 [uni-app](https://uniapp.dcloud.net.cn/) SFC（`.vue` / `.nvue`）在**构建阶段**降级为 JavaScript / CSS：`lang="ts"` 的 script 与模板表达式擦除为 JS，`lang="less"` 的 style 编译为 CSS，产物中的 `.vue` 以降级后的源码直接输出。典型场景是发布 uni-app 组件库时，让产物不再依赖 TypeScript / less 编译链。

依赖解析、编译和产物组织仍交给打包工具（vite / rolldown / tsdown），插件本身**零配置**——`UnpluginUniSfc()` 不接收任何参数。

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
2. **不支持条件编译**：SFC（script、模板、style）注释里出现 `#ifdef` / `#ifndef` / `#if` / `#elif` / `#endif` 时构建直接中断。改用运行时 `if` 判断，推荐 [`@uni-helper/uni-env`](https://github.com/uni-helper/uni-env)（`isH5`、`isMpWeixin`、`isApp` 等），或直接写 `if (process.env.UNI_PLATFORM === 'h5') { ... }`。
3. **带 `src` 的外部块不处理**：`<script src>` / `<style src>` 既不会降级也不会进产物，改为内联。
4. **失败即中断**：类型解析失败、less 编译失败、解析失败都会抛错终止构建，不会静默产出缺 props 声明的组件。这是有意设计，不要试图绕过。

## 4. 排错速查

按报错文案对号入座：

| 报错 / 现象 | 原因 | 处理 |
| --- | --- | --- |
| `SFC 使用了 <style lang="less">，但未安装 less` | SFC 有 `lang="less"` 但项目没装 less | `pnpm add -D less` |
| `<style lang="less"> 编译失败` | less 源码有语法错误 | 按报错位置修 less 源码 |
| `使用了 uni-app 条件编译（#ifdef …），本插件不支持条件编译` | SFC 注释里有条件编译指令 | 删掉指令，改用 `if` 分支（见第 3 节） |
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
- 产物 JS 里对组件的引用指向 `.vue` 文件；
- 使用类型宏的组件，`defineProps` 调用处已回填运行时声明（props 对象 / emits 数组）。
