# unplugin-uni-sfc

将使用 TypeScript / Less 的 uni SFC（`.vue` / `.nvue`）降级为 JavaScript / CSS 的 SFC。

插件在打包阶段把 `lang="ts"` 的 script 块与模板表达式中的 TS 语法降级为 JS，把 `lang="less"` 的 style 块编译为 CSS，产物中的 `.vue` 以降级后的源码直接输出；依赖解析、编译和产物组织仍然交给打包工具（vite / rolldown / tsdown），插件不重复造轮子。

## 安装

环境要求：Node.js ≥ 20.19（或 ≥ 22.12）。

```bash
pnpm add -D @uni-helper/unplugin-uni-sfc
```

## 使用

**vite.config.ts**

```ts
import UnpluginUniSfc from '@uni-helper/unplugin-uni-sfc/vite'

export default defineConfig({
  plugins: [UnpluginUniSfc()],
})
```

插件只接管构建产物；dev server 下的 `.vue` 仍交给其它插件（如 `@vitejs/plugin-vue`）处理。

**tsdown.config.ts / rolldown 配置**

```ts
import UnpluginUniSfc from '@uni-helper/unplugin-uni-sfc/rolldown'

export default defineConfig({
  plugins: [UnpluginUniSfc()],
})
```

## 类型宏：defineProps / defineEmits

`defineProps<T>()` / `defineEmits<T>()` 以及 `withDefaults` 的运行时声明只存在于类型里，类型擦除后会丢失，插件会用 Vue 官方编译器（`extractRuntimeProps` / `extractRuntimeEmits`）把它们生成出来，回填到原宏调用处：

- 跨文件导入的类型（`import type { Props } from './props'`）会被解析——包括 `Pick`、`Omit`、`extends` 等；
- 类型解析需要 `typescript`，插件会从构建目录向上查找；同时支持 tsconfig 的 `paths` 别名（`@/types`），前提是工程里有 `tsconfig.json`；
- `withDefaults` 的默认值会合进 props 声明；若默认值无法静态内联（如展开、函数返回），声明里会用到 Vue 的 `mergeDefaults`，插件会自动补上它的导入；
- 解构写法 `const { count = 1 } = defineProps<T>()` 的默认值同样会保留。

类型解析失败时构建会**中断并报错**，而不是悄悄产出没有 props 声明的组件（那会让 props 退化成普通 attributes，到运行期才暴露）。此时请修正类型引用，或改用运行时声明 `defineProps({ ... })` / `defineEmits([...])`。

## 样式：less 降级为 CSS

`<style lang="less">` 会在构建时用 [less](https://lesscss.org) 编译为 CSS：变量替换、嵌套展开、`@import` 内联（相对 `.vue` 解析），并移除 `lang="less"` 标记，产物中的 `.vue` 不再依赖 less。

- **sass / scss 不需要处理**：uni-app 的编译器自带 sass，`lang="scss"` / `lang="sass"` 原样保留；
- 其它预处理器（stylus 等）不在降级范围内，同样原样保留；
- less 按可选依赖加载：只有 SFC 里出现 `lang="less"` 时才会用到，未安装时构建会报错并提示安装（`pnpm add -D less`）；
- 带 `src` 的外部样式块不处理（与 script 块的规则一致）：它们不会被降级，也不会进入产物，请改为内联样式或自行编译为 CSS。

## 脚本里 import 的样式文件

SFC 脚本里的样式引用（`import './styles/global.less'`）由打包工具的 CSS 管线编译（tsdown 需要 [`@tsdown/css`](https://tsdown.dev/plugins/css)，vite 自带），插件负责处理产物 `.vue` 里对应的引用：

- CSS 管线在渲染阶段已产出对应的 CSS 资产时（vite `cssCodeSplit: true`），引用回填成 CSS 资产的路径，下游构建会正常加载它；
- 资产要到构建收尾才产出时（如 tsdown 的 `@tsdown/css`），整句 `import` 从产物中移除（与打包工具对 JS 导入方的处理一致），并给出告警——编译出的 CSS 仍会作为资产输出，需要时自行引入。

产物中的 `.vue` 不会引用不存在的文件，也不会把 `.less` 引用留给不支持 less 的下游。

## 只支持 ESM 产物

本插件本质是**语言降级**（TS → JS），不改模块语法：产出的 `.vue` 资产本身就是 ESM 源码（`import` / `export`），产物中的 JS 也需要以 ESM 引用这些 `.vue` 文件，因此**只支持 ESM 产物格式**。

- 支持：`esm`（rolldown / tsdown）、`es`（rollup / vite）；未设置 `format` 时打包工具的默认值也是 ESM
- 不支持：`cjs`、`iife`、`umd`、`amd` 等

使用非 ESM 格式时，插件会在构建时警告并保持原样：

- `.vue` 模块不会换回 `.vue` 文件，引用也不会回填，JS 按打包工具的默认行为输出；
- 降级后的 `.vue` 源码仍会作为资产输出，但产物中的 JS 不会引用它们。

## 不支持条件编译

本插件不做 uni-app 条件编译（`#ifdef` / `#ifndef` / `#endif`）的预处理：SFC（script、模板、style）中出现条件编译指令时，构建会直接报错中断，而不是把指令原样保留进产物。

请用 `if` 分支判断替代条件编译，推荐 [`@uni-helper/uni-env`](https://github.com/uni-helper/uni-env)：

```ts
import { isH5 } from '@uni-helper/uni-env'

if (isH5) {
  // 仅 H5 执行
}
```

`uni-env` 提供各平台的判断值（`isH5`、`isMpWeixin`、`isApp` 等），读取的是 uni-app 构建期注入的环境值，经 Vite define 静态替换成字面量；不想引入依赖时，也可以直接写 `if (process.env.UNI_PLATFORM === 'h5') { ... }`。

## 产物形态

`.vue` 必须一个模块一个产物才能在生成阶段换回 `.vue` 文件。插件会在 ESM 产物下自动打开 `preserveModules`（对应 tsdown `unbundle: true`），无需手动配置。

`.vue` 在产物中的位置与它的 JS 模块同位（只把扩展名换回 `.vue` / `.nvue`），镜像基准完全由打包工具决定：rolldown / rollup 按 `preserveModules` 的规则推导，tsdown `unbundle` 下对应 `root` 配置。插件不拥有任何产物形态的配置，也没有可配置项——它本质上是做降级处理，产物组织全部交给打包工具。

## License

[MIT](./LICENSE)
