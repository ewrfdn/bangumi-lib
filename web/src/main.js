import { createApp } from 'vue'
import { createRouter, createWebHistory } from 'vue-router'
import App from './App.vue'
import Home from './views/Home.vue'
import Library from './views/Library.vue'
import Series from './views/Series.vue'
import Browse from './views/Browse.vue'
import Player from './views/Player.vue'
import Login from './views/Login.vue'
import Admin from './views/Admin.vue'
import { auth, checkSession } from './auth'
import './styles/main.css'

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/login', name: 'login', component: Login, meta: { title: '登录' } },
    { path: '/', name: 'home', component: Home, meta: { title: '首页' } },
    { path: '/library', name: 'library', component: Library, props: (r) => ({ library: r.query.library || '' }), meta: { title: '媒体库' } },
    { path: '/series', name: 'series', component: Series, props: (r) => ({ path: r.query.path || '', library: r.query.library || '' }), meta: { title: '作品详情' } },
    { path: '/admin', name: 'admin', component: Admin, meta: { title: '后台管理' } },
    { path: '/browse', name: 'browse', component: Browse, props: (r) => ({ path: r.query.path || '/', library: r.query.library || '' }), meta: { title: '浏览' } },
    { path: '/watch', name: 'watch', component: Player, props: (r) => ({ path: r.query.path || '', library: r.query.library || '', t: Number(r.query.t) || 0 }), meta: { title: '播放' } },
  ],
  scrollBehavior: (to, from, saved) => to.hash ? { el: to.hash, top: 80, behavior: 'smooth' } : saved || { top: 0 },
})

router.beforeEach(async (to) => {
  try {
    await checkSession()
  } catch {
    return to.name === 'login' ? true : { name: 'login', query: { redirect: to.fullPath } }
  }
  if (to.name === 'login') {
    return !auth.enabled || auth.authenticated ? '/' : true
  }
  if (auth.enabled && !auth.authenticated) return { name: 'login', query: { redirect: to.fullPath } }
})

window.addEventListener('anishare:unauthorized', () => {
  auth.authenticated = false
  auth.checked = false
  if (router.currentRoute.value.name !== 'login') {
    router.replace({ name: 'login', query: { redirect: router.currentRoute.value.fullPath } })
  }
})

router.afterEach((to) => {
  document.title = `${to.meta.title || 'AniShare'} · AniShare`
})

createApp(App).use(router).mount('#app')
