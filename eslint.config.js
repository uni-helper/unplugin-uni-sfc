import antfu from '@antfu/eslint-config'

export default antfu({
  type: 'lib',
  ignores: [
    // 故意包含解析错误的测试数据，lint 它没有意义
    'test/fixtures/broken',
  ],
})
