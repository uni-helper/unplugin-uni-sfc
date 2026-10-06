# unplugin-uni-sfc

将使用 TypeScript 的 uni SFC（`.vue` / `.nvue`）降级为 JavaScript 的 SFC。

插件在打包阶段把 `lang="ts"` 的 script 块与模板表达式中的 TS 语法降级为 JS，产物中的 `.vue` 以降级后的源码直接输出；依赖解析、编译和产物组织仍然交给打包工具（vite / rolldown / tsdown），插件不重复造轮子。

## 安装

环境要求：Node.js ≥ 18.12。

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
