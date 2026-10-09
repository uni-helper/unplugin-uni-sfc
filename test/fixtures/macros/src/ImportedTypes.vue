<script setup lang="ts">
import type { PanelEmits, PanelProps } from './panel'

const props = defineProps<PanelProps>()
const emit = defineEmits<PanelEmits>()
</script>

<template>
  <div class="panel">
    <p>{{ props.title }}: {{ props.count }}</p>
    <button @click="emit('close')">
      close
    </button>
  </div>
</template>
