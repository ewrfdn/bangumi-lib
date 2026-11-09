#!/usr/bin/env node
/**
 * 免 root 把 ffmpeg（含 libx264 / libx265 / libdav1d / libass 等）连同依赖库
 * 安装到项目的 tools/ffmpeg/ 下。
 *
 *   cd server && npm run setup:ffmpeg
 *   MIRROR=https://archive.ubuntu.com/ubuntu node scripts/install-ffmpeg.mjs     # arm64 用 ubuntu-ports
 *
 * 支持的发行版：Ubuntu 22.04/24.04（jammy/noble）及其衍生版本。
 * 依赖：dpkg-deb；patchelf 不存在时会自动从镜像下载。
 *
 * 产物：
 *   tools/ffmpeg/bin/{ffmpeg,ffprobe}   rpath = $ORIGIN/../lib
 *   tools/ffmpeg/lib/lib*.so*
 */
import { execFile, spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import fss from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const OUT_DIR = path.join(PROJECT_ROOT, 'tools', 'ffmpeg')
const ARCH = process.env.FFMPEG_ARCH || (process.arch === 'arm64' ? 'arm64' : 'amd64')
const CHUNKS = Number(process.env.DOWNLOAD_CHUNKS || 10)
const log = (...a) => console.log(...a)

function chooseMirror() {
  if (process.env.MIRROR) return process.env.MIRROR.replace(/\/$/, '')
  // arm64 属于 ports 仓库
  return ARCH === 'arm64'
    ? 'https://mirrors.tuna.tsinghua.edu.cn/ubuntu-ports'
    : 'https://mirrors.tuna.tsinghua.edu.cn/ubuntu'
}

const MIRROR = chooseMirror()
const FALLBACK_MIRRORS = [
  ARCH === 'arm64' ? 'https://mirrors.aliyun.com/ubuntu-ports' : 'https://mirrors.aliyun.com/ubuntu',
  ARCH === 'arm64' ? 'http://ports.ubuntu.com/ubuntu-ports' : 'https://archive.ubuntu.com/ubuntu',
]

/** 带超时 + 重试的抓取 */
async function fetchBuf(url, { range, tries = 3, timeout = 25000 } = {}) {
  const headers = range ? { Range: `bytes=${range.start}-${range.end}` } : {}
  let lastErr
  for (let i = 0; i < tries; i++) {
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), timeout)
    try {
      const res = await fetch(url, { headers, signal: ac.signal })
      if (!res.ok && res.status !== 206) throw new Error(`${res.status} ${url}`)
      return Buffer.from(await res.arrayBuffer())
    } catch (e) {
      lastErr = e
      await new Promise((r) => setTimeout(r, 400 * (i + 1)))
    } finally {
      clearTimeout(timer)
    }
  }
  throw lastErr
}

function suiteFromRelease() {
  try {
    const txt = fss.readFileSync('/etc/os-release', 'utf8')
    const m = txt.match(/^VERSION_CODENAME=(.+)$/m)
    const c = m ? m[1].trim() : ''
    if (['jammy', 'noble'].includes(c)) return c
    // 其他版本（例如未来版本）退回 jammy 兼容依赖最少
    return 'jammy'
  } catch {
    return 'jammy'
  }
}

const SUITE = process.env.UBUNTU_SUITE || suiteFromRelease()
const COMPONENTS = ['main', 'universe']

/** 下载并解析 Packages 索引 -> Map<包名, 最佳条目> */
const indexes = new Map()
async function loadIndexes(mirror) {
  if (indexes.has(mirror)) return indexes.get(mirror)
  const map = new Map()
  for (const comp of COMPONENTS) {
    const url = `${mirror}/dists/${SUITE}/${comp}/binary-${ARCH}/Packages.xz`
    let buf
    try {
      buf = await fetchBuf(url)
    } catch (e) {
      log(`  (跳过 ${comp} 索引: ${e.message})`)
      continue
    }
    // 用系统 xz 子进程解压（几乎所有 Linux 都自带）
    const plain = await xzDecompress(buf)
    for (const stanza of plain.split('\n\n')) {
      if (!/^Package: (ffmpeg|ffprobe|patchelf|lib)/.test(stanza)) continue
      const pkg = /^Package: (.+)$/m.exec(stanza)?.[1]?.trim()
      if (!pkg) continue
      const filename = /^Filename: (.+)$/m.exec(stanza)?.[1]?.trim()
      const depends = /^Depends: (.+)$/m.exec(stanza)?.[1]?.trim() || ''
      const version = /^Version: (.+)$/m.exec(stanza)?.[1]?.trim() || ''
      if (!filename) continue
      map.set(pkg, { pkg, filename, depends, version })
    }
    log(`  索引 ${SUITE}/${comp}: ${map.size} 个相关包`)
  }
  indexes.set(mirror, map)
  return map
}

