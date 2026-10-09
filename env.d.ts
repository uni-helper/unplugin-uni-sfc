/**
 * `.vue` 单文件组件的模块声明。
 *
 * 只为了让 `tsc` 能通过测试数据与 playground 里的 `import App from './App.vue'`：
 * 插件在构建期把 `.vue` 当模块处理，但 TypeScript 不认识这个扩展名。
 * 组件自身的类型由此处的兜底声明提供，插件不消费组件的组件类型。
 */
declare module '*.vue' {
  const component: new (...args: unknown[]) => unknown
  export default component
}
