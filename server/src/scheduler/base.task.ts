import type { AppConfig, Logger } from '../types.ts'

/** 任务可用的进程级上下文；能力来自注入的 services，而不是全局单例。 */
export interface TaskContext {
  services: Record<string, any>
  settings: AppConfig
}

export interface TaskRuntime {
  signal: AbortSignal
  logger?: Logger
}

/**
 * 定时任务基类。子类声明 type / 默认 cron，并实现 run。
 * 配置只提供调度参数与 options，任务能力来自注入的 context（services / settings / logger）。
 */
export abstract class BaseTask<TOptions = Record<string, unknown>> {
  /** 任务类型，必须与 tasks.yaml 的 type 对应。 */
  static type = ''
  /** 未在 YAML 指定 cron 时使用的默认值。 */
  static cron = ''
  /** 默认超时，毫秒。 */
  static timeoutMs = 15 * 60 * 1000
  /** 默认参数。 */
  static options: Record<string, unknown> = {}

  readonly context: TaskContext

  constructor(context: TaskContext) {
    this.context = context
  }

  /** 校验并规范化 YAML 里的 options；抛错会让配置校验失败。 */
  validate(options: Record<string, unknown>): TOptions {
    return (options ?? {}) as TOptions
  }

  /** 执行一次任务。 */
  abstract run(options: TOptions, runtime: TaskRuntime): Promise<unknown>
}

export default BaseTask
