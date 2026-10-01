<script setup lang="ts">
import { ref } from 'vue'
import Child from '@/Child.vue'
import { HEADER } from './constant'

const count: number = ref(0)
const list: number[] = [1, 2]
</script>

<template>
  <div>
    {{ HEADER }}
    <p>count: {{ count }}</p>
    <p>count10: {{ (count as number) + 10 }}</p>
    <p v-if="count! > 0">
      v-if 中的非空断言
    </p>
    <p v-for="item of (list as number[])" :key="item">
      {{ item }}
    </p>
    <Child />
  </div>
</template>
