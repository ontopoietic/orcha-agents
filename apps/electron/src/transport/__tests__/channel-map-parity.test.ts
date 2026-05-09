import { describe, it, expect } from 'bun:test'
import type { ElectronAPI } from '../../shared/types'
import { CHANNEL_MAP } from '../channel-map'

type AnyFn = (...args: any[]) => any

type FunctionKeys<T> = {
  [K in keyof T]-?: Extract<T[K], AnyFn> extends never ? never : K
}[keyof T] & string

type BrowserPaneKeys = `browserPane.${FunctionKeys<ElectronAPI['browserPane']>}`

// Methods excluded from CHANNEL_MAP because they are implemented directly in the preload
// (no IPC round-trip to the main process). Each reads local state or orchestrates client-side.
//
// Note: browserPane is a nested namespace on ElectronAPI but its methods appear flattened
// as `browserPane.X` in CHANNEL_MAP. We add BrowserPaneKeys to the expected-in-map set
// rather than excluding them, so the parity check covers the dotted entries.
type ApiToChannelMapKeys =
  | BrowserPaneKeys
  | Exclude<
  FunctionKeys<ElectronAPI>,
  | 'performOAuth'
  | 'getTransportConnectionState'
  | 'getRuntimeEnvironment'
  | 'onTransportConnectionStateChanged'
  | 'reconnectTransport'
  | 'isChannelAvailable'
  | 'getSystemWarnings' // reads env var set at startup — no IPC needed
  | 'relaunchApp' // direct IPC to main process — not through WS RPC
  | 'removeWorkspace' // direct IPC to main process — modifies local config
  | 'invokeOnServer' // direct IPC to main process — cross-server RPC
| 'transferSessionToWorkspace' // direct IPC to main process — orchestrated remote transfer
  | 'onTransferProgress' // direct IPC listener — chunk upload progress
  | 'changeLanguage' // direct IPC to main process — syncs i18n language
  | 'getFilePath' // renderer-local — webUtils.getPathForFile, no IPC round-trip
  | 'ledgerWatch' // direct IPC — ledger watcher
  | 'ledgerUnwatch' // direct IPC — ledger watcher
  | 'ledgerRead' // direct IPC — ledger reader
  | 'ledgerHistory' // direct IPC — sync history reader
  | 'onLedgerActivity' // direct IPC listener — ledger activity events
  | 'listAnchorables' // direct IPC — orcha CLI bridge for anchor picker
  | 'clearAnchorablesCache' // direct IPC — orcha CLI bridge cache invalidation
  | 'observationWatch' // direct IPC — observation file watcher
  | 'observationUnwatch' // direct IPC — observation file watcher
  | 'observationRead' // direct IPC — observation watermark reader
  | 'observationReadList' // direct IPC — observation list reader
  | 'observationRunNow' // direct IPC — manual observer trigger
  | 'observationRewriteEchoes' // direct IPC — echo rewriter trigger
  | 'observationReflectNow' // direct IPC — manual L2 reflector trigger
  | 'onObservationStatus' // direct IPC listener — observation watermark events
>
type ChannelMapKeys = keyof typeof CHANNEL_MAP & string

type AssertNever<T extends never> = true

// Compile-time guardrails: if these fail, CHANNEL_MAP and ElectronAPI drifted.
const _missingFromMap: AssertNever<Exclude<ApiToChannelMapKeys, ChannelMapKeys>> = true
const _extraInMap: AssertNever<Exclude<ChannelMapKeys, ApiToChannelMapKeys>> = true

void _missingFromMap
void _extraInMap

describe('CHANNEL_MAP runtime contract', () => {
  it('has valid entry kinds and channels', () => {
    for (const [method, entry] of Object.entries(CHANNEL_MAP)) {
      expect(typeof method).toBe('string')
      expect(entry.type === 'invoke' || entry.type === 'listener').toBe(true)
      expect(typeof entry.channel).toBe('string')
      expect(entry.channel.length).toBeGreaterThan(0)

      if (entry.type === 'listener') {
        expect((entry as any).transform).toBeUndefined()
      }
    }
  })

  it('contains at least one listener and one invoke entry', () => {
    const values = Object.values(CHANNEL_MAP)
    expect(values.some((entry) => entry.type === 'listener')).toBe(true)
    expect(values.some((entry) => entry.type === 'invoke')).toBe(true)
  })
})
