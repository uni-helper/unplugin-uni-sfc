<script setup lang="ts">
import { ref } from 'vue'
import TheHeader from './components/TheHeader.vue'
import { HEADER } from './constant'

const count = ref<number>(0)
</script>

<template>
  <div>
    <TheHeader :title="HEADER" />
    <p>count: {{ (count as number) + 10 }}</p>
  </div>
</template>
