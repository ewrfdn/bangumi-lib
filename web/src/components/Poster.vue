<script setup>
import { computed, ref, watch } from 'vue'
import { api, prettyTitle } from '../api'
const props = defineProps({
  name: { type: String, default: '' },
  src: { type: String, default: '' },
  poster: { type: String, default: '' },
  library: { type: String, default: '' },
  wide: { type: Boolean, default: false },
})
const srcFailed = ref(false)
const posterFailed = ref(false)
watch(() => [props.src, props.poster, props.library], () => {
  srcFailed.value = false
  posterFailed.value = false
})
const imgSrc = computed(() => {
  if (props.src && !srcFailed.value) return props.src
  if (props.poster && !posterFailed.value) return api.fileUrl(props.poster, props.library)
  return ''
})
const title = computed(() => prettyTitle(props.name))
const initial = computed(() => title.value.trim().slice(0, 1) || '▶')
function onError() {
  if (props.src && !srcFailed.value) srcFailed.value = true
  else posterFailed.value = true
}
</script>
<template>
  <div class="poster" :class="{ wide }">
    <img v-if="imgSrc" :src="imgSrc" :alt="name" loading="lazy" @error="onError" />
    <div v-else class="placeholder" aria-hidden="true"><span>{{ initial }}</span></div>
  </div>
</template>
<style scoped>
.poster { position: relative; overflow: hidden; border-radius: 5px; aspect-ratio: 2 / 3; background: #16131f; }
.poster.wide { aspect-ratio: 16 / 9; }
img { width: 100%; height: 100%; object-fit: cover; display: block; }
.placeholder { position: absolute; inset: 0; display: grid; place-items: center; border: 1px solid #a78bfa12; border-radius: inherit; background: linear-gradient(145deg, #201a30, #111016); }
.placeholder span { font-size: clamp(28px, 3vw, 48px); color: #a78bfa65; font-weight: 500; }
</style>
