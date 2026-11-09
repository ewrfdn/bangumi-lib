import type { AgentManager } from '../agent/AgentManager.ts'
import type { AgentRunResult } from '../agent/types.ts'
import type { BangumiAgentContext } from '../agent/agents/bangumi.agent.ts'
import type { AiConfig } from '../types.ts'

/**
 * 扫描器交给 Agent 的上下文：目录只带扫描器真正提供的字段，
 * 媒体库必须带根目录，工具要用它解析相对路径。
 */
export type MediaAgentContext = BangumiAgentContext & { signal?: AbortSignal }

/** AI 配置只读取是否启用；不依赖密钥相关方法。 */
interface AiSettingsLike {
  publicConfig(): Pick<AiConfig, 'enabled'>
}

export interface MediaAgentService {
  enabled(): boolean
  classify(context: MediaAgentContext): Promise<AgentRunResult>
}

export interface MediaAgentDependencies {
  aiSettings: AiSettingsLike
  agents: AgentManager
}

/**
 * 扫描服务与 AgentManager 之间的薄适配层：
 * 判断模型是否可用，并把目录上下文交给注册好的 agent。
 */
export function createMediaAgentService({ aiSettings, agents }: MediaAgentDependencies): MediaAgentService {
  return {
    enabled(): boolean {
      try { return aiSettings.publicConfig().enabled } catch { return false }
    },
    classify(context: MediaAgentContext): Promise<AgentRunResult> {
      return agents.run('bangumi', context, { signal: context.signal })
    },
  }
}
