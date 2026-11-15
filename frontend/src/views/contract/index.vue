<template>
  <section class="page" data-module="contract">
    <header class="page-head">
      <div>
        <h2>模板版本校验与字段映射契约</h2>
        <p class="page-desc">
          抽取模板改版后先做版本兼容校验，记录入口地址、列表选择器、分页规则差异并形成可引用版本；
          字段映射启用必须绑定已通过校验的版本，并发发布仅一个当前版本，历史版本只读。
        </p>
      </div>
      <div class="page-actions">
        <button class="btn" type="button" @click="reload">刷新数据</button>
        <button class="btn ghost" type="button" @click="resetAll">重置演示数据</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="card in statCards" :key="card.label" class="stat-card">
        <span class="stat-label">{{ card.label }}</span>
        <strong class="stat-value">{{ card.value }}</strong>
      </article>
    </div>

    <div class="tab-bar">
      <button
        v-for="tab in tabs"
        :key="tab.key"
        class="tab-btn"
        :class="{ active: activeTab === tab.key }"
        type="button"
        @click="activeTab = tab.key"
      >
        {{ tab.label }}
      </button>
    </div>

    <p v-if="message" class="notice" :class="messageOk ? 'ok' : 'err'">{{ message }}</p>

    <!-- ① 模板版本与兼容校验 -->
    <div v-if="activeTab === 'version'" class="tab-panel">
      <div class="panel-grid">
        <form class="form-card" @submit.prevent="submitNewVersion">
          <h3>登记网页模板新版本</h3>
          <p class="form-hint">改版后的入口/选择器/分页规则沉淀为待校验版本，不改动只读历史版本。</p>
          <label><span>抽取模板编号</span><input v-model="newVersion.templateCode" placeholder="如 TEMP-0001" /></label>
          <label><span>入口地址</span><input v-model="newVersion.entryUrl" placeholder="https://..." /></label>
          <label><span>列表选择器</span><input v-model="newVersion.listSelector" placeholder="CSS 选择器" /></label>
          <label><span>详情选择器</span><input v-model="newVersion.detailSelector" placeholder="可选" /></label>
          <label><span>分页规则</span><input v-model="newVersion.paginationRule" placeholder="如 page={n}" /></label>
          <label><span>数据格式</span><input v-model="newVersion.dataFormat" placeholder="HTML / JSON-LD" /></label>
          <button class="btn primary" type="submit">生成可校验版本</button>
        </form>

        <div class="table-card">
          <h3>模板版本清单（历史版本只读）</h3>
          <table class="data-table">
            <thead>
              <tr>
                <th>模板</th><th>版本</th><th>入口地址</th><th>列表选择器</th><th>分页规则</th>
                <th>状态</th><th>当前版本</th><th>只读</th><th>操作</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="item in versions" :key="item.id">
                <td>{{ item.templateCode }}</td>
                <td>{{ item.version }}</td>
                <td class="cell-wrap">{{ item.entryUrl }}</td>
                <td class="cell-wrap">{{ item.listSelector }}</td>
                <td class="cell-wrap">{{ item.paginationRule }}</td>
                <td>
                  <span class="badge" :class="statusClass(item.status)">{{ item.status }}</span>
                </td>
                <td>
                  <span v-if="item.current" class="badge current">当前生效</span>
                  <span v-else class="muted">—</span>
                </td>
                <td>{{ item.readonly ? '是' : '否' }}</td>
                <td class="row-actions">
                  <button class="link" type="button" :disabled="item.readonly" @click="doValidate(item.id)">兼容校验</button>
                  <button class="link" type="button" :disabled="!canPublish(item)" @click="doPublish(item.id, false)">发布</button>
                  <button class="link danger" type="button" :disabled="!canPublish(item)" @click="doPublish(item.id, true)">模拟提交异常</button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <div class="table-card" style="margin-top: 14px">
        <h3>兼容校验记录（入口地址 / 列表选择器 / 分页规则差异）</h3>
        <table class="data-table">
          <thead>
            <tr><th>模板版本</th><th>结论</th><th>差异明细</th><th>摘要</th><th>时间</th></tr>
          </thead>
          <tbody>
            <tr v-for="record in validations" :key="record.id">
              <td>{{ record.templateCode }}@{{ record.version }}</td>
              <td><span class="badge" :class="record.passed ? 'ok' : 'fail'">{{ record.passed ? '通过' : '未通过' }}</span></td>
              <td>
                <ul class="check-list">
                  <li v-for="check in record.checks" :key="check.key">
                    <strong>{{ check.key }}</strong>
                    <span class="badge" :class="diffClass(check.level)">{{ check.level }}</span>
                    <em class="muted">{{ check.detail }}</em>
                  </li>
                </ul>
              </td>
              <td class="cell-wrap">{{ record.summary }}</td>
              <td>{{ record.createdAt }}</td>
            </tr>
            <tr v-if="!validations.length"><td colspan="5" class="empty-state">暂无校验记录</td></tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- ② 发布事务与并发/回滚 -->
    <div v-if="activeTab === 'tx'" class="tab-panel">
      <div class="table-card">
        <h3>发布事务（同一抽取模板并发只允许一个当前版本，异常回滚并保留差异）</h3>
        <table class="data-table">
          <thead>
            <tr><th>事务#</th><th>模板</th><th>版本#</th><th>上一当前版本</th><th>状态</th><th>说明</th><th>时间</th></tr>
          </thead>
          <tbody>
            <tr v-for="tx in transactions" :key="tx.id">
              <td>{{ tx.id }}</td>
              <td>{{ tx.templateCode }}</td>
              <td>{{ tx.templateVersionId }}</td>
              <td>{{ tx.previousCurrentVersionId ?? '无' }}</td>
              <td><span class="badge" :class="txClass(tx.state)">{{ tx.state }}</span></td>
              <td class="cell-wrap">{{ tx.message }}</td>
              <td>{{ tx.finishedAt ?? tx.createdAt }}</td>
            </tr>
            <tr v-if="!transactions.length"><td colspan="7" class="empty-state">暂无发布事务，可在「模板版本」页发布或模拟提交异常</td></tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- ③ 字段映射契约 -->
    <div v-if="activeTab === 'contract'" class="tab-panel">
      <div class="panel-grid">
        <form class="form-card" @submit.prevent="submitBind">
          <h3>字段映射绑定契约版本</h3>
          <p class="form-hint">字段映射启用时必须绑定一个已通过校验的模板版本，否则不允许发布。</p>
          <label><span>字段映射规则编号</span><input v-model="bindForm.extractorCode" placeholder="如 EXTR-0001" /></label>
          <label><span>源字段名称</span><input v-model="bindForm.sourceField" placeholder="如 title" /></label>
          <label><span>目标字段名称</span><input v-model="bindForm.targetField" placeholder="如 资讯标题" /></label>
          <label>
            <span>绑定模板版本（仅可选择已通过/已发布）</span>
            <select v-model="bindForm.templateVersionId">
              <option :value="0" disabled>请选择已通过校验的版本</option>
              <option v-for="item in bindableVersions" :key="item.id" :value="item.id">
                {{ item.templateCode }}@{{ item.version }}（{{ item.status }}）
              </option>
            </select>
          </label>
          <button class="btn primary" type="submit">生成契约草稿</button>
        </form>

        <div class="table-card">
          <h3>字段映射契约清单（发布结果同步字段映射清单）</h3>
          <table class="data-table">
            <thead>
              <tr><th>契约编号</th><th>映射规则</th><th>字段</th><th>绑定版本</th><th>修订</th><th>状态</th><th>清单同步</th><th>操作</th></tr>
            </thead>
            <tbody>
              <tr v-for="item in contracts" :key="item.id">
                <td>{{ item.contractNo }}</td>
                <td>{{ item.extractorCode }}</td>
                <td>{{ item.sourceField }} → {{ item.targetField }}</td>
                <td>{{ item.templateCode }}@{{ item.templateVersion }}</td>
                <td>r{{ item.contractRevision }}</td>
                <td><span class="badge" :class="statusClass(item.status)">{{ item.status }}</span></td>
                <td>
                  <span class="badge" :class="item.syncedToExtractor ? 'ok' : 'pending'">
                    {{ item.syncedToExtractor ? '已同步' : '待同步' }}
                  </span>
                </td>
                <td class="row-actions">
                  <button class="link" type="button" :disabled="item.readonly" @click="doPublishContract(item.id)">发布并同步</button>
                </td>
              </tr>
              <tr v-if="!contracts.length"><td colspan="8" class="empty-state">暂无契约</td></tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>

    <!-- ④ 冲突仲裁 -->
    <div v-if="activeTab === 'conflict'" class="tab-panel">
      <div class="table-card">
        <h3>跨版本字段映射冲突（校验结果给出优先级，旧模板记录只读不覆盖）</h3>
        <table class="data-table">
          <thead>
            <tr><th>模板</th><th>字段</th><th>历史版本</th><th>新版本</th><th>优先版本</th><th>仲裁依据</th><th>状态</th></tr>
          </thead>
          <tbody>
            <tr v-for="item in conflicts" :key="item.id">
              <td>{{ item.templateCode }}</td>
              <td>{{ item.fieldName }}</td>
              <td>{{ item.versionA }}</td>
              <td>{{ item.versionB }}</td>
              <td><span class="badge current">{{ item.winnerVersion }}</span></td>
              <td class="cell-wrap">{{ item.reason }}</td>
              <td><span class="badge ok">{{ item.resolved ? '已仲裁（保留旧记录）' : '待处理' }}</span></td>
            </tr>
            <tr v-if="!conflicts.length">
              <td colspan="7" class="empty-state">暂无冲突；发布一个与历史契约版本不同的新版本后将自动登记冲突仲裁</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- ⑤ 存量迁移与历史回填 -->
    <div v-if="activeTab === 'migration'" class="tab-panel">
      <div class="panel-grid">
        <form class="form-card" @submit.prevent="submitMigration">
          <h3>存量网页模板迁移</h3>
          <p class="form-hint">旧模板先在本地开发环境兼容构建，再作为字段映射契约依赖上线；回填保留原入口地址与映射依据。</p>
          <label><span>存量模板编号</span><input v-model="migrationForm.templateCode" placeholder="如 TEMP-0001" /></label>
          <label><span>原入口地址（迁移后保留）</span><input v-model="migrationForm.originEntryUrl" placeholder="https://..." /></label>
          <label><span>原字段映射依据</span><input v-model="migrationForm.originExtractorCode" placeholder="如 EXTR-0003" /></label>
          <button class="btn primary" type="submit">本地开发环境兼容构建</button>
        </form>

        <div class="table-card">
          <h3>迁移任务与回填记录</h3>
          <table class="data-table">
            <thead>
              <tr><th>#</th><th>模板</th><th>原入口地址</th><th>原映射依据</th><th>阶段</th><th>差异/回填说明</th></tr>
            </thead>
            <tbody>
              <tr v-for="task in migrations" :key="task.id">
                <td>{{ task.id }}</td>
                <td>{{ task.templateCode }}</td>
                <td class="cell-wrap">{{ task.originEntryUrl }}</td>
                <td>{{ task.originExtractorCode }}</td>
                <td><span class="badge pending">{{ task.stage }}</span></td>
                <td class="cell-wrap">{{ task.diffNote }}</td>
              </tr>
              <tr v-if="!migrations.length"><td colspan="6" class="empty-state">暂无迁移任务</td></tr>
            </tbody>
          </table>
          <p class="form-hint" style="margin-top: 8px">
            建立任务后点「完成迁移回填」，将自动回填版本、跑兼容校验（差异记为可迁移）并推进到上线部署。
          </p>
          <button
            v-for="task in unfinishedMigrations"
            :key="task.id"
            class="btn"
            type="button"
            style="margin: 6px 6px 0 0"
            @click="doCompleteMigration(task.id)"
          >
            完成迁移回填 #{{ task.id }}
          </button>
        </div>
      </div>
    </div>

    <!-- ⑥ 解析结果：展示使用的契约 -->
    <div v-if="activeTab === 'parse'" class="tab-panel">
      <div class="panel-grid">
        <form class="form-card" @submit.prevent="submitParse">
          <h3>按契约执行解析</h3>
          <p class="form-hint">解析只引用已发布契约；没有契约的模板直接拒绝解析。</p>
          <label>
            <span>抽取模板</span>
            <select v-model="parseForm.templateCode">
              <option v-for="code in parseableTemplates" :key="code" :value="code">{{ code }}</option>
            </select>
          </label>
          <label><span>原始内容</span><textarea v-model="parseForm.rawValue" rows="3" placeholder="<h1>示例</h1>"></textarea></label>
          <button class="btn primary" type="submit">执行解析</button>
        </form>

        <div class="table-card">
          <h3>解析结果（明确显示使用的契约）</h3>
          <table class="data-table">
            <thead>
              <tr><th>模板</th><th>使用契约</th><th>契约版本</th><th>源→目标字段</th><th>原始值</th><th>解析值</th><th>时间</th></tr>
            </thead>
            <tbody>
              <tr v-for="sample in parseSamples" :key="sample.id">
                <td>{{ sample.templateCode }}</td>
                <td><span class="badge current">{{ sample.contractNo ?? '无契约' }}</span></td>
                <td>{{ sample.templateVersion }}</td>
                <td>{{ sample.sourceField }} → {{ sample.targetField }}</td>
                <td class="cell-wrap">{{ sample.rawValue }}</td>
                <td class="cell-wrap">{{ sample.parsedValue }}</td>
                <td>{{ sample.parsedAt }}</td>
              </tr>
              <tr v-if="!parseSamples.length"><td colspan="7" class="empty-state">暂无解析结果</td></tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'

