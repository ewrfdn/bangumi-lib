import { createApp } from 'vue'
import { createRouter, createWebHistory } from 'vue-router'
import App from './App.vue'
import Home from './views/Home.vue'
import Browse from './views/Browse.vue'
import Player from './views/Player.vue'
import './styles/main.css'

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', name: 'home', component: Home, meta: { title: '番剧库' } },
    { path: '/browse', name: 'browse', component: Browse, props: (r) => ({ path: r.query.path || '/' }), meta: { title: '浏览' } },
    { path: '/watch', name: 'watch', component: Player, props: (r) => ({ path: r.query.path, t: Number(r.query.t) || 0 }), meta: { title: '播放' } },
  ],
  scrollBehavior: (to, from, saved) => saved || { top: 0 },
})

router.afterEach((to) => {
  document.title = `${to.meta.title || 'AniShare'} · AniShare`
})

createApp(App).use(router).mount('#app')
