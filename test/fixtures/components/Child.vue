<script setup lang="ts">
defineProps<{ value: number }>();
</script>
<template><slot name="header" title="child" /><slot /></template>
