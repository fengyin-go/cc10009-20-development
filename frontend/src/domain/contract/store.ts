import { buildSeedState } from './seed'
import type { ContractState } from './types'

// 领域独立的 localStorage 键，与通用清单数据（scraper-config-studio:entries）隔离。
const STORAGE_KEY = 'scraper-config-studio:contract-state'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function readStorage(): ContractState {
  const fallback = buildSeedState()
  if (typeof window === 'undefined' || !window.localStorage) {
    return fallback
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
  try {
    return { ...fallback, ...(JSON.parse(raw) as ContractState) }
  } catch {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
}

let cache: ContractState | null = null

export function contractState(): ContractState {
  if (cache === null) {
    cache = readStorage()
  }
  return cache
}

/** 领域内所有写操作最终都经这里落盘，保证事务回滚后磁盘状态与内存一致。 */
export function persist(state: ContractState): ContractState {
  cache = state
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
  }
  return state
}

export function mutateState(mutator: (draft: ContractState) => void): ContractState {
  const next = clone(contractState())
  mutator(next)
  return persist(next)
}

export function nextId(state: ContractState, bucket: keyof ContractState['seq']): number {
  const value = state.seq[bucket] ?? 1
  state.seq[bucket] = value + 1
  return value
}

export function resetContractState(): ContractState {
  const fresh = buildSeedState()
  return persist(clone(fresh))
}

export function contractStorageKey(): string {
  return STORAGE_KEY
}
