<script setup lang="ts">
const props = defineProps({ label: { type: String, required: true } })
const emit = defineEmits(['tap'])

const n: number = 1
</script>

<template>
  <p @click="emit('tap')">
    {{ props.label }}{{ n }}
  </p>
</template>
