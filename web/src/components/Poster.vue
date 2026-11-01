<script setup>
import { computed, ref } from 'vue'
import { api, hueFrom } from '../api'

const props = defineProps({
  name: { type: String, default: '' },
  poster: { type: String, default: '' },
  wide: { type: Boolean, default: false },
})

const failed = ref(false)
const imgSrc = computed(() => (props.poster && !failed.value ? api.fileUrl(props.poster) : ''))
const hue = computed(() => hueFrom(props.name))
const initial = computed(() => (props.name || '?').trim().slice(0, 1).toUpperCase())
const style = computed(() => ({
  '--h': `${hue.value}`,
  '--h2': `${(hue.value + 48) % 360}`,
}))
</script>

<template>
  <div class="poster" :class="{ wide }" :style="style">
    <img v-if="imgSrc" :src="imgSrc" :alt="name" loading="lazy" @error="failed = true" />
    <div v-else class="placeholder">
      <span class="initial">{{ initial }}</span>
    </div>
    <div class="gloss" />
    <div class="shade" />
  </div>
</template>

<style scoped>
.poster {
  position: relative;
  overflow: hidden;
  border-radius: 14px;
  aspect-ratio: 2 / 3;
  background: hsl(var(--h) 40% 14%);
  isolation: isolate;
}
.poster.wide {
  aspect-ratio: 16 / 9;
}
img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}
.placeholder {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  background:
    radial-gradient(120% 90% at 20% 10%, hsl(var(--h) 70% 28% / 0.9), transparent 60%),
    radial-gradient(120% 100% at 90% 100%, hsl(var(--h2) 75% 26% / 0.85), transparent 55%),
    linear-gradient(160deg, hsl(var(--h) 30% 12%), hsl(var(--h2) 30% 8%));
}
.initial {
  font-size: clamp(36px, 6vw, 64px);
  font-weight: 800;
  color: rgba(255, 255, 255, 0.86);
  text-shadow: 0 8px 30px rgba(0, 0, 0, 0.5);
  letter-spacing: 2px;
}
.gloss {
  position: absolute;
  inset: 0;
  background: linear-gradient(135deg, rgba(255, 255, 255, 0.14), transparent 38%);
  pointer-events: none;
}
.shade {
  position: absolute;
  inset: auto 0 0 0;
  height: 55%;
  background: linear-gradient(to top, rgba(0, 0, 0, 0.35), transparent);
  pointer-events: none;
}
</style>
