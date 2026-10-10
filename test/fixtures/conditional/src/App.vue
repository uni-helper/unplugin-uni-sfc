<script setup lang="ts">
import Child from './Child.vue'

const name: string = 'conditional'

// #ifdef H5
const platform: string = 'h5'
// #endif
// #ifndef H5
const platform: string = 'mp'
// #endif

// 指令写在对象字面量内部：TS 擦除必须保住这两条指令
const config: Record<string, unknown> = {
  deep: true as boolean,
  // #ifdef APP-PLUS
  plus: 1 as number,
  // #endif
}

function label(who: string): string {
  return `${name}-${who}-${platform}`
}
</script>

<template>
  <view>
    <!-- #ifdef H5 -->
    <text>{{ label('h5') }}</text>
    <!-- #endif -->
    <!-- #ifdef MP-WEIXIN -->
    <text>{{ label('mp') }}</text>
    <!-- #endif -->
    <Child :config="config" />
  </view>
</template>

<style>
/* #ifndef H5 */
view {
  color: red;
}
/* #endif */
/* #ifdef H5 */
text {
  color: blue;
}
/* #endif */
</style>
