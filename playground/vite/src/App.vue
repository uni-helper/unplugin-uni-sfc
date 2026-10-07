<script setup lang="ts">
import { ref } from 'vue'
// 脚本侧的 less 引用：dev 下由 vite 实时编译，构建时由 vite 的 CSS 管线编译成 CSS 资产，
// 产物 .vue 里的 import 会回填成 CSS 资产的路径
import './styles/global.less'

const count = ref(0)
</script>

<template>
  <div>
    <p class="count">
      count: {{ count }}
    </p>
  </div>
</template>

<style lang="less">
/* SFC 内联的 less 由本插件编译成 CSS，产物不再依赖 less */
@accent-color: #42b883;

.count {
  color: @accent-color;
}
</style>