/** 用系统 xz 解压内存缓冲区（Linux 发行版基本都自带 xz） */
function xzDecompress(buf) {
  return new Promise((resolve, reject) => {
    const child = spawn('xz', ['-dc'], { stdio: ['pipe', 'pipe', 'ignore'] })
    const out = []
    child.stdout.on('data', (d) => out.push(d))
    child.on('error', reject)
    child.on('close', (code) => (code === 0 ? resolve(Buffer.concat(out).toString('utf8')) : reject(new Error('xz 解压失败'))))
    child.stdin.on('error', () => {})
    child.stdin.end(buf)
  })
}

/** 分块并行下载（镜像单连接很慢时有效） */
async function download(url, dest) {
  let len = 0
  try {
    const ac = new AbortController()
    const t = setTimeout(() => ac.abort(), 20000)
    const head = await fetch(url, { method: 'HEAD', signal: ac.signal })
    clearTimeout(t)
    if (head.ok) len = Number(head.headers.get('content-length'))
  } catch {}
  if (!len) throw new Error(`无法获取文件大小 ${url}`)
  const size = Math.max(1, Math.ceil(len / CHUNKS))
  const parts = []
  for (let i = 0; i < CHUNKS; i++) {
    const start = i * size
    const end = Math.min(len - 1, start + size - 1)
    if (start > end) break
    parts.push({ start, end, file: `${dest}.part${i}` })
  }
  await Promise.all(
    parts.map(async (p) => {
      for (let attempt = 0; attempt < 4; attempt++) {
        try {
          const buf = await fetchBuf(url, { range: { start: p.start, end: p.end } })
          if (buf.length !== p.end - p.start + 1) throw new Error(`short read ${buf.length}`)
          await fs.writeFile(p.file, buf)
          return
        } catch (e) {
          if (attempt === 3) throw e
          await new Promise((r) => setTimeout(r, 800 * (attempt + 1)))
        }
      }
    }),
  )
  const out = fss.openSync(dest, 'w')
  for (const p of parts) {
    fss.writeSync(out, await fs.readFile(p.file))
    await fs.rm(p.file)
  }
  fss.closeSync(out)
}

function dpkgExtract(deb, dir) {
  return new Promise((resolve, reject) => {
    execFile('dpkg-deb', ['-x', deb, dir], (err) => (err ? reject(err) : resolve()))
  })
}

function run(cmd, args) {
  return new Promise((resolve) => execFile(cmd, args, (err, stdout, stderr) => resolve({ ok: !err, out: (stdout || '') + (stderr || '') })))
}

function lddMissing(binary) {
  return run('ldd', [binary]).then(({ out }) =>
    out
      .split('\n')
      .filter((l) => l.includes('not found'))
      .map((l) => l.trim().split(' ')[0]),
  )
}

const SKIP_DEPS = new Set([
  'libc6', 'debconf', 'coreutils', 'adduser', 'libgcc-s1', 'libstdc++6', 'zlib1g', 'libc-bin',
])

/** 解析 Depends（取每组第一个候选） */
function depsOf(stanza) {
  const out = new Set()
  for (const raw of (stanza || '').split(',')) {
    const spec = raw.trim().split(' ')[0]
    if (!spec) continue
    const alt = spec.split('|')[0].replace(/:any$/, '').trim()
    if (!alt || SKIP_DEPS.has(alt)) continue
    out.add(alt)
  }
  return out
}

