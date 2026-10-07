<script setup lang="ts">
defineProps<{
  title?: string
}>()
</script>

<template>
  <div class="header">
    {{ title }}
  </div>
</template>

<style lang="less" scoped>
/* scoped 的 less 块同样由本插件编译：lang 标记移除，scoped 保留 */
@title-size: 16px;

.header {
  font-size: @title-size;
}
</style>
