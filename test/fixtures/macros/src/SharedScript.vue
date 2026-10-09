<script lang="ts">
// 普通 <script> 里声明的类型，<script setup> 可以直接引用（两个块共享作用域）
export interface SharedProps {
  alpha: string
  beta?: number
}
</script>

<script setup lang="ts">
const props = defineProps<SharedProps>()
</script>

<template>
  <p>{{ props.alpha }}{{ props.beta }}</p>
</template>
