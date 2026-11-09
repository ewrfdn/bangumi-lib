import { BaseTask } from '../base.task.ts'

/** 扫描摘要；扫描器返回的字段在这里全部保留。 */
export interface ScanTaskResult {
  libraryId: string
  classified: number
  synced: number
  deferred: number
  visited: number
  changed: number
  failed: number
  missing: number
  durationMs: number
}

/** 扫描媒体库目录，把变化交给 Agent。 */
export class ScanLibraryTask extends BaseTask<{ libraryId: string; maxDepth: number }> {
  static type = 'scan_library'
  static cron = '0 */10 * * * *'
  static timeoutMs = 15 * 60 * 1000
  static options = { maxDepth: 4 }

  validate(options: Record<string, unknown>): { libraryId: string; maxDepth: number } {
    const { settings } = this.context
    const libraryId = typeof options.libraryId === 'string' ? options.libraryId : settings.defaultLibraryId
    settings.getLibrary(libraryId)
    const maxDepth = typeof options.maxDepth === 'number' ? options.maxDepth : ScanLibraryTask.options.maxDepth
    if (!Number.isInteger(maxDepth) || maxDepth < 0 || maxDepth > 10) throw new Error('scan_library.maxDepth 必须是 0 到 10 的整数')
    return { libraryId, maxDepth }
  }

  async run(options: { libraryId: string; maxDepth: number }, { signal }: { signal: AbortSignal }): Promise<ScanTaskResult> {
    return this.context.services.scan.scanLibrary(options.libraryId, { maxDepth: options.maxDepth, signal }) as Promise<ScanTaskResult>
  }
}

export default ScanLibraryTask
