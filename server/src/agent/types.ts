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
  signal?: AbortSignal
  maxTurns?: number
  maxToolCalls?: number
  timeoutMs?: number
}
