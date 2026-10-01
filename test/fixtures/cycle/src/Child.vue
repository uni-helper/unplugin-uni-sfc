<script setup lang="ts">
import App from './App.vue'

const label: string = 'child'
</script>

<template>
  <span>{{ label }} {{ App ? '' : '' }}</span>
</template>
