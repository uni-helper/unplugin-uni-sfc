<script>
export default {
  data() {
    return { text: 'plain' }
  },
}
</script>

<template>
  <p class="plain">
    {{ text }}
  </p>
</template>

<style lang="less">
@size: 12px;
.plain {
  font-size: @size;
}
</style>
