<script setup lang="ts">
import { ref } from 'vue'
import Child from '@/Child.vue'
import { HEADER } from './constant'
import Plain from './Plain.vue'

const count: number = ref(0)
const list: number[] = [1, 2]
</script>

<template>
  <div>
    {{ HEADER }}
    <p>count: {{ count }}</p>
    <p>count10: {{ (count as number) + 10 }}</p>
    <p>{{ { x: count as number } }}</p>
    <p v-if="count! > 0">
      v-if 中的非空断言
    </p>
    <p v-for="item of (list as number[])" :key="item">
      {{ item }}
    </p>
    <Plain />
    <Child />
  </div>
</template>

<style lang="less">
@import './vars';

.header {
  color: @header-color;
  .title {
    font-weight: bold;
  }
}
</style>

<style lang="scss" scoped>
/* uni-app 自带 sass，scss 原样保留 */
.title {
  color: $title-color;
}
</style>
