<script setup lang="ts">
// 解构写法：默认值只存在于解构表达式里，类型声明上看不到
const { count = 1, other } = defineProps<{ count?: number, other?: string }>()
</script>

<template>
  <p>{{ count }}{{ other }}</p>
</template>
