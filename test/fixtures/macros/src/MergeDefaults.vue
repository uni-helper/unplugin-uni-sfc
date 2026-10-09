<script setup lang="ts">
// 非静态默认值（展开、函数）会让 Vue 走 mergeDefaults 分支，声明里会出现 helper 引用
const props = withDefaults(defineProps<{ label?: string, list?: string[] }>(), {
  ...{ label: 'default' },
  list: () => [],
})
</script>

<template>
  <p>{{ props.label }}{{ props.list?.length }}</p>
</template>