async function findPatchelf(tmp) {
  for (const p of ['/usr/bin/patchelf', '/usr/local/bin/patchelf']) if (fss.existsSync(p)) return p
  for (const d of (process.env.PATH || '').split(':')) {
    const full = path.join(d, 'patchelf')
    if (fss.existsSync(full)) return full
  }
  log('  从镜像获取 patchelf …')
  const idx = await withIndexes()
  if (process.env.DEBUG_INSTALL) console.log('  debug: total pkgs', idx.size, 'has patchelf', idx.has('patchelf'), 'has ffmpeg', idx.has('ffmpeg'))
  const stanza = idx.get('patchelf')
  if (!stanza) throw new Error('找不到 patchelf，请先 apt install patchelf')
  const file = path.join(tmp, 'patchelf.deb')
  await download(`${MIRROR}/${stanza.filename}`, file)
  await dpkgExtract(file, path.join(tmp, 'pfx'))
  const bin = path.join(tmp, 'pfx', 'usr', 'bin', 'patchelf')
  await fs.chmod(bin, 0o755)
  return bin
}

let activeMirror = MIRROR
async function withIndexes() {
  try {
    return await loadIndexes(activeMirror)
  } catch (e) {
    for (const m of FALLBACK_MIRRORS) {
      try {
        activeMirror = m
        log(`  切换镜像 ${m}`)
        return await loadIndexes(m)
      } catch {}
    }
    throw e
  }
}

