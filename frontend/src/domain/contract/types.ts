/**
 * 模板版本兼容检查与字段映射契约发布 —— 领域类型。
 *
 * 调用链：
 *   网页模板登记 → 版本兼容校验（入口地址/列表选择器/分页规则差异）
 *   → 生成可引用的模板版本 → 并发发布仅一个当前版本（事务，异常回滚）
 *   → 字段映射启用时绑定已通过校验的版本形成契约 → 解析结果按契约引用
 *
 * 历史版本一经发布即只读；兼容冲突时以通过校验的已发布版本为准，不自动覆盖旧记录。
 */

/** 一次版本的生命周期状态。历史版本永远停留在「已发布-只读」，不允许再改。 */
export type TemplateVersionStatus = '草稿' | '待校验' | '已通过' | '已发布' | '校验未通过' | '已废弃'

/** 兼容校验里逐项比对的三个关键差异维度（对应需求中的入口地址、列表选择器、分页规则）。 */
export type DifferenceKey = '入口地址' | '列表选择器' | '分页规则'

export type DifferenceLevel = '一致' | '不兼容' | '可迁移'

/** 单个维度的差异结论。 */
export interface ValidationCheck {
  key: DifferenceKey
  /** 被校验版本上的值。 */
  current: string
  /** 对照基准（上一已发布版本）上的值；首个版本没有基准时为空串。 */
  baseline: string
  level: DifferenceLevel
  /** 给人工看的差异说明，也是后续冲突仲裁的依据。 */
  detail: string
}

/**
 * 模板版本：抽取模板（网页模板）每改一次入口/选择器/分页规则，就沉淀一个可引用版本。
 * 版本号在同一抽取模板内自增，如 1.0.0 → 1.1.0。
 */
export interface TemplateVersion {
  id: number
  /** 抽取模板编号，关联 template 模块里的网页模板记录，如 TEMP-0001。 */
  templateCode: string
  version: string
  status: TemplateVersionStatus
  entryUrl: string
  listSelector: string
  detailSelector: string
  paginationRule: string
  /** 兼容构建环境：旧模板先在本地开发环境构建依赖，再上线部署，见 MigrationTask。 */
  dataFormat: string
  /** 该版本对照的上一版本 id；首个版本为 null。 */
  baselineVersionId: number | null
  /** 最近一次校验记录 id；未校验为 null。 */
  lastValidationId: number | null
  /** 是否为该抽取模板当前唯一生效的版本，同一模板同时只允许一个为 true。 */
  current: boolean
  /** 只读标记：已发布版本（含历史版本）一律只读。 */
  readonly: boolean
  /** 迁移来源：存量网页模板回填时保留原入口地址与字段映射依据。 */
  migratedFrom: string | null
  createdAt: string
  publishedAt: string | null
}

/** 一次完整的版本兼容校验记录，含三个维度的差异明细与整体结论。 */
export interface ValidationRecord {
  id: number
  templateVersionId: number
  templateCode: string
  version: string
  passed: boolean
  checks: ValidationCheck[]
  /** 整体差异摘要，发布与冲突仲裁时直接引用。 */
  summary: string
  createdAt: string
}

/** 字段映射契约：字段映射（extractor 映射规则）启用时必须绑定一个「已通过校验」的模板版本。 */
export interface FieldContract {
  id: number
  contractNo: string
  /** 字段映射规则编号，关联 extractor 模块，如 EXTR-0001。 */
  extractorCode: string
  sourceField: string
  targetField: string
  /** 绑定的模板版本 id；启用前必须指向通过校验的版本。 */
  templateVersionId: number
  templateCode: string
  templateVersion: string
  status: '草稿' | '待发布' | '已发布' | '已停用'
  /** 契约版本：同一映射规则每次重新发布自增，历史契约只读。 */
  contractRevision: number
  readonly: boolean
  /** 发布结果是否已同步回字段映射清单模块。 */
  syncedToExtractor: boolean
  publishedAt: string | null
  createdAt: string
}

/** 不同版本字段映射冲突：由校验结果给出明确优先级，不自动覆盖旧模板记录。 */
export interface MappingConflict {
  id: number
  templateCode: string
  fieldName: string
  /** 发生冲突的两个版本。 */
  versionA: string
  versionB: string
  valueA: string
  valueB: string
  /** 仲裁优先级：通过校验的已发布版本优先；这里记录结论而非自动改写数据。 */
  winnerVersion: string
  reason: string
  /** 旧模板记录保持只读，冲突只登记不覆盖。 */
  resolved: boolean
  createdAt: string
}

/**
 * 发布事务：并发发布同一抽取模板时只允许一个版本成为当前版本。
 * 提交异常必须回滚到上一当前版本，并保留差异记录。
 */
export interface PublishTransaction {
  id: number
  templateCode: string
  templateVersionId: number
  /** 事务开始前的当前版本 id，回滚时恢复它。 */
  previousCurrentVersionId: number | null
  state: '进行中' | '已提交' | '已回滚'
  /** 模拟提交异常的开关，用于演示事务回滚恢复上一版本。 */
  failOnCommit: boolean
  message: string
  createdAt: string
  finishedAt: string | null
}

/** 存量网页模板迁移任务：旧模板先本地开发环境兼容构建，再作为契约依赖上线。 */
export interface MigrationTask {
  id: number
  templateCode: string
  /** 原网页模板记录的入口地址，迁移后仍保留在新版本上。 */
  originEntryUrl: string
  /** 原字段映射依据（映射规则编号），迁移回填时沿用，不产生第二套契约。 */
  originExtractorCode: string
  stage: '待构建' | '本地开发环境构建' | '兼容校验' | '上线部署' | '已完成'
  /** 构建/回填过程中保留的差异说明。 */
  diffNote: string
  targetVersionId: number | null
  createdAt: string
  finishedAt: string | null
}

/** 另一个页面（解析结果页）展示的解析样本：明确标注本次解析引用的契约。 */
export interface ParseSample {
  id: number
  templateCode: string
  /** 本次解析实际使用的契约编号；没有契约则无法解析。 */
  contractNo: string | null
  templateVersion: string
  sourceField: string
  targetField: string
  rawValue: string
  parsedValue: string
  parsedAt: string
}

/** 领域整体持久化结构。 */
export interface ContractState {
  versions: TemplateVersion[]
  validations: ValidationRecord[]
  contracts: FieldContract[]
  conflicts: MappingConflict[]
  transactions: PublishTransaction[]
  migrations: MigrationTask[]
  parseSamples: ParseSample[]
  seq: Record<string, number>
}
