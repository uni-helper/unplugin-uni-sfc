<script setup lang="ts">
import { ref } from 'vue'
import TheHeader from './components/TheHeader.vue'
import { HEADER } from './constant'
// 脚本侧的 less 引用：由打包工具的 CSS 管线（@tsdown/css）编译成 CSS 资产，
// 产物 .vue 里这行 import 会被整句移除（同打包工具对 JS 的处理），控制台会有对应的告警
import './styles/global.less'

const count = ref<number>(0)
</script>

<template>
  <div>
    <TheHeader :title="HEADER" />
    <p class="count">
      count: {{ (count as number) + 10 }}
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
