<template>
  <!-- 只有模板的 SFC：同样要能处理条件编译 -->
  <view>
    <!-- #ifdef MP-WEIXIN -->
    <text>wx</text>
    <!-- #endif -->
    <!-- #ifdef H5 -->
    <text>h5</text>
    <!-- #endif -->
  </view>
</template>
