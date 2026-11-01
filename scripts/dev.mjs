#!/usr/bin/env node
/**
 * 开发模式：同时启动后端（:8088，--watch）与前端 Vite（:5173，/api 代理到后端）
 */
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const children = []

function run(name, args, color) {
  const child = spawn(npm, args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], env: process.env })
  const prefix = `\x1b[${color}m[${name}]\x1b[0m `
  const pipe = (stream, out) =>
    stream.on('data', (d) => {
      for (const line of d.toString().split('\n')) {
        if (line.trim()) out.write(prefix + line + '\n')
      }
    })
  pipe(child.stdout, process.stdout)
  pipe(child.stderr, process.stderr)
  child.on('exit', (code) => {
    if (code !== 0 && code !== null) {
      console.error(prefix + `退出，code=${code}`)
      shutdown(code || 1)
    }
  })
  children.push(child)
  return child
}

function shutdown(code = 0) {
  for (const c of children) {
    try {
      c.kill('SIGTERM')
    } catch {}
  }
  setTimeout(() => process.exit(code), 300)
}

process.on('SIGINT', () => shutdown(0))
process.on('SIGTERM', () => shutdown(0))

run('server', ['run', 'dev', '-w', 'server'], '36')
run('web', ['run', 'dev', '-w', 'web'], '35')
