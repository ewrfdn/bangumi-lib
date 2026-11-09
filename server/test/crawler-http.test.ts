import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer, request as httpRequest } from 'node:http'
import { connect } from 'node:net'
import { once } from 'node:events'
import { createHttpClient } from '../src/crawler/http-client.ts'

const origin = 'https://source.example'
const json = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } })
const deferred = () => {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}
function mockClient(t, fetchImpl, config = {}, dependencies = {}) {
  const client = createHttpClient({ timeoutMs: 1000, maxRetries: 0, minIntervalMs: 0, ...config }, {
    source: 'test', allowedOrigins: [origin], fetchImpl, ...dependencies,
  })
  t.after(() => client.close())
  return client
}
const rejectsCode = (promise, code) => assert.rejects(promise, failure => {
  assert.equal(failure.name, 'CrawlerError')
  assert.equal(failure.code, code)
  assert.equal(failure.source, 'test')
  return true
})

test('each source keeps its own dispatcher, queue, headers and close lifecycle', async t => {
  const gate = deferred()
  const started = deferred()
  let firstCalls = 0
  const firstDispatcher = { closeCalls: 0, async close() { this.closeCalls++ } }
  const secondDispatcher = { closeCalls: 0, async close() { this.closeCalls++ } }
  const first = mockClient(t, async (url, options) => {
    firstCalls++
    assert.equal(options.dispatcher, firstDispatcher)
    assert.equal(options.headers.get('user-agent'), 'developer/first')
    assert.equal(options.headers.get('proxy-authorization'), null)
    started.resolve()
    await gate.promise
    return json({ source: 'first' })
  }, { userAgent: 'developer/first' }, { dispatcher: firstDispatcher })
  const second = mockClient(t, async (url, options) => {
    assert.equal(options.dispatcher, secondDispatcher)
    assert.equal(options.headers.get('user-agent'), 'developer/second')
    return json({ source: 'second' })
  }, { userAgent: 'developer/second' }, { dispatcher: secondDispatcher })
  const running = first.requestJson(origin, { headers: { 'proxy-authorization': 'secret' } })
  await started.promise
  assert.deepEqual(await second.requestJson(origin), { source: 'second' })
  const cancel = new AbortController()
  const waiting = first.requestJson(origin, { signal: cancel.signal })
  cancel.abort()
  await rejectsCode(waiting, 'CANCELLED')
  assert.equal(firstCalls, 1)
  gate.resolve()
  assert.deepEqual(await running, { source: 'first' })
  await first.close()
  await first.close()
  assert.equal(firstDispatcher.closeCalls, 1)
  await rejectsCode(first.requestJson(origin), 'CLOSED')
})

test('source requests are serial by default and respect the configured minimum start interval', async t => {
  const starts = []
  let active = 0
  let maximumActive = 0
  const client = mockClient(t, async () => {
    starts.push(Date.now())
    active++
    maximumActive = Math.max(maximumActive, active)
    await new Promise(resolve => setTimeout(resolve, 10))
    active--
    return json({ ok: true })
  }, { minIntervalMs: 35 })
  await Promise.all([client.requestJson(origin), client.requestJson(origin), client.requestJson(origin)])
  assert.equal(maximumActive, 1)
  assert.equal(starts.length, 3)
  assert.ok(starts[1] - starts[0] >= 35)
  assert.ok(starts[2] - starts[1] >= 35)
})

test('an operation deadline includes queue waiting and an active request can be cancelled independently', async t => {
  const started = deferred()
  const controller = new AbortController()
  let calls = 0
  const client = mockClient(t, async () => {
    calls++
    started.resolve()
    return new Promise(() => {})
  })
  const running = client.requestText(origin, { signal: controller.signal })
  await started.promise
  await rejectsCode(client.requestText(origin, { signal: AbortSignal.timeout(25) }), 'TIMEOUT')
  assert.equal(calls, 1)
  controller.abort()
  await rejectsCode(running, 'CANCELLED')
})

test('timeout covers a stalled response body and cancels its reader', async t => {
  let cancelled = false
  const client = mockClient(t, async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode('{')) },
    cancel() { cancelled = true },
  })), { timeoutMs: 25 })
  await rejectsCode(client.requestJson(origin), 'TIMEOUT')
  assert.equal(cancelled, true)
})

test('operation cancellation interrupts retry waiting; excessive Retry-After is never shortened', async t => {
  let calls = 0
  const client = mockClient(t, async () => {
    calls++
    return new Response('', { status: 429, headers: { 'retry-after': '0.5' } })
  }, { maxRetries: 2, maxRetryDelayMs: 1000 })
  await rejectsCode(client.requestJson(origin, { signal: AbortSignal.timeout(25) }), 'TIMEOUT')
  assert.equal(calls, 1)
  const longWait = mockClient(t, async () => {
    calls++
    return new Response('', { status: 429, headers: { 'retry-after': '3600' } })
  }, { maxRetries: 2 })
  await assert.rejects(longWait.requestJson(origin), failure => {
    assert.equal(failure.code, 'RATE_LIMITED')
    assert.equal(failure.retryAfterMs, 3600000)
    return true
  })
  assert.equal(calls, 2)
})

