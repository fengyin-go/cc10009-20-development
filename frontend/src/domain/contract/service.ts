import { listRows, saveRows } from '@/data/local-store'
import type { EntryRow } from '@/data/types'

import { contractState, mutateState, nextId } from './store'
import type {
  ContractState,
  FieldContract,
  MappingConflict,
  MigrationTask,
  ParseSample,
  PublishTransaction,
  TemplateVersion,
  ValidationCheck,
  ValidationRecord,
} from './types'

export interface ServiceResult<T = undefined> {
  ok: boolean
  message: string
  data?: T
}

function now(): string {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function findVersion(state: ContractState, versionId: number): TemplateVersion | undefined {
  return state.versions.find((item) => item.id === versionId)
}

/** 同一抽取模板当前唯一生效的版本（每次发布只允许一个 current）。 */
export function currentVersionOf(state: ContractState, templateCode: string): TemplateVersion | undefined {
  return state.versions.find((item) => item.templateCode === templateCode && item.current)
}

function baselineOf(state: ContractState, version: TemplateVersion): TemplateVersion | undefined {
  if (version.baselineVersionId === null) {
    return undefined
  }
  return findVersion(state, version.baselineVersionId)
}

function bumpVersion(version: string): string {
  const parts = version.split('.').map((part) => Number(part))
  parts[1] = (parts[1] ?? 0) + 1
  return parts.map((part) => String(part)).join('.')
}

// ---------------------------------------------------------------------------
// 1. 网页模板登记：为抽取模板沉淀一个新的可校验版本（历史版本保持只读，不动旧记录）
// ---------------------------------------------------------------------------

export interface NewVersionInput {
  templateCode: string
  entryUrl: string
  listSelector: string
  paginationRule: string
  detailSelector?: string
  dataFormat?: string
}

export function registerTemplateVersion(input: NewVersionInput): ServiceResult<TemplateVersion> {
  if (!input.templateCode.trim() || !input.entryUrl.trim() || !input.listSelector.trim() || !input.paginationRule.trim()) {
    return { ok: false, message: '模板编号、入口地址、列表选择器、分页规则均为必填，无法生成可引用版本。' }
  }
  let created: TemplateVersion | undefined
  mutateState((draft) => {
    const existing = draft.versions
      .filter((item) => item.templateCode === input.templateCode)
      .sort((a, b) => b.id - a.id)
    const previous = existing[0]
    const current = currentVersionOf(draft, input.templateCode)
    const version = previous ? bumpVersion(previous.version) : '1.0.0'
    const id = nextId(draft, 'versions')
    created = {
      id,
      templateCode: input.templateCode.trim(),
      version,
      status: '草稿',
      entryUrl: input.entryUrl.trim(),
      listSelector: input.listSelector.trim(),
      detailSelector: (input.detailSelector ?? previous?.detailSelector ?? '').trim(),
      paginationRule: input.paginationRule.trim(),
      dataFormat: (input.dataFormat ?? previous?.dataFormat ?? 'HTML').trim(),
      // 基准固定指向当前已发布版本：差异与回滚都围绕它展开。
      baselineVersionId: current ? current.id : previous ? previous.id : null,
      lastValidationId: null,
      current: false,
      readonly: false,
      migratedFrom: null,
      createdAt: now(),
      publishedAt: null,
    }
    draft.versions.push(created)
  })
  return {
    ok: true,
    message: `已为抽取模板 ${input.templateCode} 生成待校验版本 ${created!.version}，历史版本未被改动。`,
    data: created,
  }
}

// ---------------------------------------------------------------------------
// 2. 模板版本兼容校验：逐项记录入口地址 / 列表选择器 / 分页规则差异
// ---------------------------------------------------------------------------

function compareDimension(
  key: ValidationCheck['key'],
  current: string,
  baseline: string,
  migrated: boolean,
): ValidationCheck {
  if (baseline === '') {
    return { key, current, baseline, level: '一致', detail: '首个版本无历史基准，登记值直接作为契约基准。' }
  }
  if (current === baseline) {
    return { key, current, baseline, level: '一致', detail: `与已发布版本保持一致（${current}）。` }
  }
  // 迁移回填的存量模板保留原入口地址等依据，差异记为「可迁移」而非直接判不兼容。
  const level = migrated ? '可迁移' : '不兼容'
  const detail = migrated
    ? `存量模板迁移：由「${baseline}」调整为「${current}」，保留原入口地址与字段映射依据，按可迁移处理。`
    : `改版后与已发布版本不一致：由「${baseline}」变为「${current}」，旧入口/选择器不再兼容，需以通过校验的新版本为准。`
  return { key, current, baseline, level, detail }
}

export function validateTemplateVersion(versionId: number): ServiceResult<ValidationRecord> {
  const state = contractState()
  const version = findVersion(state, versionId)
  if (!version) {
    return { ok: false, message: `未找到模板版本 #${versionId}。` }
  }
  if (version.readonly) {
    return { ok: false, message: `版本 ${version.version} 是已发布的只读历史版本，不能重复校验，请基于它登记新版本。` }
  }
  const baseline = baselineOf(state, version)
  const migrated = version.migratedFrom !== null
  const checks: ValidationCheck[] = [
    compareDimension('入口地址', version.entryUrl, baseline?.entryUrl ?? '', migrated),
    compareDimension('列表选择器', version.listSelector, baseline?.listSelector ?? '', migrated),
    compareDimension('分页规则', version.paginationRule, baseline?.paginationRule ?? '', migrated),
  ]
  const incompatible = checks.filter((item) => item.level === '不兼容').length
  const passed = incompatible === 0
  let record: ValidationRecord | undefined
  mutateState((draft) => {
    const target = draft.versions.find((item) => item.id === versionId)!
    const id = nextId(draft, 'validations')
    const diffParts = checks
      .filter((item) => item.level !== '一致')
      .map((item) => `${item.key}${item.level}（${item.baseline || '无历史基准'} → ${item.current}）`)
    record = {
      id,
      templateVersionId: versionId,
      templateCode: target.templateCode,
      version: target.version,
      passed,
      checks,
      summary: passed
        ? (diffParts.length
            ? `存在 ${diffParts.length} 项可迁移差异，保留旧模板依据，校验通过：${diffParts.join('；')}。`
            : '三项规则与已发布版本完全一致，校验通过。')
        : `存在 ${incompatible} 项不兼容差异，校验未通过：${diffParts.join('；')}。兼容冲突须以通过校验的已发布版本为准。`,
      createdAt: now(),
    }
    draft.validations.push(record)
    target.lastValidationId = id
    target.status = passed ? '已通过' : '校验未通过'
  })
  return {
    ok: passed,
    message: passed
      ? `版本 ${version.version} 兼容校验通过，已形成可引用版本，字段映射可绑定该契约。`
      : `版本 ${version.version} 校验未通过：${incompatible} 项规则与已发布版本不兼容，不能发布契约。`,
    data: record,
  }
}

// ---------------------------------------------------------------------------
// 3. 并发发布事务：同一抽取模板只允许一个版本成为当前版本；提交异常回滚上一版本
// ---------------------------------------------------------------------------

export function publishTemplateVersion(
  versionId: number,
  failOnCommit = false,
): ServiceResult<PublishTransaction> {
  const state = contractState()
  const version = findVersion(state, versionId)
  if (!version) {
    return { ok: false, message: `未找到模板版本 #${versionId}。` }
  }
  if (version.readonly) {
    return { ok: false, message: `版本 ${version.version} 已是只读历史版本，无需重复发布。` }
  }
  if (version.status !== '已通过') {
    return { ok: false, message: `版本 ${version.version} 尚未通过兼容校验，不能发布；请先执行版本校验。` }
  }
  // 并发护栏：同一模板已有进行中的发布事务时，拒绝第二个发布者。
  const busy = state.transactions.some(
    (tx) => tx.templateCode === version.templateCode && tx.state === '进行中',
  )
  if (busy) {
    return { ok: false, message: `抽取模板 ${version.templateCode} 已有并发发布进行中，同一时刻只允许一个版本生效，请稍后重试。` }
  }

  const previous = currentVersionOf(state, version.templateCode) ?? null
  let txId = 0

  // 第一步：登记「进行中」事务并抢占发布资格（模拟并发串行化）。
  mutateState((draft) => {
    const opened: PublishTransaction = {
      id: nextId(draft, 'transactions'),
      templateCode: version.templateCode,
      templateVersionId: versionId,
      previousCurrentVersionId: previous ? previous.id : null,
      state: '进行中',
      failOnCommit,
      message: '发布事务已开启，正在抢占当前版本资格。',
      createdAt: now(),
      finishedAt: null,
    }
    txId = opened.id
    draft.transactions.push(opened)
  })

  // 第二步：提交。failOnCommit 模拟事务提交异常 → 恢复上一版本并保留差异记录。
  if (failOnCommit) {
    mutateState((draft) => {
      const target = draft.transactions.find((item) => item.id === txId)!
      target.state = '已回滚'
      target.message = `提交异常：已恢复上一当前版本 ${previous ? previous.version : '（无）'}，本次差异记录保留在兼容校验中，未覆盖任何旧模板记录。`
      target.finishedAt = now()
    })
    const rolledBack = contractState().transactions.find((item) => item.id === txId)!
    return {
      ok: false,
      message: rolledBack.message,
      data: rolledBack,
    }
  }

  mutateState((draft) => {
    // 唯一当前版本：先清掉同模板所有 current，再置新版本。
    draft.versions
      .filter((item) => item.templateCode === version.templateCode)
      .forEach((item) => {
        if (item.id === versionId) {
          item.current = true
          item.status = '已发布'
          item.readonly = true
          item.publishedAt = now()
        } else if (item.current) {
          item.current = false
          // 历史版本保持只读：状态仍是已发布，仅让出 current 标记。
          item.readonly = true
        }
      })
    const target = draft.transactions.find((item) => item.id === txId)!
    target.state = '已提交'
    target.message = `发布成功：${version.version} 成为 ${version.templateCode} 唯一当前版本，历史版本转为只读。`
    target.finishedAt = now()
  })

  // 发布成功后登记字段映射冲突（若新旧版本对同一字段给了不同依据），只仲裁不覆盖。
  registerConflictsForPublish(versionId)

  const committed = contractState().transactions.find((item) => item.id === txId)!
  return { ok: true, message: committed.message, data: committed }
}

// ---------------------------------------------------------------------------
// 4. 字段映射冲突：由校验结果给出明确优先级，绝不自动覆盖旧模板记录
// ---------------------------------------------------------------------------

function registerConflictsForPublish(versionId: number): void {
  const state = contractState()
  const winner = findVersion(state, versionId)
  if (!winner) {
    return
  }
  // 已绑定到该模板「其他历史版本」的契约，与新版本并存即构成潜在冲突。
  const olderContracts = state.contracts.filter(
    (contract) =>
      contract.templateCode === winner.templateCode &&
      contract.templateVersionId !== winner.id,
  )
  if (olderContracts.length === 0) {
    return
  }
  mutateState((draft) => {
    for (const contract of olderContracts) {
      const exists = draft.conflicts.some(
        (conflict) =>
          conflict.templateCode === winner.templateCode &&
          conflict.fieldName === contract.targetField &&
          conflict.versionB === winner.version,
      )
      if (exists) {
        continue
      }
      draft.conflicts.push({
        id: nextId(draft, 'conflicts'),
        templateCode: winner.templateCode,
        fieldName: contract.targetField,
        versionA: contract.templateVersion,
        versionB: winner.version,
        valueA: `契约 ${contract.contractNo} 绑定的历史解析依据`,
        valueB: `新版本 ${winner.version} 校验通过后的解析依据`,
        // 优先级结论：通过校验的已发布版本优先；旧记录保留只读，不被改写。
        winnerVersion: winner.version,
        reason: `版本 ${winner.version} 已通过兼容校验并发布，冲突时以该已发布版本为准；版本 ${contract.templateVersion} 的旧模板记录保持只读，不自动覆盖。`,
        resolved: true,
        createdAt: now(),
      })
    }
  })
}

export function listConflicts(templateCode?: string): MappingConflict[] {
  const state = contractState()
  return templateCode
    ? state.conflicts.filter((item) => item.templateCode === templateCode)
    : [...state.conflicts]
}

// ---------------------------------------------------------------------------
// 5. 字段映射契约：启用时必须绑定一个「已通过校验」的版本；发布结果同步清单
// ---------------------------------------------------------------------------

export interface BindContractInput {
  extractorCode: string
  sourceField: string
  targetField: string
  templateVersionId: number
}

export function bindFieldContract(input: BindContractInput): ServiceResult<FieldContract> {
  const state = contractState()
  const version = findVersion(state, Number(input.templateVersionId))
  if (!version) {
    return { ok: false, message: '绑定失败：所选模板版本不存在。' }
  }
  // 硬性约束：字段映射启用时必须绑定一个已通过校验的版本。
  if (version.status !== '已通过' && version.status !== '已发布') {
    return { ok: false, message: `绑定失败：版本 ${version.version} 状态为「${version.status}」，未通过兼容校验，不能作为字段映射契约依赖。` }
  }
  if (!input.extractorCode.trim() || !input.sourceField.trim() || !input.targetField.trim()) {
    return { ok: false, message: '绑定失败：映射规则编号、源字段、目标字段均为必填。' }
  }
  let contract: FieldContract | undefined
  mutateState((draft) => {
    const revision = draft.contracts.filter((item) => item.extractorCode === input.extractorCode).length + 1
    const id = nextId(draft, 'contracts')
    contract = {
      id,
      contractNo: `CTR-${String(id).padStart(4, '0')}`,
      extractorCode: input.extractorCode.trim(),
      sourceField: input.sourceField.trim(),
      targetField: input.targetField.trim(),
      templateVersionId: version.id,
      templateCode: version.templateCode,
      templateVersion: version.version,
      status: '待发布',
      contractRevision: revision,
      readonly: false,
      syncedToExtractor: false,
      publishedAt: null,
      createdAt: now(),
    }
    draft.contracts.push(contract)
  })
  return {
    ok: true,
    message: `字段映射 ${input.extractorCode} 已绑定通过校验的版本 ${version.version}（契约 ${contract!.contractNo}），发布后才会同步到字段映射清单。`,
    data: contract,
  }
}

/** 发布契约并把结果同步回字段映射（extractor）清单模块，保证两边只有一套契约版本。 */
export function publishContract(contractId: number): ServiceResult<FieldContract> {
  const state = contractState()
  const contract = state.contracts.find((item) => item.id === contractId)
  if (!contract) {
    return { ok: false, message: `未找到契约 #${contractId}。` }
  }
  if (contract.readonly) {
    return { ok: false, message: `契约 ${contract.contractNo} 是只读历史修订，不能重复发布。` }
  }
  const version = findVersion(state, contract.templateVersionId)
  if (!version || (version.status !== '已通过' && version.status !== '已发布')) {
    return { ok: false, message: '发布中止：绑定的模板版本未通过校验，契约不允许上线。' }
  }

  // 同步字段映射清单：在 extractor 清单里写入契约版本与绑定状态（发布结果同步更新）。
  const extractorRows: EntryRow[] = listRows('extractor').map((row) => ({ ...row }))
  const rowIndex = extractorRows.findIndex((row) => String(row['规则编号']) === contract.extractorCode)
  if (rowIndex < 0) {
    return { ok: false, message: `字段映射清单中不存在 ${contract.extractorCode}，无法同步发布结果。` }
  }
  extractorRows[rowIndex] = {
    ...extractorRows[rowIndex],
    status: '已启用',
    pending: false,
    契约编号: contract.contractNo,
    绑定模板版本: `${contract.templateCode}@${contract.templateVersion}`,
    契约状态: '已发布',
  }

  let updated: FieldContract | undefined
  mutateState((draft) => {
    const target = draft.contracts.find((item) => item.id === contractId)!
    target.status = '已发布'
    target.readonly = true
    target.syncedToExtractor = true
    target.publishedAt = now()
    updated = { ...target }
  })
  saveRows('extractor', extractorRows)
  return {
    ok: true,
    message: `契约 ${contract.contractNo} 已发布并同步字段映射清单：${contract.extractorCode} 绑定 ${contract.templateCode}@${contract.templateVersion}，全平台仅保留这一套契约版本。`,
    data: updated,
  }
}

// ---------------------------------------------------------------------------
// 6. 存量网页模板迁移与历史回填：本地开发环境构建 → 兼容校验 → 上线，保留原依据
// ---------------------------------------------------------------------------

export function createMigrationTask(
  templateCode: string,
  originEntryUrl: string,
  originExtractorCode: string,
): ServiceResult<MigrationTask> {
  if (!templateCode.trim() || !originEntryUrl.trim() || !originExtractorCode.trim()) {
    return { ok: false, message: '迁移失败：模板编号、原入口地址、原字段映射依据均为必填。' }
  }
  let task: MigrationTask | undefined
  mutateState((draft) => {
    task = {
      id: nextId(draft, 'migrations'),
      templateCode: templateCode.trim(),
      originEntryUrl: originEntryUrl.trim(),
      originExtractorCode: originExtractorCode.trim(),
      stage: '本地开发环境构建',
      diffNote: '旧模板先进入本地开发环境做兼容构建，依赖构建通过后再校验上线。',
      targetVersionId: null,
      createdAt: now(),
      finishedAt: null,
    }
    draft.migrations.push(task)
  })
  return { ok: true, message: `迁移任务已建立：${templateCode} 进入本地开发环境兼容构建，原入口地址与字段映射依据已留存。`, data: task }
}

/**
 * 推进迁移：兼容构建通过后，基于存量网页模板回填一个新版本。
 * 关键：新版本保留原入口地址与原字段映射依据（migratedFrom 标记），差异按「可迁移」处理，
 * 从而避免上线后出现两套契约。
 */
export function completeMigration(taskId: number): ServiceResult<{ task: MigrationTask; version: TemplateVersion }> {
  const state = contractState()
  const task = state.migrations.find((item) => item.id === taskId)
  if (!task) {
    return { ok: false, message: `未找到迁移任务 #${taskId}。` }
  }
  if (task.stage === '已完成') {
    return { ok: false, message: '该迁移任务已完成，历史回填不允许重复执行。' }
  }
  const current = currentVersionOf(state, task.templateCode)
  let newVersion: TemplateVersion | undefined
  let migratedTask: MigrationTask | undefined
  mutateState((draft) => {
    // 版本号基于该模板最新一条记录递增，避免与已登记的草稿版本重号。
    const latest = draft.versions
      .filter((item) => item.templateCode === task.templateCode)
      .sort((a, b) => b.id - a.id)[0]
    const base = current ?? latest
    const versionId = nextId(draft, 'versions')
    newVersion = {
      id: versionId,
      templateCode: task.templateCode,
      version: base ? bumpVersion(base.version) : '1.0.0',
      status: '草稿',
      // 历史回填：保留原入口地址，而不是用改版后的新地址覆盖。
      entryUrl: task.originEntryUrl,
      listSelector: base?.listSelector ?? '',
      detailSelector: base?.detailSelector ?? '',
      paginationRule: base?.paginationRule ?? '',
      dataFormat: base?.dataFormat ?? 'HTML',
      baselineVersionId: base ? base.id : null,
      lastValidationId: null,
      current: false,
      readonly: false,
      migratedFrom: `存量网页模板回填，保留原字段映射依据 ${task.originExtractorCode}`,
      createdAt: now(),
      publishedAt: null,
    }
    draft.versions.push(newVersion)
    const targetTask = draft.migrations.find((item) => item.id === taskId)!
    targetTask.stage = '兼容校验'
    targetTask.targetVersionId = versionId
    targetTask.diffNote = `${targetTask.diffNote} 已回填历史版本 ${newVersion.version}，原入口地址与 ${task.originExtractorCode} 依据保留，等待兼容校验后上线部署。`
    migratedTask = { ...targetTask }
  })
  // 自动跑一次兼容校验（迁移差异为「可迁移」，应通过）。
  const validation = validateTemplateVersion(newVersion!.id)
  let message = `${migratedTask!.diffNote} 校验结论：${validation.message}`
  if (validation.ok) {
    mutateState((draft) => {
      const targetTask = draft.migrations.find((item) => item.id === taskId)!
      targetTask.stage = '上线部署'
      targetTask.diffNote = `${targetTask.diffNote} 兼容校验通过，可作为字段映射契约依赖上线，部署后仅保留一个契约版本。`
      migratedTask = { ...targetTask }
    })
    message = migratedTask!.diffNote
  }
  return { ok: validation.ok, message, data: { task: migratedTask!, version: newVersion! } }
}

// ---------------------------------------------------------------------------
// 7. 解析结果：另一个页面展示本次解析使用的契约（无契约不解析）
// ---------------------------------------------------------------------------

export function runParse(
  templateCode: string,
  rawValue: string,
  extractorCode?: string,
): ServiceResult<ParseSample> {
  const state = contractState()
  // 解析只能引用「已发布」契约；同一模板当前契约唯一。
  const contract = state.contracts.find(
    (item) =>
      item.templateCode === templateCode &&
      item.status === '已发布' &&
      (extractorCode ? item.extractorCode === extractorCode : true),
  )
  if (!contract) {
    return { ok: false, message: `抽取模板 ${templateCode} 没有已发布的字段映射契约，解析中止；请先绑定通过校验的版本并发布契约。` }
  }
  let sample: ParseSample | undefined
  mutateState((draft) => {
    sample = {
      id: nextId(draft, 'parseSamples'),
      templateCode,
      contractNo: contract.contractNo,
      templateVersion: contract.templateVersion,
      sourceField: contract.sourceField,
      targetField: contract.targetField,
      rawValue,
      // 纯前端演示：去掉简单 HTML 标签与首尾空白，代表按契约完成一次字段解析。
      parsedValue: rawValue.replace(/<[^>]+>/g, '').trim(),
      parsedAt: now(),
    }
    draft.parseSamples.push(sample)
  })
  return {
    ok: true,
    message: `解析完成，引用契约 ${contract.contractNo}（${templateCode}@${contract.templateVersion}）。`,
    data: sample,
  }
}

// ---------------------------------------------------------------------------
// 8. 只读查询
// ---------------------------------------------------------------------------

export function listVersions(templateCode?: string): TemplateVersion[] {
  const state = contractState()
  return templateCode
    ? state.versions.filter((item) => item.templateCode === templateCode)
    : [...state.versions]
}

export function listValidations(versionId?: number): ValidationRecord[] {
  const state = contractState()
  return versionId
    ? state.validations.filter((item) => item.templateVersionId === versionId)
    : [...state.validations]
}

export function listContracts(): FieldContract[] {
  return [...contractState().contracts]
}

export function listTransactions(): PublishTransaction[] {
  return [...contractState().transactions]
}

export function listMigrations(): MigrationTask[] {
  return [...contractState().migrations]
}

export function listParseSamples(): ParseSample[] {
  return [...contractState().parseSamples]
}
