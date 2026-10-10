import antfu from '@antfu/eslint-config'

export default antfu({
  type: 'lib',
  ignores: [
    // 故意包含解析错误的测试数据，lint 它没有意义
    'test/fixtures/broken',
  ],
  vue: true,
}).append({
  files: ['test/fixtures/**'],
  rules: {
    // 条件编译的测试数据里，互斥分支各自声明同名变量是刻意为之：
    // 每个平台的实际投影里只会剩一处，是合法代码（详见 test/conditional.test.ts）
    'ts/no-redeclare': 'off',
    // 排序类规则会重排 import，把条件编译指令与被它守护的 import 拆开，
    // 直接破坏测试数据（指令会失去配对）。fixture 里的顺序是语义的一部分。
    'perfectionist/sort-imports': 'off',
    'import/order': 'off',
    'import/newline-after-import': 'off',
    'vue/padding-line-between-blocks': 'off',
    'vue/block-tag-newline': 'off',
  },
})