test('retries only a bounded number of safe requests, including explicitly read-only POST searches', async t => {
  let calls = 0
  const client = mockClient(t, async () => {
    calls++
    return calls === 1
      ? new Response('', { status: 429, headers: { 'retry-after': '0' } })
      : json({ found: true })
  }, { maxRetries: 1 })
  assert.deepEqual(await client.requestJson(origin, { method: 'POST', body: '{}', retryable: true }), { found: true })
  assert.equal(calls, 2)
  calls = 0
  const never = mockClient(t, async () => {
    calls++
    return new Response('', { status: 503 })
  }, { maxRetries: 1, maxRetryDelayMs: 0 })
  await rejectsCode(never.requestJson(origin), 'HTTP_ERROR')
  assert.equal(calls, 2)
  calls = 0
  await rejectsCode(never.requestJson(origin, { method: 'POST', body: '{}' }), 'HTTP_ERROR')
  assert.equal(calls, 1)
})

test('authorization and not-found responses retain safe status information and are never retried', async t => {
  for (const [status, code] of [[401, 'AUTH_REQUIRED'], [403, 'ACCESS_DENIED'], [404, 'NOT_FOUND']]) {
    let calls = 0
    const client = mockClient(t, async () => {
      calls++
      return new Response('upstream-private-information', { status })
    }, { maxRetries: 3 })
    await assert.rejects(client.requestJson(origin), failure => {
      assert.equal(failure.code, code)
      assert.equal(failure.upstreamStatus, status)
      assert.doesNotMatch(failure.message, /private/)
      return true
    })
    assert.equal(calls, 1)
  }
})

test('redirects validate every origin and remove all custom credentials across origins', async t => {
  const alternate = 'https://other.example'
  const seen = []
  const client = mockClient(t, async (url, options) => {
    seen.push({ url, headers: options.headers, method: options.method, body: options.body })
    return seen.length === 1
      ? new Response('', { status: 302, headers: { location: alternate + '/result' } })
      : json({ ok: true })
  }, {}, { allowedOrigins: [origin, alternate] })
  assert.deepEqual(await client.requestJson(origin, {
    method: 'POST', body: '{}', headers: {
      authorization: 'Bearer secret', cookie: 'session=secret', 'x-private-token': 'secret',
      accept: 'application/json', 'content-type': 'application/json',
    },
  }), { ok: true })
  assert.equal(seen[1].method, 'GET')
  assert.equal(seen[1].body, undefined)
  assert.equal(seen[1].headers.get('authorization'), null)
  assert.equal(seen[1].headers.get('cookie'), null)
  assert.equal(seen[1].headers.get('x-private-token'), null)
  assert.equal(seen[1].headers.get('accept'), 'application/json')

  let calls = 0
  const denied = mockClient(t, async () => {
    calls++
    return new Response('', { status: 302, headers: { location: 'https://untrusted.example/secret' } })
  })
  await rejectsCode(denied.requestJson(origin), 'ACCESS_DENIED')
  assert.equal(calls, 1)
  await rejectsCode(denied.requestJson('https://untrusted.example'), 'ACCESS_DENIED')
  await rejectsCode(denied.requestJson('https://username:password@source.example'), 'INVALID_INPUT')
  assert.equal(calls, 1)
})

test('redirects refuse HTTPS downgrades, cross-origin request bodies and loops', async t => {
  const downgrade = mockClient(t, async () => new Response('', {
    status: 302, headers: { location: 'http://source.example/result' },
  }), {}, { allowedOrigins: [origin, 'http://source.example'] })
  await rejectsCode(downgrade.requestJson(origin), 'ACCESS_DENIED')
  const bodyRedirect = mockClient(t, async () => new Response('', {
    status: 307, headers: { location: 'https://other.example/result' },
  }), {}, { allowedOrigins: [origin, 'https://other.example'] })
  await rejectsCode(bodyRedirect.requestJson(origin, { method: 'POST', body: 'private' }), 'ACCESS_DENIED')
  let calls = 0
  const loop = mockClient(t, async () => {
    calls++
    return new Response('', { status: 302, headers: { location: '/loop' } })
  }, { maxRedirects: 2 })
  await rejectsCode(loop.requestText(origin), 'HTTP_ERROR')
  assert.equal(calls, 3)
})

test('bounds both declared and streamed body sizes and reports invalid JSON without response content', async t => {
  const declared = mockClient(t, async () => new Response('x', { headers: { 'content-length': '1000' } }), { maxBodyBytes: 8 })
  await rejectsCode(declared.requestText(origin), 'RESPONSE_TOO_LARGE')
  let cancelled = false
  const streamed = mockClient(t, async () => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('12345'))
      controller.enqueue(new TextEncoder().encode('67890'))
    },
    cancel() { cancelled = true },
  })), { maxBodyBytes: 8 })
  await rejectsCode(streamed.requestText(origin), 'RESPONSE_TOO_LARGE')
  assert.equal(cancelled, true)
  const malformed = mockClient(t, async () => new Response('password=private'))
  await assert.rejects(malformed.requestJson(origin), failure => {
    assert.equal(failure.code, 'PARSE_ERROR')
    assert.doesNotMatch(String(failure.stack), /password|private/)
    return true
  })
})

