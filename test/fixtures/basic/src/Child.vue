<script setup lang="ts">
import { MAGIC } from './nested/magic'

const label: string = `child: ${MAGIC}`
</script>

<template>
  <span>{{ label }}</span>
</template>
