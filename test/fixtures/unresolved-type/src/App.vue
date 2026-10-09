<script setup lang="ts">
// 类型解析不了（模块不存在）：此时生成的运行时声明无法确定，构建应当中断
import type { Missing } from './not-exists'

const props = defineProps<Missing>()
</script>

<template>
  <p>{{ props }}</p>
</template>
