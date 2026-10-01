<script setup lang="ts">
import Child from './Child.vue'

const name: string = 'app'
</script>

<template>
  <div>
    {{ name }}
    <Child />
  </div>
</template>
