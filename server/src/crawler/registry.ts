import { BangumiCrawler } from './bangumi.crawler.ts'
import { CrawlerError } from './crawler-error.ts'
import type { CrawlerDependencies, CrawlerDescriptor } from './base.crawler.ts'
import type { CrawlerSourceConfig } from '../types.ts'

/** Config entries the registry understands; unimplemented sources stay unimplemented. */
export interface CrawlerRegistryConfig {
  bangumi?: Partial<CrawlerSourceConfig>
  douban?: Partial<CrawlerSourceConfig>
}

/** Public registry surface; only implemented and enabled sources are created. */
export interface CrawlerRegistry {
  list(): CrawlerDescriptor[]
  get(source: string): BangumiCrawler
  close(): Promise<void>
}

/** Explicit allowlist: unimplemented sources cannot be enabled through configuration. */
export function createCrawlerRegistry(configs: CrawlerRegistryConfig = {}, dependencies: CrawlerDependencies = {}): CrawlerRegistry {
  const instances = new Map<string, BangumiCrawler>()
  if (configs.bangumi?.enabled === true) instances.set('bangumi', new BangumiCrawler(configs.bangumi, dependencies))
  return {
    list(): CrawlerDescriptor[] { return [...instances.values()].map(crawler => crawler.describe()) },
    get(source: string): BangumiCrawler {
      if (typeof source !== 'string' || !['bangumi', 'douban'].includes(source)) throw new CrawlerError('UNSUPPORTED_SOURCE', typeof source === 'string' && /^[a-z-]{1,50}$/.test(source) ? source : 'unknown', '不支持该元数据来源')
      const crawler = instances.get(source)
      if (!crawler) throw new CrawlerError(source === 'bangumi' ? 'SOURCE_DISABLED' : 'UNSUPPORTED_SOURCE', source, source === 'bangumi' ? '该来源未启用' : '该来源尚未实现')
      return crawler
    },
    async close(): Promise<void> { await Promise.all([...instances.values()].map(crawler => crawler.close())) },
  }
}
