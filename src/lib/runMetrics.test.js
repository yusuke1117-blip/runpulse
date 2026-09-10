import { describe, expect, it } from 'vitest'
import {
  appendGpsPoint,
  calculateAveragePaceSeconds,
  calculateRollingPaceSeconds,
  elapsedMsAt,
  formatSplitRows,
  pauseTimer,
  resumeTimer,
} from './runMetrics'

const timer = { startedAtMs: 0, resumedAtMs: 0, accumulatedRunningMs: 0, pausedAtMs: null }

const point = (latitude, timestamp, elapsedMs, accuracy = 5) => ({
  latitude,
  longitude: 0,
  accuracy,
  timestamp,
  elapsedMs,
})

describe('run timing', () => {
  it('uses wall-clock time and excludes pauses across repeated resumes', () => {
    expect(elapsedMsAt(timer, 60000)).toBe(60000)
    const paused = pauseTimer(timer, 60000)
    expect(elapsedMsAt(paused, 120000)).toBe(60000)
    const resumed = resumeTimer(paused, 120000)
    expect(elapsedMsAt(resumed, 180000)).toBe(120000)
    const pausedAgain = pauseTimer(resumed, 240000)
    expect(elapsedMsAt(pausedAgain, 300000)).toBe(180000)
  })
})

describe('GPS measurement', () => {
  it('keeps the stopwatch independent when there are no GPS points', () => {
    expect(calculateAveragePaceSeconds(60000, 0)).toBeNull()
  })

  it('rejects bad accuracy, reversed timestamps, jumps, and stationary jitter', () => {
    let state = { points: [], splits: [] }
    state = appendGpsPoint(state, point(35, 0, 0)).state
    expect(appendGpsPoint(state, point(35.00001, 1000, 1000, 100)).result.accepted).toBe(false)
    expect(appendGpsPoint(state, point(35.0002, -1000, 0)).result.accepted).toBe(false)
    expect(appendGpsPoint(state, point(35.001, 1000, 1000)).result.accepted).toBe(false)
    expect(appendGpsPoint(state, point(35.00001, 1000, 1000)).result.accepted).toBe(false)
  })

  it('interpolates real 1km crossings and leaves a measured final section', () => {
    let state = { points: [], splits: [] }
    state = appendGpsPoint(state, point(35, 0, 0)).state
    state = appendGpsPoint(state, point(35.00899, 300000, 300000)).state
    state = appendGpsPoint(state, point(35.018, 630000, 630000)).state
    expect(state.splits).toHaveLength(2)
    expect(state.splits[0].durationMs).toBeGreaterThan(300000)
    expect(state.splits[0].durationMs).toBeLessThan(320000)
    expect(state.splits[1].durationMs).toBeGreaterThan(300000)
    const rows = formatSplitRows(state.splits, state.points.at(-1).cumulativeDistanceMeters, 630000)
    expect(rows.slice(0, 2).map((row) => row.label)).toEqual(['1km', '2km'])
    expect(rows.at(-1).label).toMatch(/^最終区間 \d+\.\dkm$/)
    expect(rows.at(-1).distanceMeters).toBeGreaterThan(0)
    expect(rows.at(-1).durationMs).toBeGreaterThan(0)
  })

  it('calculates average and rolling pace only from measured distance', () => {
    expect(calculateAveragePaceSeconds(300000, 1000)).toBe(300)
    const points = [point(35, 0, 0), point(35.00045, 15000, 15000), point(35.001, 30000, 30000)]
      .map((item, index) => ({ ...item, cumulativeDistanceMeters: index === 0 ? 0 : index === 1 ? 50 : 111 }))
    expect(calculateRollingPaceSeconds(points)).toBeGreaterThan(200)
  })
})