import { resetContractState } from '@/domain/contract/store'
import {
  bindFieldContract,
  completeMigration,
  createMigrationTask,
  listConflicts,
  listContracts,
  listMigrations,
  listParseSamples,
  listTransactions,
  listValidations,
  listVersions,
  publishContract,
  publishTemplateVersion,
  registerTemplateVersion,
  runParse,
  validateTemplateVersion,
} from '@/domain/contract/service'
import type {
  FieldContract,
  MappingConflict,
  MigrationTask,
  ParseSample,
  PublishTransaction,
  TemplateVersion,
  ValidationRecord,
} from '@/domain/contract/types'

const tabs = [
  { key: 'version', label: '① 模板版本与兼容校验' },
  { key: 'tx', label: '② 发布事务/并发回滚' },
  { key: 'contract', label: '③ 字段映射契约' },
  { key: 'conflict', label: '④ 冲突仲裁' },
  { key: 'migration', label: '⑤ 存量迁移回填' },
  { key: 'parse', label: '⑥ 解析结果引用契约' },
] as const

const activeTab = ref<(typeof tabs)[number]['key']>('version')
const message = ref('')
const messageOk = ref(true)

const versions = ref<TemplateVersion[]>([])
const validations = ref<ValidationRecord[]>([])
const contracts = ref<FieldContract[]>([])
const conflicts = ref<MappingConflict[]>([])
const transactions = ref<PublishTransaction[]>([])
const migrations = ref<MigrationTask[]>([])
const parseSamples = ref<ParseSample[]>([])

