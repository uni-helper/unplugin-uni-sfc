<script>
// 纯 JS（没有 lang="ts"）：没有任何 TS 需要降级，指令仍必须被校验并原样透传
export default {
  data() {
    return { size: 1 }
  },
}
</script>

<template>
  <view>
    <!-- #ifdef H5 -->
    <text>h5</text>
    <!-- #endif -->
    <!-- #ifndef H5 -->
    <text>mp</text>
    <!-- #endif -->
  </view>
</template>
