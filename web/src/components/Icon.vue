<script setup>
defineProps({ name: String, size: { type: [Number, String], default: 20 } })
const paths = {
  play: 'm9 5 11 7-11 7V5Z',
  'chevron-right': 'm9 5 7 7-7 7',
  'chevron-left': 'm15 5-7 7 7 7',
  folder: 'M3 7V5a1 1 0 0 1 1-1h5l3 3h8a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V7Z',
  search: 'M20 20l-4.5-4.5M17 10a7 7 0 1 1-14 0 7 7 0 0 1 14 0Z',
  grid: 'M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z',
  list: 'M8 5h13M8 12h13M8 19h13M3 5h.01M3 12h.01M3 19h.01',
  'arrow-right': 'M4 12h16m-6-6 6 6-6 6',
  'arrow-up-right': 'M6 18 18 6M6 6h12v12',
  refresh: 'M20 7v5h-5M4 17v-5h5M5.5 7a7 7 0 0 1 11.6-1L20 9M4 15l2.9 3a7 7 0 0 0 11.6-1',
  logout: 'M9 4H5v16h4M10 12h11m-5-5 5 5-5 5',
  trash: 'M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M6 7l1 13h10l1-13M10 11v6M14 11v6',
  close: 'm6 6 12 12M6 18 18 6',
  check: 'm5 12 4 4L19 6',
  film: 'M4 3h16v18H4zM4 8h16M4 16h16M8 3v5M16 3v5M8 16v5M16 16v5',
  clock: 'M12 7v5l3 2M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z',
  settings: 'M4 6h16M4 12h16M4 18h16M8 3v6M16 9v6M10 15v6',
  shield: 'm12 3 8 3v6c0 4-4 7-8 9-4-2-8-5-8-9V6l8-3Zm-4 9 3 3 5-6',
}
</script>
<template>
  <svg :width="size" :height="size" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path :d="paths[name] || paths.film" /></svg>
</template>
