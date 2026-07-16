import { describe, it, expect, beforeEach, vi } from 'vitest'

// ---- node-pty mock: capture onData/onExit callbacks + writes ----
interface FakePty {
  pid: number
  written: string[]
  emitData: (d: string) => void
  emitExit: (code: number) => void
}

const spawned: FakePty[] = []

vi.mock('node-pty', () => ({
  spawn: () => {
    let dataCb: (d: string) => void = () => {}
    let exitCb: (e: { exitCode: number }) => void = () => {}
    const fake: FakePty = {
      pid: 1000 + spawned.length,
      written: [],
      emitData: (d) => dataCb(d),
      emitExit: (code) => exitCb({ exitCode: code })
    }
    spawned.push(fake)
    return {
      pid: fake.pid,
      onData: (cb: (d: string) => void) => { dataCb = cb },
      onExit: (cb: (e: { exitCode: number }) => void) => { exitCb = cb },
      write: (d: string) => fake.written.push(d),
      resize: () => {},
      kill: () => {}
    }
  }
}))

import { PtyManager } from './PtyManager'
import type { CreateTerminalInput } from '../../shared/types'
import { IPC } from '../../shared/types'

function input(): CreateTerminalInput {
  return { workspaceId: 'w', name: 'n', kind: 'cmd' }
}

interface SentMsg { channel: string; payload: any }

function fakeSender() {
  const sent: SentMsg[] = []
  return {
    sent,
    wc: { send: (channel: string, payload: any) => sent.push({ channel, payload }) } as any
  }
}

beforeEach(() => {
  spawned.length = 0
})

describe('PtyManager ring buffer', () => {
  it('drops oldest chunks past scrollback limit', () => {
    const { wc } = fakeSender()
    const mgr = new PtyManager(() => wc)
    mgr.setScrollback(3)
    mgr.create('t1', input())
    const p = spawned[0]
    for (let i = 0; i < 10; i++) p.emitData(`line${i}\n`)
    const buf = mgr.getBuffer('t1')
    // Only the last few chunks retained; earliest gone.
    expect(buf).not.toContain('line0')
    expect(buf).toContain('line9')
  })

  it('getBuffer joins retained chunks', () => {
    const { wc } = fakeSender()
    const mgr = new PtyManager(() => wc)
    mgr.create('t1', input())
    spawned[0].emitData('ab')
    spawned[0].emitData('cd')
    expect(mgr.getBuffer('t1')).toBe('abcd')
  })
})

describe('PtyManager render modes', () => {
  it('does not flush PTY_DATA while in buffer mode', () => {
    vi.useFakeTimers()
    const { wc, sent } = fakeSender()
    const mgr = new PtyManager(() => wc)
    mgr.create('t1', input())
    mgr.setMode('t1', 'buffer')
    spawned[0].emitData('hidden')
    vi.advanceTimersByTime(500)
    expect(sent.filter((m) => m.channel === IPC.PTY_DATA)).toHaveLength(0)
    vi.useRealTimers()
  })

  it('flushes PTY_DATA in active mode', () => {
    vi.useFakeTimers()
    const { wc, sent } = fakeSender()
    const mgr = new PtyManager(() => wc)
    mgr.create('t1', input())
    mgr.setMode('t1', 'active')
    spawned[0].emitData('visible')
    vi.advanceTimersByTime(50)
    const data = sent.filter((m) => m.channel === IPC.PTY_DATA)
    expect(data).toHaveLength(1)
    expect(data[0].payload.data).toBe('visible')
    vi.useRealTimers()
  })
})

describe('PtyManager continuous routing', () => {
  it('writes source data to target terminal', () => {
    const { wc } = fakeSender()
    const mgr = new PtyManager(() => wc)
    mgr.create('src', input())
    mgr.create('dst', input())
    const srcPty = spawned[0]
    const dstPty = spawned[1]
    mgr.setRouting('src', [{
      connectionId: 'c1',
      targetTerminalIds: ['dst'],
      triggerPattern: '.*',
      routeBehavior: 'continuous'
    }])
    srcPty.emitData('payload')
    expect(dstPty.written).toContain('payload')
  })

  it('drops rules with an uncompilable trigger pattern instead of throwing', () => {
    const { wc } = fakeSender()
    const mgr = new PtyManager(() => wc)
    mgr.create('src', input())
    mgr.create('dst', input())
    const srcPty = spawned[0]
    const dstPty = spawned[1]
    expect(() =>
      mgr.setRouting('src', [
        {
          connectionId: 'c1',
          targetTerminalIds: ['dst'],
          triggerPattern: '(unterminated',
          routeBehavior: 'marker'
        }
      ])
    ).not.toThrow()
    srcPty.emitData('payload')
    expect(dstPty.written).toHaveLength(0)
  })
})