test('errors and retry logs redact proxy credentials, origin tokens and upstream exception messages', async t => {
  const logs = []
  const client = mockClient(t, async () => {
    throw new Error('http://user:proxy-password@127.0.0.1 Bearer origin-secret')
  }, { proxyUrl: 'http://user:proxy-password@127.0.0.1:1234', maxRetries: 1, maxRetryDelayMs: 0 }, {
    logger: { warn(...args) { logs.push(args) } },
  })
  await assert.rejects(client.requestJson(origin + '/?token=origin-secret'), failure => {
    assert.equal(failure.code, 'NETWORK_ERROR')
    assert.doesNotMatch(JSON.stringify(failure) + failure.stack, /proxy-password|origin-secret|Bearer/)
    assert.equal(failure.cause, undefined)
    return true
  })
  assert.equal(logs.length, 1)
  assert.doesNotMatch(JSON.stringify(logs), /proxy-password|origin-secret|Bearer/)
  assert.throws(() => createHttpClient({ proxyUrl: 'socks5://user:password@127.0.0.1:1080' }, {
    source: 'test', allowedOrigins: [origin],
  }), failure => failure.code === 'INVALID_INPUT' && !failure.message.includes('password'))
})

test('close aborts running and queued requests and closes connections exactly once', async t => {
  const started = deferred()
  let closed = 0
  const client = mockClient(t, async () => {
    started.resolve()
    return new Promise(() => {})
  }, {}, { dispatcher: { async close() { closed++ } } })
  const running = client.requestText(origin)
  await started.promise
  const queued = client.requestText(origin)
  const checks = [rejectsCode(running, 'CLOSED'), rejectsCode(queued, 'CLOSED')]
  await client.close()
  await Promise.all(checks)
  await client.close()
  assert.equal(closed, 1)
})

async function listen(t, server) {
  const sockets = new Set()
  server.on('connection', socket => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => new Promise(resolve => {
    server.close(resolve)
    server.closeAllConnections()
    for (const socket of sockets) socket.destroy()
  }))
  return `http://127.0.0.1:${server.address().port}`
}

test('a configured HTTP proxy is used independently and a failed proxy never falls back to direct access', async t => {
  let directCalls = 0
  let proxyCalls = 0
  let proxyAuthorization
  const sockets = new Set()
  const target = await listen(t, createServer((request, response) => {
    directCalls++
    assert.equal(request.headers['proxy-authorization'], undefined)
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify({ path: request.url }))
  }))
  const proxyServer = createServer((request, response) => {
    proxyCalls++
    proxyAuthorization = request.headers['proxy-authorization']
    const headers = { ...request.headers }
    delete headers['proxy-authorization']
    const upstream = httpRequest(request.url, { method: request.method, headers }, result => {
      response.writeHead(result.statusCode, result.headers)
      result.pipe(response)
    })
    upstream.on('error', () => { response.statusCode = 502; response.end() })
    request.pipe(upstream)
  })
  proxyServer.on('connect', (request, socket, head) => {
    proxyCalls++
    proxyAuthorization = request.headers['proxy-authorization']
    const address = new URL('http://' + request.url)
    const upstream = connect(Number(address.port), address.hostname, () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if (head.length) upstream.write(head)
      socket.pipe(upstream)
      upstream.pipe(socket)
    })
    sockets.add(socket)
    sockets.add(upstream)
    socket.on('close', () => { sockets.delete(socket); upstream.destroy() })
    upstream.on('close', () => { sockets.delete(upstream); socket.destroy() })
    upstream.on('error', () => socket.destroy())
    socket.on('error', () => upstream.destroy())
  })
  const proxyUrl = (await listen(t, proxyServer)).replace('http://', 'http://user:proxy-password@')
  t.after(() => { for (const socket of sockets) socket.destroy() })
  const proxied = mockClient(t, undefined, { proxyUrl }, { allowedOrigins: [target] })
  const direct = mockClient(t, undefined, {}, { allowedOrigins: [target] })
  assert.deepEqual(await proxied.requestJson(target + '/proxied'), { path: '/proxied' })
  assert.equal(proxyCalls, 1)
  assert.equal(proxyAuthorization, 'Basic ' + Buffer.from('user:proxy-password').toString('base64'))
  assert.deepEqual(await direct.requestJson(target + '/direct'), { path: '/direct' })
  assert.equal(proxyCalls, 1)
  assert.equal(directCalls, 2)
  await proxied.close()
  await direct.close()
  for (const socket of sockets) socket.destroy()
  await new Promise(resolve => proxyServer.close(resolve))
  const failedProxy = mockClient(t, undefined, { proxyUrl, timeoutMs: 500 }, { allowedOrigins: [target] })
  await rejectsCode(failedProxy.requestJson(target), 'PROXY_ERROR')
  assert.equal(directCalls, 2)
})
