<script setup lang="ts">
// 只在某个平台出现的导入：每个平台投影都必须能解析到它
// #ifdef MP-WEIXIN
import { WX_ONLY } from './wx-only'
// #endif
// #ifdef H5
import { H5_ONLY } from './h5-only'
// #endif

const tag: string = 'child'
</script>

<template>
  <view>
    <!-- #ifdef MP-WEIXIN -->
    <text>{{ WX_ONLY }}</text>
    <!-- #endif -->
    <!-- #ifdef H5 -->
    <text>{{ H5_ONLY }}</text>
    <!-- #endif -->
    <text>{{ tag }}</text>
  </view>
</template>