const newVersion = reactive({
  templateCode: 'TEMP-0001',
  entryUrl: 'https://example.com/news/list-v3',
  listSelector: 'section.feed .news-item',
  detailSelector: 'article h1.title',
  paginationRule: 'cursor={token}',
  dataFormat: 'HTML',
})

const bindForm = reactive({ extractorCode: 'EXTR-0001', sourceField: 'title', targetField: '资讯标题', templateVersionId: 0 })
const migrationForm = reactive({ templateCode: 'TEMP-0001', originEntryUrl: 'https://example.com/news/list', originExtractorCode: 'EXTR-0003' })
const parseForm = reactive({ templateCode: 'TEMP-0001', rawValue: '<h1>契约化解析示例</h1>' })

function notify(ok: boolean, text: string) {
  messageOk.value = ok
  message.value = text
}

function reload() {
  versions.value = listVersions()
  validations.value = listValidations()
  contracts.value = listContracts()
  conflicts.value = listConflicts()
  transactions.value = listTransactions()
  migrations.value = listMigrations()
  parseSamples.value = listParseSamples()
  if (bindForm.templateVersionId === 0 && bindableVersions.value.length) {
    bindForm.templateVersionId = bindableVersions.value[0].id
  }
}

const statCards = computed(() => [
  { label: '模板版本总数', value: versions.value.length },
  { label: '当前生效版本', value: versions.value.filter((item) => item.current).length },
  { label: '已发布契约', value: contracts.value.filter((item) => item.status === '已发布').length },
  { label: '校验通过版本', value: versions.value.filter((item) => ['已通过', '已发布'].includes(item.status)).length },
  { label: '冲突仲裁记录', value: conflicts.value.length },
])

