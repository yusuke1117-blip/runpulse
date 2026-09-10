export const GPS_MAX_ACCURACY_METERS = 75
export const GPS_MAX_SPEED_METERS_PER_SECOND = 12
export const GPS_MIN_MOVEMENT_METERS = 8

export function elapsedMsAt(timer, nowMs) {
  if (!timer || !Number.isFinite(nowMs)) {
    return 0
  }

  const runningMs = timer.resumedAtMs === null
    ? 0
    : Math.max(0, nowMs - timer.resumedAtMs)

  return Math.max(0, timer.accumulatedRunningMs + runningMs)
}

export function pauseTimer(timer, nowMs) {
  return {
    ...timer,
    accumulatedRunningMs: elapsedMsAt(timer, nowMs),
    pausedAtMs: nowMs,
    resumedAtMs: null,
  }
}

export function resumeTimer(timer, nowMs) {
  return {
    ...timer,
    resumedAtMs: nowMs,
    pausedAtMs: null,
  }
}

export function calculateDistanceMeters(first, second) {
  const toRadians = (value) => (value * Math.PI) / 180
  const earthRadius = 6371000
  const latitudeDelta = toRadians(second.latitude - first.latitude)
  const longitudeDelta = toRadians(second.longitude - first.longitude)
  const latitude1 = toRadians(first.latitude)
  const latitude2 = toRadians(second.latitude)
  const area = Math.sin(latitudeDelta / 2) ** 2
    + Math.cos(latitude1) * Math.cos(latitude2) * Math.sin(longitudeDelta / 2) ** 2

  return 2 * earthRadius * Math.atan2(Math.sqrt(area), Math.sqrt(1 - area))
}

export function acceptGpsPoint(previous, next) {
  if (!next || !Number.isFinite(next.latitude) || !Number.isFinite(next.longitude)) {
    return { accepted: false, reason: 'invalid' }
  }

  if (!Number.isFinite(next.accuracy) || next.accuracy > GPS_MAX_ACCURACY_METERS) {
    return { accepted: false, reason: 'accuracy' }
  }

  if (!previous) {
    return { accepted: true, distanceMeters: 0, speedMetersPerSecond: 0 }
  }

  const intervalMs = Number.isFinite(next.elapsedMs) && Number.isFinite(previous.elapsedMs)
    ? next.elapsedMs - previous.elapsedMs
    : next.timestamp - previous.timestamp
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    return { accepted: false, reason: 'timestamp' }
  }

  const distanceMeters = calculateDistanceMeters(previous, next)
  const speedMetersPerSecond = distanceMeters / (intervalMs / 1000)
  // 75m allows ordinary phone fixes while rejecting the large uncertainty that makes a track unusable.
  // The 8m floor suppresses stationary GPS jitter without rejecting normal running movement.
  const movementFloor = Math.max(GPS_MIN_MOVEMENT_METERS, Math.min(30, next.accuracy * 0.35))

  if (!Number.isFinite(distanceMeters) || distanceMeters < movementFloor) {
    return { accepted: false, reason: 'stationary' }
  }

  if (speedMetersPerSecond > GPS_MAX_SPEED_METERS_PER_SECOND) {
    return { accepted: false, reason: 'jump' }
  }

  return { accepted: true, distanceMeters, speedMetersPerSecond }
}

export function appendGpsPoint(state, point) {
  const result = acceptGpsPoint(state.points.at(-1) ?? null, point)
  if (!result.accepted) {
    return { state, result }
  }

  const previousDistance = state.points.at(-1)?.cumulativeDistanceMeters ?? 0
  const cumulativeDistanceMeters = previousDistance + result.distanceMeters
  const nextPoint = { ...point, cumulativeDistanceMeters }
  const splits = [...state.splits]
  const previousPoint = state.points.at(-1)

  if (previousPoint) {
    let nextBoundary = (splits.length + 1) * 1000
    while (nextBoundary <= cumulativeDistanceMeters) {
      const distanceDelta = cumulativeDistanceMeters - previousDistance
      const ratio = distanceDelta > 0
        ? (nextBoundary - previousDistance) / distanceDelta
        : 0
      const crossingElapsedMs = previousPoint.elapsedMs
        + (point.elapsedMs - previousPoint.elapsedMs) * Math.min(1, Math.max(0, ratio))
      const previousBoundaryElapsedMs = splits.at(-1)?.elapsedMs ?? 0
      splits.push({
        kilometer: splits.length + 1,
        elapsedMs: crossingElapsedMs,
        durationMs: crossingElapsedMs - previousBoundaryElapsedMs,
      })
      nextBoundary = (splits.length + 1) * 1000
    }
  }

  return {
    state: { points: [...state.points, nextPoint], splits },
    result: { ...result, cumulativeDistanceMeters },
  }
}

export function calculateAveragePaceSeconds(elapsedRunningMs, distanceMeters) {
  if (!Number.isFinite(elapsedRunningMs) || !Number.isFinite(distanceMeters) || distanceMeters <= 0) {
    return null
  }

  return (elapsedRunningMs / 1000) / (distanceMeters / 1000)
}

export function calculateRollingPaceSeconds(points, windowMs = 45000) {
  if (!points || points.length < 2) {
    return null
  }

  const latest = points.at(-1)
  const cutoff = latest.elapsedMs - windowMs
  const first = points.find((point) => point.elapsedMs >= cutoff)
  if (!first || first === latest) {
    return null
  }

  const elapsedMs = latest.elapsedMs - first.elapsedMs
  const distanceMeters = latest.cumulativeDistanceMeters - first.cumulativeDistanceMeters
  if (elapsedMs < 10000 || distanceMeters < 20) {
    return null
  }

  return Math.max(120, Math.min(1200, (elapsedMs / 1000) / (distanceMeters / 1000)))
}

export function formatSplitRows(splits, distanceMeters, elapsedRunningMs) {
  const rows = splits.map((split) => ({
    label: `${split.kilometer}km`,
    pace: formatSeconds(split.durationMs / 1000),
    distanceMeters: 1000,
  }))
  const lastCompletedDistance = splits.length * 1000
  const remainingMeters = distanceMeters - lastCompletedDistance

  if (remainingMeters >= 1) {
    const lastCompletedElapsedMs = splits.at(-1)?.elapsedMs ?? 0
    rows.push({
      label: `最終区間 ${(remainingMeters / 1000).toFixed(1)}km`,
      pace: formatSeconds((elapsedRunningMs - lastCompletedElapsedMs) / 1000),
      distanceMeters: remainingMeters,
      durationMs: elapsedRunningMs - lastCompletedElapsedMs,
      isFinal: true,
    })
  }

  return rows
}

function formatSeconds(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return '—'
  return `${Math.floor(seconds / 60)}:${String(Math.round(seconds % 60)).padStart(2, '0')}`
}
