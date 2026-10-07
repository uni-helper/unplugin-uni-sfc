<script setup lang="ts">
import { ref } from 'vue'
// 脚本侧的样式引用：内容由打包工具的 CSS 管线编译成资产，产物 .vue 里的整句 import 会被移除
import './styles/global.less'

const count = ref<number>(0)
</script>

<template>
  <p class="count">
    count: {{ count + 1 }}
  </p>
</template>