const bindableVersions = computed(() =>
  versions.value.filter((item) => item.status === '已通过' || item.status === '已发布'),
)
const unfinishedMigrations = computed(() => migrations.value.filter((item) => item.stage !== '已完成'))
const parseableTemplates = computed(() => [
  ...new Set(contracts.value.filter((item) => item.status === '已发布').map((item) => item.templateCode)),
])

function canPublish(item: TemplateVersion): boolean {
  return !item.readonly && item.status === '已通过'
}

function statusClass(status: string): string {
  if (['已发布', '已启用', '已通过'].includes(status)) return 'ok'
  if (status === '校验未通过') return 'fail'
  return 'pending'
}
function diffClass(level: string): string {
  if (level === '一致') return 'ok'
  if (level === '可迁移') return 'pending'
  return 'fail'
}
function txClass(state: string): string {
  if (state === '已提交') return 'ok'
  if (state === '已回滚') return 'fail'
  return 'pending'
}

function submitNewVersion() {
  const result = registerTemplateVersion({ ...newVersion })
  notify(result.ok, result.message)
  if (result.ok) reload()
}

function doValidate(id: number) {
  const result = validateTemplateVersion(id)
  notify(result.ok, result.message)
  reload()
}

function doPublish(id: number, failOnCommit: boolean) {
  const result = publishTemplateVersion(id, failOnCommit)
  notify(result.ok, result.message)
  reload()
}

