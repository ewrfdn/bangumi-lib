/** Structural tool contract shared by agent definitions and the Pi runtime. */
export interface AgentToolResult {
  content: Array<{ type: 'text'; text: string }>
  details?: unknown
  terminate?: boolean
}

export interface AgentTool {
  name: string
  label: string
  description: string
  parameters: Record<string, unknown>
  executionMode?: 'sequential' | 'parallel'
  execute(id: string, params: Record<string, any>, signal?: AbortSignal): Promise<AgentToolResult>
}

/** 一条已完成的对话轮次，运行时回放成真实的 user/assistant 消息。 */
export interface AgentConversationTurn {
  role: 'user' | 'assistant'
  content: string
}

/** 运行过程中推给传输层（WebSocket UI）的事件；只是展示，不参与业务判断。 */
export type AgentStreamEvent =
  | { type: 'delta'; text: string }
  | { type: 'tool_start'; toolCallId: string; name: string; args: unknown }
  | { type: 'tool_end'; toolCallId: string; name: string; isError: boolean; durationMs?: number }

export interface AgentRunResult {
  text: string
  usage?: unknown
  model: string
  stopReason?: string
  turns?: number
  toolCalls?: number
}

export interface AgentRunOptions {
  prompt: string
  systemPrompt: string
  tools?: AgentTool[]
  /** 本轮之前的对话轮次，按时间正序；最新一条用户消息通过 prompt 传入。 */
  history?: AgentConversationTurn[]
  signal?: AbortSignal
  maxTurns?: number
  maxToolCalls?: number
  timeoutMs?: number
  /** 流式正文与工具活动；回调抛错不得影响 Agent 运行。 */
  onEvent?: (event: AgentStreamEvent) => void
}
