<script setup lang="ts">
// 只有类型导入：oxc 擦除后没有值导入，会补一个 `export {}` 维持模块语义，
// 而 <script setup> 不允许出现 ES 模块导出
import type { PanelProps } from './panel'

const props = defineProps<{ tag?: string, size?: number }>()
const local: PanelProps | null = null
</script>

<template>
  <p>{{ props.tag }}{{ props.size }}{{ local }}</p>
</template>