async function main() {
  if (process.platform !== 'linux') {
    console.error('此脚本只支持 Linux；其他平台请直接使用系统 ffmpeg（设置 FFMPEG_PATH）')
    process.exit(1)
  }
  log(`平台 ${process.platform}/${ARCH} · 发行版 ${SUITE} · 镜像 ${MIRROR}`)
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'anishare-ffmpeg-'))
  const root = path.join(tmp, 'root')
  await fs.mkdir(root, { recursive: true })

  const idx = await withIndexes()
  const rootStanza = idx.get('ffmpeg')
  if (!rootStanza) throw new Error(`索引里没有 ffmpeg 包，请检查 MIRROR/TARGET_ARCH`)

  // BFS 解析依赖，只保留运行期需要的包
  const needed = new Map()
  const queue = ['ffmpeg']
  while (queue.length) {
    const name = queue.shift()
    if (needed.has(name) || SKIP_DEPS.has(name)) continue
    const st = idx.get(name)
    if (!st) {
      log(`  ⚠ 索引中缺少依赖 ${name}，跳过`)
      continue
    }
    needed.set(name, st)
    for (const d of depsOf(st.depends)) queue.push(d)
  }

  log(`需要 ${needed.size} 个包（${[...needed.keys()].filter((n) => /x264|x265|avcodec|avformat|ass|dav1d|svt|vpx|opus|lame|mp3/.test(n)).join(' ')} …）`)
  const debsDir = path.join(tmp, 'debs')
  await fs.mkdir(debsDir, { recursive: true })
  const list = [...needed.values()]
  let done = 0
  const workers = Number(process.env.DOWNLOAD_CONCURRENCY || 4)
  let cursor = 0
  async function worker() {
    while (cursor < list.length) {
      const st = list[cursor++]
      const file = path.join(debsDir, path.basename(st.filename))
      let lastErr
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          await download(`${activeMirror}/${st.filename}`, file)
          lastErr = null
          break
        } catch (e) {
          lastErr = e
          await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)))
        }
      }
      if (lastErr) throw new Error(`${st.pkg}: ${lastErr.message}`)
      done++
      log(`  [${done}/${list.length}] ${st.pkg} ${st.version}`)
    }
  }
  await Promise.all(Array.from({ length: workers }, worker))

  const extractRoot = path.join(tmp, 'extract')
  for (const st of list) {
    await dpkgExtract(path.join(debsDir, path.basename(st.filename)), extractRoot)
  }

  const patchelf = await findPatchelf(tmp)

  const binDir = path.join(OUT_DIR, 'bin')
  const libDir = path.join(OUT_DIR, 'lib')
  await fs.rm(OUT_DIR, { recursive: true, force: true })
  await fs.mkdir(binDir, { recursive: true })
  await fs.mkdir(libDir, { recursive: true })

  for (const name of ['ffmpeg', 'ffprobe']) {
    const src = path.join(extractRoot, 'usr/bin', name)
    await fs.copyFile(src, path.join(binDir, name))
    await fs.chmod(path.join(binDir, name), 0o755)
  }

  // 收集所有共享库（含符号链接目标）
  async function collectLibs(dir) {
    let entries
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const full = path.join(dir, e.name)
      if (e.isDirectory()) {
        await collectLibs(full)
      } else if (/^lib.*\.so/.test(e.name)) {
        let real = full
        try {
          real = await fs.realpath(full)
        } catch {}
        const stat = await fs.stat(real).catch(() => null)
        if (stat && stat.isFile()) {
          // 用 rename 让 libxxx.so.N 指向真实的 .so.N.x.y（ld.so 据此计算对同目录依赖的搜索路径）
          await fs.rm(path.join(libDir, e.name), { force: true })
          await fs.link(real, path.join(libDir, e.name)).catch(async () => {
            const isLink = await fs.lstat(full).then((l) => l.isSymbolicLink()).catch(() => false)
            if (isLink && real !== full) await fs.symlink(path.basename(real), path.join(libDir, e.name))
            else await fs.copyFile(real, path.join(libDir, e.name))
          })
        }
      }
    }
  }
  await collectLibs(path.join(extractRoot, 'usr/lib'))
  await collectLibs(path.join(extractRoot, 'lib'))

  // 额外保留一份完整解包目录（tools/sysroot），用于后续调整 rpath / 排查依赖
  const sysrootDir = path.join(PROJECT_ROOT, 'tools', 'sysroot')
  await fs.rm(sysrootDir, { recursive: true, force: true })
  await fs.mkdir(sysrootDir, { recursive: true })
  for (const target of ['000000', 'usr']) {
    const src = path.join(extractRoot, target)
    if (!fss.existsSync(src)) continue
    await fs.mkdir(path.join(sysrootDir, target), { recursive: true })
    await new Promise((resolve, reject) =>
      execFile('cp', ['-a', `${src}/.`, path.join(sysrootDir, target)], (err) => (err ? reject(err) : resolve())),
    )
  }

  log(`重定位 rpath → $ORIGIN/../lib（${(await fs.readdir(libDir)).length} 个库）`)
  for (const bin of ['ffmpeg', 'ffprobe']) {
    // 用 --force-rpath 写 DT_RPATH：间接依赖（libavcodec → libx264）才能找到
    const r = await run(patchelf, ['--force-rpath', '--set-rpath', '$ORIGIN/../lib', path.join(binDir, bin)])
    if (!r.ok) throw new Error(r.out)
  }

  const binArg = path.join(binDir, 'ffmpeg').replace(/\\/g, '/')
  const missing = await lddMissing(path.join(binDir, 'ffmpeg'))
  if (missing.length) log('⚠ 仍缺少系统库：', missing.join(' '))
  // 校验 $ORIGIN 是否生效（个别环境不允许解析 $ORIGIN/symlink）
  const probe = await run(binArg, ['-hide_banner', '-version'])
  if (!probe.ok && probe.out.includes('error while loading')) {
    log('  $ORIGIN rpath 未生效，改用绝对路径 rpath')
    for (const bin of ['ffmpeg', 'ffprobe']) {
      const r = await run(patchelf, ['--force-rpath', '--set-rpath', libDir, path.join(binDir, bin)])
      if (!r.ok) throw new Error(r.out)
    }
  }

  const ver = await run(path.join(binDir, 'ffmpeg'), ['-hide_banner', '-version'])
  log(ver.out.split('\n').slice(0, 2).join('\n'))
  if (!ver.ok) throw new Error('ffmpeg 无法运行')
  const enc = await run(path.join(binDir, 'ffmpeg'), ['-hide_banner', '-encoders'])
  for (const c of ['libx264', 'libx265', 'libdav1d', 'libsvtav1', 'aac']) {
    log(`  ${enc.out.includes(c) ? '✓' : '✗'} ${c}`)
  }
  // 把 patchelf 也留在 tools 里（以后再调 rpath 时不必重下）
  await fs.copyFile(patchelf, path.join(PROJECT_ROOT, 'tools', 'patchelf')).catch(() => {})
  await fs.chmod(path.join(PROJECT_ROOT, 'tools', 'patchelf'), 0o755).catch(() => {})
  await fs.rm(tmp, { recursive: true, force: true })
  log(`\n完成 → ${path.join('tools', 'ffmpeg', 'bin')}`)
}

main().catch((e) => {
  console.error('\n安装失败：', e.message)
  process.exit(1)
})
