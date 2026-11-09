#!/usr/bin/env node
/**
 * Run the API and Vite as separate Node processes, without a shell.
 * This also avoids npm.cmd spawning failures on Windows.
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { createInterface } from 'node:readline'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const backendEnv = { ...process.env }
const frontendEnv = { ...process.env }
// Backend secrets and its env-file override never reach the Vite process.
for (const name of ['AUTH_SECRET', 'AI_API_KEY', 'AI_CONFIG_KEY', 'ENV_FILE']) delete frontendEnv[name]
const envFile = backendEnv.ENV_FILE || path.join(root, 'server', '.env')
if (fs.existsSync(envFile)) {
  for (const raw of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const equals = line.indexOf('=')
    if (equals < 1) continue
    const name = line.slice(0, equals).trim()
    let value = line.slice(equals + 1).trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1)
    if (backendEnv[name] === undefined) backendEnv[name] = value
  }
}
let viteBin
try {
  const requireWeb = createRequire(path.join(root, 'web', 'package.json'))
  viteBin = path.join(path.dirname(requireWeb.resolve('vite/package.json')), 'bin', 'vite.js')
  const { loadEnv } = await import(pathToFileURL(requireWeb.resolve('vite')).href)
  const webConfig = loadEnv('development', path.join(root, 'web'), 'API_TARGET')
  // An explicit frontend target wins; only its absence uses the backend port.
  if (!frontendEnv.API_TARGET && !webConfig.API_TARGET) frontendEnv.API_TARGET = `http://127.0.0.1:${backendEnv.PORT || 8088}`
} catch {
  console.error('[dev] 未找到 Vite，请分别在 server 和 web 目录运行 npm install。')
  process.exit(1)
}

const children = []
let stopping = false
function run(name, args, color, env) {
  const child = spawn(process.execPath, args, {
    cwd: root,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  children.push(child)
  const prefix = `\x1b[${color}m[${name}]\x1b[0m `
  for (const [stream, output] of [[child.stdout, process.stdout], [child.stderr, process.stderr]]) {
    createInterface({ input: stream }).on('line', line => output.write(prefix + line + '\n'))
  }
  child.on('error', error => {
    console.error(prefix + error.message)
    void shutdown(1)
  })
  child.on('exit', (code, signal) => {
    if (!stopping) {
      console.error(prefix + `已退出（${signal || code || 0}）`)
      void shutdown(code || 1)
    }
  })
}
function stopChild(child) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
  if (process.platform === 'win32') {
    // Only terminate the process tree created by this launcher.
    return new Promise(resolve => {
      const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
      killer.once('error', resolve)
      killer.once('close', resolve)
    })
  }
  return new Promise(resolve => {
    child.once('exit', resolve)
    child.kill('SIGTERM')
    const timer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
      resolve()
    }, 3000)
    timer.unref()
    child.once('exit', () => clearTimeout(timer))
  })
}
async function shutdown(code = 0) {
  if (stopping) return
  stopping = true
  await Promise.all(children.map(stopChild))
  process.exit(code)
}
process.on('SIGINT', () => { void shutdown(0) })
process.on('SIGTERM', () => { void shutdown(0) })
run('server', ['--watch', path.join(root, 'server', 'src', 'index.ts')], '36', backendEnv)
run('web', [viteBin, '--config', path.join(root, 'web', 'vite.config.js'), path.join(root, 'web')], '35', frontendEnv)
