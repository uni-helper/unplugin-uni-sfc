<script setup lang="ts">
const name: string = 'conditional'

// #ifdef H5
const platform: string = 'h5'
// #endif
</script>

<template>
  <view>
    <!-- #ifdef H5 -->
    <text>{{ platform }}</text>
    <!-- #endif -->
    <!-- #ifdef MP-WEIXIN -->
    <text>{{ name }}</text>
    <!-- #endif -->
  </view>
</template>

<style>
/* #ifndef H5 */
view {
  color: red;
}
/* #endif */
</style>
