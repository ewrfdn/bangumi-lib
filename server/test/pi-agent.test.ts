import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { runPiAgent, runPiAgentWithTools } from '../src/agent/pi.runtime.ts'

async function withServer(handler, run) {
  const server = http.createServer(async (request, response) => {
    try {
      let raw = ''
      for await (const chunk of request) raw += chunk
      await handler(request, response, raw ? JSON.parse(raw) : null)
    } catch (error) {
      if (!response.headersSent) response.writeHead(500)
      response.end('mock handler failed')
    }
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${server.address().port}`
  try { return await run(origin) }
  finally {
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
  }
}

function event(response, data, name) {
  if (name) response.write(`event: ${name}\n`)
  response.write(`data: ${JSON.stringify(data)}\n\n`)
}

function completion(response, model = 'literal-model-v1') {
  response.writeHead(200, { 'Content-Type': 'text/event-stream' })
  const base = { id: 'chat-1', object: 'chat.completion.chunk', created: 1, model }
  event(response, { ...base, choices: [{ index: 0, delta: { role: 'assistant', content: '整理' }, finish_reason: null }] })
  event(response, { ...base, choices: [{ index: 0, delta: { content: '完成' }, finish_reason: null }] })
  event(response, { ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 } })
  response.end('data: [DONE]\n\n')
}

const configuration = (baseUrl, overrides = {}) => ({
  apiFormat: 'openai-completions', baseUrl, model: 'literal-model-v1',
  apiKey: 'literal-test-key-123456', maxTokens: 128, timeoutMs: 2000, ...overrides,
})

test('real Pi Agent uses the configured OpenAI model, endpoint, key, token cap and usage', async () => {
  let received
  await withServer((request, response, body) => {
    received = { path: request.url, headers: request.headers, body }
    completion(response)
  }, async (origin) => {
    const result = await runPiAgent(configuration(`${origin}/gateway/v1`), { prompt: '请整理这些剧集。' })
    assert.equal(result.text, '整理完成')
    assert.equal(result.model, 'literal-model-v1')
    assert.equal(result.stopReason, 'stop')
    assert.equal(result.usage.input, 12)
    assert.equal(result.usage.output, 4)
    assert.equal(result.usage.totalTokens, 16)
  })
  assert.equal(received.path, '/gateway/v1/chat/completions')
  assert.equal(received.headers.authorization, 'Bearer literal-test-key-123456')
  assert.equal(received.body.model, 'literal-model-v1')
  assert.equal(received.body.max_tokens, 128)
  assert.equal(received.body.stream, true)
  assert.ok(!received.body.tools || received.body.tools.length === 0)
  assert.ok(received.body.messages.some((message) => message.role === 'user' && JSON.stringify(message.content).includes('请整理这些剧集。')))
})

test('keyless endpoints receive no ambient API key, organization, project or SDK placeholder', async () => {
  const ambient = { OPENAI_API_KEY: 'never-send-environment-key', OPENAI_ORG_ID: 'private-org', OPENAI_PROJECT_ID: 'private-project', ANTHROPIC_API_KEY: 'private-anthropic-key' }
  const previous = Object.fromEntries(Object.keys(ambient).map((key) => [key, process.env[key]]))
  Object.assign(process.env, ambient)
  try {
    await withServer((request, response) => {
      assert.equal(request.headers.authorization, undefined)
      assert.equal(request.headers['x-api-key'], undefined)
      assert.equal(request.headers['openai-organization'], undefined)
      assert.equal(request.headers['openai-project'], undefined)
      assert.equal(request.headers.cookie, undefined)
      assert.doesNotMatch(JSON.stringify(request.headers), /never-send|private-|anishare-keyless/)
      completion(response)
    }, async (origin) => {
      assert.equal((await runPiAgent(configuration(`${origin}/v1`, { apiKey: '' }), { prompt: '测试本地模型' })).text, '整理完成')
    })
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
})

test('real Pi Agent supports the OpenAI Responses wire protocol', async () => {
  let received
  await withServer((request, response, body) => {
    received = { path: request.url, headers: request.headers, body }
    response.writeHead(200, { 'Content-Type': 'text/event-stream' })
    const message = { id: 'message-1', type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: 'Responses 完成', annotations: [] }] }
    event(response, { type: 'response.created', response: { id: 'response-1', status: 'in_progress', model: body.model, output: [] } })
    event(response, { type: 'response.output_item.added', output_index: 0, item: { ...message, content: [] } })
    event(response, { type: 'response.output_text.delta', output_index: 0, content_index: 0, item_id: 'message-1', delta: 'Responses 完成' })
    event(response, { type: 'response.output_item.done', output_index: 0, item: message })
    event(response, { type: 'response.completed', response: {
      id: 'response-1', status: 'completed', model: body.model, output: [message],
      usage: { input_tokens: 10, output_tokens: 3, total_tokens: 13, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } },
    } })
    response.end()
  }, async (origin) => {
    const result = await runPiAgent(configuration(`${origin}/gateway/v1`, { apiFormat: 'openai-responses' }), { prompt: '响应格式测试' })
    assert.equal(result.text, 'Responses 完成')
    assert.equal(result.stopReason, 'stop')
    assert.equal(result.usage.input, 10)
    assert.equal(result.usage.output, 3)
  })
  assert.equal(received.path, '/gateway/v1/responses')
  assert.equal(received.body.max_output_tokens, 128)
  assert.equal(received.headers.authorization, 'Bearer literal-test-key-123456')
})

test('real Pi Agent supports Anthropic Messages with the literal x-api-key', async () => {
  let received
  await withServer((request, response, body) => {
    received = { path: request.url, headers: request.headers, body }
    response.writeHead(200, { 'Content-Type': 'text/event-stream' })
    event(response, { type: 'message_start', message: { id: 'message-1', type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } } }, 'message_start')
    event(response, { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }, 'content_block_start')
    event(response, { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Anthropic 完成' } }, 'content_block_delta')
    event(response, { type: 'content_block_stop', index: 0 }, 'content_block_stop')
    event(response, { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 3 } }, 'message_delta')
    event(response, { type: 'message_stop' }, 'message_stop')
    response.end()
  }, async (origin) => {
    const result = await runPiAgent(configuration(`${origin}/gateway`, { apiFormat: 'anthropic-messages' }), { prompt: '消息格式测试' })
    assert.equal(result.text, 'Anthropic 完成')
    assert.equal(result.stopReason, 'stop')
    assert.equal(result.usage.input, 10)
    assert.equal(result.usage.output, 3)
  })
  assert.equal(new URL(received.path, 'http://mock').pathname, '/gateway/v1/messages')
  assert.equal(received.body.max_tokens, 128)
  assert.equal(received.headers['x-api-key'], 'literal-test-key-123456')
  assert.equal(received.headers.authorization, undefined)
})

test('upstream errors are detected and cannot reveal the key or response body', async () => {
  await withServer((request, response) => {
    response.writeHead(401, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({ error: { message: 'secret upstream body literal-test-key-123456', type: 'authentication_error' } }))
  }, async (origin) => {
    await assert.rejects(runPiAgent(configuration(`${origin}/v1`), { prompt: '测试错误处理' }), (error) => {
      assert.equal(error.code, 'PI_UPSTREAM_AUTH')
      assert.equal(error.statusCode, 502)
      assert.doesNotMatch(error.message + error.stack, /literal-test-key|secret upstream body/)
      assert.equal(error.cause, undefined)
      return true
    })
  })
})

test('timeouts cancel the real upstream request instead of waiting for SDK retries', async () => {
  let closed
  const upstreamClosed = new Promise((resolve) => { closed = resolve })
  await withServer((request, response) => {
    response.on('close', closed)
    response.writeHead(200, { 'Content-Type': 'text/event-stream' })
    response.flushHeaders()
  }, async (origin) => {
    const started = Date.now()
    await assert.rejects(runPiAgent(configuration(`${origin}/v1`, { timeoutMs: 100 }), { prompt: '测试超时' }), { code: 'PI_TIMEOUT', statusCode: 504 })
    assert.ok(Date.now() - started < 1000)
    await Promise.race([upstreamClosed, new Promise((resolve, reject) => setTimeout(() => reject(new Error('upstream was not aborted')), 500))])
  })
})

test('caller cancellation aborts in-flight SDK streaming and pre-aborted calls never request', async () => {
  let requests = 0
  const controller = new AbortController()
  await withServer((request, response) => {
    requests++
    response.writeHead(200, { 'Content-Type': 'text/event-stream' })
    response.flushHeaders()
    controller.abort(new Error('private caller reason'))
  }, async (origin) => {
    await assert.rejects(runPiAgent(configuration(`${origin}/v1`), { prompt: '测试取消', signal: controller.signal }), { code: 'PI_ABORTED', statusCode: 499 })
    await assert.rejects(runPiAgent(configuration(`${origin}/v1`), { prompt: '已经取消', signal: controller.signal }), { code: 'PI_ABORTED' })
  })
  assert.equal(requests, 1)
})

test('unexpected tool calls cannot execute capabilities or cause another model request', async () => {
  let requests = 0
  await withServer((request, response, body) => {
    requests++
    response.writeHead(200, { 'Content-Type': 'text/event-stream' })
    event(response, { id: 'chat-tool', object: 'chat.completion.chunk', created: 1, model: body.model,
      choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'call-1', type: 'function', function: { name: 'readFile', arguments: '{"path":"private.env"}' } }] }, finish_reason: null }] })
    event(response, { id: 'chat-tool', object: 'chat.completion.chunk', created: 1, model: body.model,
      choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })
    response.end('data: [DONE]\n\n')
  }, async (origin) => {
    await assert.rejects(runPiAgent(configuration(`${origin}/v1`), { prompt: '只输出文本' }), { code: 'PI_UNEXPECTED_TOOLS' })
  })
  assert.equal(requests, 1)
})

test('tool-enabled runs execute declared tools and feed results back before answering', async () => {
  let requests = 0
  let secondBody
  await withServer((request, response, body) => {
    requests += 1
    if (requests === 1) {
      response.writeHead(200, { 'Content-Type': 'text/event-stream' })
      event(response, { id: 'chat-tool', object: 'chat.completion.chunk', created: 1, model: body.model,
        choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'call-1', type: 'function', function: { name: 'list_folder', arguments: '{"path":""}' } }] }, finish_reason: null }] })
      event(response, { id: 'chat-tool', object: 'chat.completion.chunk', created: 1, model: body.model,
        choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })
      response.end('data: [DONE]\n\n')
      return
    }
    secondBody = body
    completion(response)
  }, async (origin) => {
    const executed = []
    const tools = [{
      name: 'list_folder',
      label: '列出目录',
      description: '列出媒体库目录的一级子项',
      parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false },
      async execute(id, params) {
        executed.push([id, params.path])
        return { content: [{ type: 'text', text: '{"items":[]}' }], details: { items: [] } }
      },
    }]
    const result = await runPiAgentWithTools(configuration(`${origin}/v1`), {
      prompt: '处理这个目录', systemPrompt: '你是媒体库整理助手', tools,
    })
    assert.equal(result.text, '整理完成')
    assert.equal(result.toolCalls, 1)
    assert.deepEqual(executed, [['call-1', '']])
    assert.ok(result.turns >= 2)
  })
  assert.equal(requests, 2)
  assert.ok(JSON.stringify(secondBody.tools).includes('list_folder'))
  assert.ok(JSON.stringify(secondBody.messages).includes('call-1'))
})

test('conversation history is replayed as real turns, and deltas plus tool activity stream to the caller', async () => {
  const bodies = []
  await withServer((request, response, body) => {
    bodies.push(body)
    if (bodies.length === 1) {
      response.writeHead(200, { 'Content-Type': 'text/event-stream' })
      event(response, { id: 'chat-history-tool', object: 'chat.completion.chunk', created: 1, model: body.model,
        choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'call-history', type: 'function', function: { name: 'list_folder', arguments: '{"path":""}' } }] }, finish_reason: null }] })
      event(response, { id: 'chat-history-tool', object: 'chat.completion.chunk', created: 1, model: body.model,
        choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })
      response.end('data: [DONE]\n\n')
      return
    }
    completion(response)
  }, async (origin) => {
    const events = []
    const tools = [{
      name: 'list_folder', label: '列出目录', description: '列出媒体库目录',
      parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false },
      async execute() { return { content: [{ type: 'text', text: '{"items":[]}' }], details: {} } },
    }]
    const result = await runPiAgentWithTools(configuration(`${origin}/v1`), {
      prompt: '第二个问题', systemPrompt: '你是媒体库助手',
      history: [{ role: 'user', content: '第一个问题' }, { role: 'assistant', content: '第一轮回答' }],
      tools,
      onEvent: (streamEvent) => events.push(streamEvent),
    })
    assert.equal(result.text, '整理完成')
    assert.equal(events.filter((streamEvent) => streamEvent.type === 'delta').map((streamEvent) => streamEvent.text).join(''), '整理完成')
    assert.deepEqual(events.filter((streamEvent) => streamEvent.type === 'tool_start').map((streamEvent) => streamEvent.name), ['list_folder'])
    assert.deepEqual(events.filter((streamEvent) => streamEvent.type === 'tool_end').map((streamEvent) => [streamEvent.name, streamEvent.isError]), [['list_folder', false]])
  })
  const messages = bodies[0].messages
  assert.deepEqual(messages.map((message) => message.role), ['system', 'user', 'assistant', 'user'])
  assert.equal(messages[1].content, '第一个问题')
  assert.ok(JSON.stringify(messages[2]).includes('第一轮回答'))
  assert.ok(JSON.stringify(messages[3]).includes('第二个问题'))
})

test('invalid or oversized history is rejected before any upstream request', async () => {
  let requests = 0
  await withServer((request, response) => {
    requests += 1
    completion(response)
  }, async (origin) => {
    const base = configuration(`${origin}/v1`)
    const oversized = Array.from({ length: 41 }, (_value, index) => ({
      role: index % 2 === 0 ? 'user' : 'assistant', content: `turn-${index}`,
    }))
    await assert.rejects(runPiAgentWithTools(base, { prompt: '继续', systemPrompt: '你是助手', history: oversized }), { code: 'PI_HISTORY_INVALID', statusCode: 400 })
    await assert.rejects(runPiAgentWithTools(base, { prompt: '继续', systemPrompt: '你是助手',
      history: [{ role: 'assistant', content: 'y'.repeat(8001) }] }), { code: 'PI_HISTORY_INVALID', statusCode: 400 })
  })
  assert.equal(requests, 0)
})
