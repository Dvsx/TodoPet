<script setup lang="ts">
defineProps<{ name: 'tasks' | 'trash' | 'spark' | 'wrap' | 'review' | 'health' }>()

// A shared 24-unit grid keeps the sidebar's icons aligned at every display scale.
const paths = {
  tasks: 'M9 5H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-3 M9 3h6v4H9z M8 13l2 2 5-5 M8 18h8',
  trash: 'M4 6h16 M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2 M6 6l1 13a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-13 M10 10v7 M14 10v7',
  spark: 'M9 17v-1.2c0-1-.6-1.9-1.3-2.6a6 6 0 1 1 8.6 0c-.7.7-1.3 1.6-1.3 2.6V17z M9 20h6 M11 22h2',
  wrap: 'M5 3h13a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z M8 3v18 M11 8h5 M11 12h5 M11 16h3',
  review: 'M4 3v16a1 1 0 0 0 1 1h16 M9 15v-4 M14 15V6 M19 15V9',
  health: 'M20.4 5.6a5.4 5.4 0 0 0-7.6 0l-.8.8-.8-.8a5.4 5.4 0 0 0-7.6 7.6L12 21l8.4-7.8a5.4 5.4 0 0 0 0-7.6 M3 12h4l2-3 3 6 2-3h4'
} as const
</script>

<template>
  <svg class="sidebar-icon" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">
    <path :d="paths[name]" />
  </svg>
</template>
