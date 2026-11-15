// 领域逻辑验证：用内存版 localStorage 垫片驱动 service.ts，覆盖模板版本校验→发布→契约→解析调用链。
// 运行：node scripts/verify-contract.mjs
import { build } from 'esbuild'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import { tmpdir } from 'node:os'

const mem = new Map()
globalThis.window = {
  localStorage: {
    getItem: (k) => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => mem.set(k, String(v)),
    removeItem: (k) => mem.delete(k),
  },
}

const out = resolve(tmpdir(), 'contract-service.bundle.mjs')
await build({
  entryPoints: [resolve('src/domain/contract/service.ts')],
  bundle: true,
  format: 'esm',
  platform: 'node',
  outfile: out,
  alias: { '@': resolve('src') },
  logLevel: 'silent',
})

const svc = await import(pathToFileURL(out).href)

let pass = 0
let fail = 0
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  ✅ ${name}`) }
  else { fail++; console.log(`  ❌ ${name} ${extra}`) }
}

console.log('① 兼容校验：改版 v1.1.0 三项规则全变，应判不兼容且禁止发布')
const r1 = svc.validateTemplateVersion(2)
check('v1.1.0 校验未通过', r1.ok === false)
check('记录 3 项不兼容差异', r1.data.checks.every((c) => c.level === '不兼容') && r1.data.checks.length === 3)
check('未通过版本禁止发布', svc.publishTemplateVersion(2).ok === false)

console.log('② 登记新版本（不改写只读历史版本）')
const before = svc.listVersions('TEMP-0001').length
const r2 = svc.registerTemplateVersion({
  templateCode: 'TEMP-0001',
  entryUrl: 'https://example.com/news/list-v3',
  listSelector: 'section.feed .news-item',
  paginationRule: 'cursor={token}',
})
check('新版本登记成功', r2.ok === true)
check('历史版本数量只增不改', svc.listVersions('TEMP-0001').length === before + 1)
const v1 = svc.listVersions('TEMP-0001').find((v) => v.id === 1)
check('v1.0.0 历史版本仍只读且仍为当前', v1.readonly === true && v1.current === true)
check('对只读版本重复校验被拒', svc.validateTemplateVersion(1).ok === false)

console.log('③ 存量迁移回填：保留原入口地址，差异记为可迁移，校验通过并发布')
const legacyUrl = 'https://example.com/news/legacy-list'
const m = svc.createMigrationTask('TEMP-0001', legacyUrl, 'EXTR-0003')
check('迁移任务建立并进入本地开发环境构建', m.ok && m.data.stage === '本地开发环境构建')
const mc = svc.completeMigration(m.data.id)
check('回填版本保留原入口地址', mc.ok && mc.data.version.entryUrl === legacyUrl)
check('回填版本带迁移依据标记', mc.data.version.migratedFrom.includes('EXTR-0003'))
const mv = svc.listValidations(mc.data.version.id).slice(-1)[0]
check('迁移差异按可迁移处理且校验通过', mv.passed === true && mv.checks.some((c) => c.level === '可迁移'))
const pub = svc.publishTemplateVersion(mc.data.version.id)
check('迁移版本发布成功', pub.ok === true)
const after = svc.listVersions('TEMP-0001')
check('同一模板仅一个当前版本', after.filter((v) => v.current).length === 1)
check('新版本为当前且只读', after.find((v) => v.id === mc.data.version.id).current === true)
const v1After = svc.listVersions('TEMP-0001').find((v) => v.id === 1)
check('旧当前版本让出 current 但保持只读', v1After.current === false && v1After.readonly === true)
check('冲突已登记且优先已发布新版本', svc.listConflicts('TEMP-0001').some((c) => c.winnerVersion === mc.data.version.version && c.resolved))
check('事务无残留进行中锁', svc.listTransactions().every((t) => t.state !== '进行中'))

console.log('④ 事务提交异常：恢复上一版本并保留差异记录')
// 与 TEMP-0002 基线（id=3）三项规则一致，保证兼容校验通过，进而走到发布事务环节。
const reg = svc.registerTemplateVersion({
  templateCode: 'TEMP-0002',
  entryUrl: 'https://example.org/shop/items',
  listSelector: 'ul.goods li.item',
  paginationRule: 'pn={n}',
})
const vReg = svc.validateTemplateVersion(reg.data.id)
check('回滚用版本兼容校验通过', vReg.ok === true)
const rollback = svc.publishTemplateVersion(reg.data.id, true)
check('模拟提交异常返回回滚', rollback.ok === false && rollback.data && rollback.data.state === '已回滚')
check('TEMP-0002 仍无当前版本（恢复上一版本=无）', !svc.listVersions('TEMP-0002').some((v) => v.current))
check('事务保留回滚差异说明', svc.listTransactions().some((t) => t.state === '已回滚' && t.message.includes('恢复上一当前版本')))
const repub = svc.publishTemplateVersion(reg.data.id, false)
check('回滚后可重新发布', repub.ok === true)
check('重新发布后成为唯一当前版本', svc.listVersions('TEMP-0002').filter((v) => v.current).length === 1)

console.log('⑤ 串行发布不变量：只允许一个当前版本，历史版本只读不可重复发布')
const a = svc.registerTemplateVersion({ templateCode: 'TEMP-0003', entryUrl: 'u1', listSelector: 's1', paginationRule: 'p1' })
svc.validateTemplateVersion(a.data.id)
check('首个版本发布成功', svc.publishTemplateVersion(a.data.id, false).ok === true)
check('同模板只保留一个当前版本', svc.listVersions('TEMP-0003').filter((v) => v.current).length === 1)
const publishedA = svc.listVersions('TEMP-0003').find((v) => v.id === a.data.id)
check('发布后版本转只读', publishedA.readonly === true && publishedA.status === '已发布')
check('只读历史版本不可重复发布（并发兜底）', svc.publishTemplateVersion(a.data.id, false).ok === false)
const c = svc.registerTemplateVersion({ templateCode: 'TEMP-0004', entryUrl: 'w1', listSelector: 'x1', paginationRule: 'y1' })
svc.validateTemplateVersion(c.data.id)
check('另一模板可独立发布且互不影响当前版本', svc.publishTemplateVersion(c.data.id, false).ok === true)
check('两个模板各自仅一个当前版本', svc.listVersions('TEMP-0003').filter((v) => v.current).length === 1 && svc.listVersions('TEMP-0004').filter((v) => v.current).length === 1)

console.log('⑥ 字段映射契约：必须绑定已通过校验版本，发布同步字段映射清单')
const bad = svc.bindFieldContract({ extractorCode: 'EXTR-0002', sourceField: 'x', targetField: 'y', templateVersionId: 2 })
check('绑定未通过版本被拒', bad.ok === false)
const target = svc.listVersions('TEMP-0002').find((v) => v.current)
const good = svc.bindFieldContract({ extractorCode: 'EXTR-0001', sourceField: 'title', targetField: '资讯标题', templateVersionId: target.id })
check('绑定已发布版本成功', good.ok === true && good.data.status === '待发布')
const pc = svc.publishContract(good.data.id)
check('契约发布成功并标记同步', pc.ok === true && pc.data.syncedToExtractor === true)
const entries = JSON.parse(mem.get('scraper-config-studio:entries'))
const synced = entries.extractor.find((row) => row['规则编号'] === 'EXTR-0001')
check('发布结果回写字段映射清单', synced['契约编号'] === good.data.contractNo && synced['契约状态'] === '已发布' && synced['绑定模板版本'] === `TEMP-0002@${target.version}`)
check('只读契约不可重复发布', svc.publishContract(good.data.id).ok === false)
check('清单里未绑定契约的规则仍保持原状态', entries.extractor.find((row) => row['规则编号'] === 'EXTR-0002')['契约状态'] === undefined)

console.log('⑦ 解析结果必须显示使用的契约')
const p1 = svc.runParse('TEMP-0002', '<h1>契约解析</h1>')
check('按已发布契约解析成功', p1.ok && p1.data.contractNo === good.data.contractNo && p1.data.parsedValue === '契约解析')
check('无契约模板拒绝解析', svc.runParse('TEMP-9999', 'x').ok === false)
check('解析样本记录契约版本', svc.listParseSamples().some((s) => s.templateVersion === target.version && s.contractNo))

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)
