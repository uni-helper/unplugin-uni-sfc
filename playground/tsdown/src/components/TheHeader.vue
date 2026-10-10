<script setup lang="ts">
import { ref } from 'vue'

defineProps<{
  title?: string
}>()
// #ifdef H5
const description = ref<string>('这是一个H5页面的标题')
// #endif
// #ifdef MP-WEIXIN
const description = ref<string>('')
description.value = '这是一个微信小程序的标题'
// #endif
</script>

<template>
  <div class="header">
    {{ title }}
    {{ description.value }}
  </div>
</template>

<style lang="less" scoped>
/* scoped 的 less 块同样由本插件编译：lang 标记移除，scoped 保留 */
@title-size: 16px;

.header {
  font-size: @title-size;
}
</style>
