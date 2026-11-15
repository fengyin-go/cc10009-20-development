<template>
  <section class="page" data-module="extractor">
    <header class="page-head">
      <div>
        <h2>字段映射管理</h2>
        <p class="page-desc">维护字段映射规则的输入、执行约束与结果记录，为字段映射提供可验证的数据工程流程。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记映射规则</button>
        <RouterLink class="btn" to="/contract">模板版本契约工作台</RouterLink>
        <button class="btn" type="button" @click="exportRows">导出字段映射清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>契约编号</th>
          <th>绑定模板版本</th>
          <th>契约状态</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
          <td>{{ row['契约编号'] ?? '—' }}</td>
          <td>{{ row['绑定模板版本'] ?? '未绑定' }}</td>
          <td>
            <span v-if="row['契约状态']" class="contract-badge">{{ row['契约状态'] }}</span>
            <span v-else class="muted">待发布契约</span>
          </td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button
              v-for="action in actions"
              :key="action"
              class="link"
              type="button"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 5" class="empty-state">暂无字段映射数据，可先登记映射规则</td>
        </tr>
      </tbody>
    </table>

    <p class="contract-tip">
      契约约束：字段映射启用前必须在「模板版本契约工作台」绑定一个已通过兼容校验的模板版本，发布结果会同步回写本清单，全平台仅保留一套契约版本。
    </p>

    <footer class="page-foot">
      <span>共 {{ total }} 条字段映射记录</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  downloadEntries,
  listEntries,
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('extractor')
const columns = ["规则编号", "源字段名称", "目标字段名称", "数据类型转换", "默认填充值", "清洗表达式", "必填标识", "唯一性校验"]
const actions = ["提交校验", "启用规则", "停用规则"]
const statuses = ["草稿", "待校验", "已启用", "已停用"]
const stats = [{"label": "映射规则总数", "value": 0}, {"label": "已启用规则", "value": 0}, {"label": "待校验规则", "value": 0}]

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '映射规则登记入口尚未接入审批流'
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  // 契约约束：启用映射规则前必须已绑定并发布一个通过校验的模板版本契约。
  if (action === '启用规则' && row['契约状态'] !== '已发布') {
    errorMessage.value = `映射规则 ${String(row['规则编号'])} 尚未绑定已通过校验的模板版本契约，请先到「模板版本契约工作台」完成绑定与发布。`
    return
  }
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  reload()
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '字段映射列表读取失败'
  }
}

onMounted(reload)
</script>

<style scoped>
.contract-badge {
  display: inline-block;
  border-radius: 999px;
  padding: 2px 9px;
  font-size: 12px;
  background: #ecfdf3;
  color: #027a48;
  white-space: nowrap;
}
.muted { color: var(--muted); }
.contract-tip {
  margin-top: 10px;
  font-size: 12px;
  color: #b54708;
  background: #fffaeb;
  border: 1px solid #fedf89;
  border-radius: 6px;
  padding: 8px 12px;
}
</style>
