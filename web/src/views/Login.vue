<script setup>
import { ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { auth, checkSession, login, loginDestination } from '../auth'

const route = useRoute()
const router = useRouter()
const key = ref('')
const visible = ref(false)
const busy = ref(false)
const error = ref('')

async function submit() {
  if (busy.value || !key.value) return
  busy.value = true
  error.value = ''
  try {
    await login(key.value)
    key.value = ''
    await router.replace(loginDestination(route.query.redirect))
  } catch (failure) {
    error.value = failure.status === 401 ? '密钥不正确' : failure.message || '暂时无法登录'
  } finally { busy.value = false }
}

async function reconnect() {
  busy.value = true
  try {
    await checkSession(true)
    if (!auth.enabled || auth.authenticated) await router.replace(loginDestination(route.query.redirect))
  } catch { /* auth.error supplies the connection state. */ }
  finally { busy.value = false }
}
</script>

<template>
  <div class="login-page">
    <main class="login-panel">
      <div class="login-brand"><svg width="25" height="25" viewBox="0 0 24 24" fill="none" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="5" stroke="currentColor" stroke-width="1.5"/><path d="m10 8 6 4-6 4Z" fill="currentColor"/></svg><span>AniShare</span></div>
      <h1>登录番剧库</h1>
      <div v-if="auth.error" class="connection-error" role="alert">
        <p>无法连接服务</p>
        <button class="btn" :disabled="busy" @click="reconnect">{{ busy ? '正在连接…' : '重新连接' }}</button>
      </div>
      <form v-else @submit.prevent="submit">
        <label for="access-key">访问密钥</label>
        <div class="key-field" :class="{ invalid: error }">
          <input id="access-key" v-model="key" :type="visible ? 'text' : 'password'" name="password" autocomplete="current-password" autofocus data-gp-autofocus required :disabled="busy" :aria-invalid="!!error" :aria-describedby="error ? 'login-error' : undefined" placeholder="输入密钥" @input="error = ''" />
          <button type="button" class="visibility-button" :aria-label="visible ? '隐藏密钥' : '显示密钥'" :aria-pressed="visible" @click="visible = !visible"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/><path v-if="!visible" d="m3 3 18 18"/></svg></button>
        </div>
        <p v-if="error" id="login-error" class="login-error" role="alert">{{ error }}</p>
        <button type="submit" class="enter-button" :disabled="busy || !key"><span v-if="busy" class="spinner" />{{ busy ? '登录中…' : '登录' }}</button>
      </form>
    </main>
  </div>
</template>

<style scoped>
.login-page{min-height:100svh;display:grid;place-items:center;padding:24px;background:var(--bg)}
.login-panel{width:min(320px,100%)}
.login-brand{display:flex;align-items:center;gap:8px;color:var(--text);font-size:20px;font-weight:650;letter-spacing:-.6px}.login-brand svg{color:var(--accent)}
h1{font-size:15px;font-weight:450;color:var(--text-dim);margin:16px 0 34px}
label{display:block;font-size:12px;color:var(--text-dim);margin-bottom:9px}
.key-field{display:flex;align-items:center;height:44px;padding:0 10px 0 13px;border:1px solid var(--line-strong);border-radius:7px;background:var(--bg-elev);transition:border-color .15s}
.key-field:focus-within{border-color:var(--accent)}.key-field.invalid{border-color:var(--err)}
input{width:100%;min-width:0;background:none;border:0;outline:0;color:var(--text);font-size:13px}input::placeholder{color:var(--text-faint)}
.key-field input:focus-visible{outline:none}
.visibility-button{display:grid;place-items:center;color:var(--text-faint);padding:5px}.visibility-button:hover{color:var(--text)}
.enter-button{display:flex;align-items:center;justify-content:center;gap:9px;width:100%;height:42px;margin-top:17px;border-radius:7px;background:var(--accent);color:#101016;font-size:13px;font-weight:600;transition:filter .15s}.enter-button:hover{filter:brightness(1.08)}.enter-button:disabled{opacity:.45;cursor:default}.enter-button .spinner{width:15px;height:15px;border-top-color:#101016}
.login-error,.connection-error{color:var(--err);font-size:12px;line-height:1.6;margin:10px 0}
</style>