function submitBind() {
  if (!bindForm.templateVersionId) {
    notify(false, '请先选择一个已通过校验的模板版本。')
    return
  }
  const result = bindFieldContract({ ...bindForm })
  notify(result.ok, result.message)
  if (result.ok) reload()
}

function doPublishContract(id: number) {
  const result = publishContract(id)
  notify(result.ok, result.message)
  reload()
}

function submitMigration() {
  const result = createMigrationTask(
    migrationForm.templateCode,
    migrationForm.originEntryUrl,
    migrationForm.originExtractorCode,
  )
  notify(result.ok, result.message)
  if (result.ok) reload()
}

function doCompleteMigration(id: number) {
  const result = completeMigration(id)
  notify(result.ok, result.message)
  reload()
}

function submitParse() {
  const result = runParse(parseForm.templateCode, parseForm.rawValue)
  notify(result.ok, result.message)
  if (result.ok) reload()
}

function resetAll() {
  resetContractState()
  reload()
  notify(true, '领域演示数据已重置为初始种子。')
}

onMounted(reload)
</script>

<style scoped>
.tab-bar { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 12px; }
.tab-btn { border: 1px solid var(--border); background: #fff; border-radius: 6px 6px 0 0; padding: 7px 12px; cursor: pointer; font-size: 13px; }
.tab-btn.active { background: var(--brand); border-color: var(--brand); color: #fff; }
.notice { border-radius: 6px; padding: 8px 12px; font-size: 13px; margin: 0 0 12px; }
.notice.ok { background: #ecfdf3; color: #027a48; border: 1px solid #abefc6; }
.notice.err { background: #fef3f2; color: #b42318; border: 1px solid #fda29b; }
.panel-grid { display: grid; grid-template-columns: 320px 1fr; gap: 14px; align-items: start; }
.form-card, .table-card { background: #fff; border: 1px solid var(--border); border-radius: 8px; padding: 14px; }
.form-card h3, .table-card h3 { margin: 0 0 8px; font-size: 14px; }
.form-card label { display: block; margin-bottom: 10px; }
.form-card label span { display: block; font-size: 12px; color: var(--muted); margin-bottom: 3px; }
.form-card input, .form-card select, .form-card textarea {
  width: 100%; border: 1px solid var(--border); border-radius: 6px; padding: 6px 8px; font-size: 13px;
}
.form-hint { font-size: 12px; color: var(--muted); margin: 0 0 10px; }
.badge { display: inline-block; border-radius: 999px; padding: 2px 9px; font-size: 12px; background: #eef2f7; color: #475569; white-space: nowrap; }
.badge.ok { background: #ecfdf3; color: #027a48; }
.badge.fail { background: #fef3f2; color: #b42318; }
.badge.pending { background: #fffaeb; color: #b54708; }
.badge.current { background: #eff4ff; color: #1d4ed8; }
.cell-wrap { max-width: 240px; word-break: break-all; }
.check-list { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 4px; }
.check-list li { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; font-size: 12px; }
.check-list em { font-style: normal; color: var(--muted); }
.muted { color: var(--muted); }
.link:disabled { color: #94a3b8; cursor: not-allowed; }
.link.danger { color: #b42318; }
</style>
