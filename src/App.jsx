import { useEffect, useMemo, useRef, useState } from 'react'
import './App.css'
import { hasSupabaseConfig, supabase } from './lib/supabase'
import {
  appendGpsPoint,
  calculateAveragePaceSeconds,
  calculateRollingPaceSeconds,
  elapsedMsAt,
  formatSplitRows,
  pauseTimer,
  resumeTimer,
} from './lib/runMetrics'

const TARGETS = ['5km', '10km', 'ハーフ', 'フル', 'カスタム']
const DEFAULT_GOAL_PACE = '5:00'
const ACTIVITY_TYPES = [
  { value: 'running', label: 'ランニング', pace: [5, 0] },
  { value: 'walking', label: 'ウォーキング', pace: [10, 0] },
]
const INTRO_STEPS = [
  {
    title: '運動を記録する',
    description: 'スタートを押すだけで、運動時間と移動距離の計測を始めます。',
  },
  {
    title: 'ペースを確認する',
    description: 'ランニングやウォーキング中の現在ペースを、分かりやすく確認できます。',
  },
  {
    title: '結果を振り返る',
    description: '運動後に距離、時間、平均ペース、1kmごとの記録を確認できます。',
  },
]

const DEFAULT_SETTINGS = {
  goalPace: DEFAULT_GOAL_PACE,
  goalPaceMinutes: 5,
  goalPaceSeconds: 0,
  activityType: 'running',
  goalPaceCustomized: false,
  unit: 'km',
  audioOn: true,
  brightness: 'standard',
  goalPaceRunningMinutes: 5,
  goalPaceRunningSeconds: 0,
  goalPaceWalkingMinutes: 10,
  goalPaceWalkingSeconds: 0,
  runningAudioMode: 'interval',
  runningAudioIntervalMeters: 1000,
  runningAudioSound: 0,
  walkingAudioMode: 'interval',
  walkingAudioIntervalMeters: 1000,
  walkingAudioSound: 1,
}
const AUDIO_SOUNDS = ['ピッ', 'チャイム', 'ダブル', '高音', '低音', '上昇', '下降', 'ベル', '電子音', '短いビープ']

const LOCAL_SETTINGS_KEY = 'runpulse-local-settings'
const LOCAL_HISTORY_KEY = 'runpulse-local-history'
const LOCAL_INTRO_KEY = 'runpulse-intro-seen'
const LOCAL_RUN_STATE_KEY = 'runpulse-active-run'
const HISTORY_LIMIT = 100

function readLocalValue(key, fallback) {
  try {
    const value = window.localStorage.getItem(key)
    if (value === null) {
      return fallback
    }

    return JSON.parse(value)
  } catch {
    return fallback
  }
}

function writeLocalValue(key, value) {
  window.localStorage.setItem(key, JSON.stringify(value))
}

function readLocalSettings() {
  return normalizeSettings(readLocalValue(LOCAL_SETTINGS_KEY, DEFAULT_SETTINGS))
}

function normalizeSettings(value) {
  const rawSettings = value || {}
  const settings = { ...DEFAULT_SETTINGS, ...rawSettings }
  const [legacyMinutes, legacySeconds = '0'] = String(settings.goalPace || DEFAULT_GOAL_PACE).split(':')
  const minutes = Object.prototype.hasOwnProperty.call(rawSettings, 'goalPaceMinutes') && Number.isInteger(Number(settings.goalPaceMinutes))
    ? Number(settings.goalPaceMinutes)
    : Number(legacyMinutes)
  const seconds = Object.prototype.hasOwnProperty.call(rawSettings, 'goalPaceSeconds') && Number.isInteger(Number(settings.goalPaceSeconds))
    ? Number(settings.goalPaceSeconds)
    : Number(legacySeconds)
  const safeMinutes = Number.isFinite(minutes) && minutes >= 0 ? Math.floor(minutes) : 5
  const safeSeconds = Number.isFinite(seconds) && seconds >= 0 && seconds <= 59 ? Math.floor(seconds) : 0
  const activityType = value?.activityType === 'walking' ? 'walking' : 'running'
  const runningMinutes = Number.isFinite(Number(rawSettings.goalPaceRunningMinutes)) ? Number(rawSettings.goalPaceRunningMinutes) : safeMinutes
  const runningSeconds = Number.isFinite(Number(rawSettings.goalPaceRunningSeconds)) ? Number(rawSettings.goalPaceRunningSeconds) : safeSeconds
  const walkingMinutes = Number.isFinite(Number(rawSettings.goalPaceWalkingMinutes)) ? Number(rawSettings.goalPaceWalkingMinutes) : 10
  const walkingSeconds = Number.isFinite(Number(rawSettings.goalPaceWalkingSeconds)) ? Number(rawSettings.goalPaceWalkingSeconds) : 0
  const activeMinutes = activityType === 'walking' ? walkingMinutes : runningMinutes
  const activeSeconds = activityType === 'walking' ? walkingSeconds : runningSeconds
  return {
    ...settings,
    goalPace: `${activeMinutes}:${String(activeSeconds).padStart(2, '0')}`,
    goalPaceMinutes: activeMinutes,
    goalPaceSeconds: activeSeconds,
    goalPaceRunningMinutes: runningMinutes,
    goalPaceRunningSeconds: runningSeconds,
    goalPaceWalkingMinutes: walkingMinutes,
    goalPaceWalkingSeconds: walkingSeconds,
    runningAudioMode: rawSettings.runningAudioMode || 'interval',
    runningAudioIntervalMeters: Number(rawSettings.runningAudioIntervalMeters) >= 1 ? Number(rawSettings.runningAudioIntervalMeters) : 1000,
    runningAudioSound: Number.isInteger(Number(rawSettings.runningAudioSound)) ? Number(rawSettings.runningAudioSound) : 0,
    walkingAudioMode: rawSettings.walkingAudioMode || 'interval',
    walkingAudioIntervalMeters: Number(rawSettings.walkingAudioIntervalMeters) >= 1 ? Number(rawSettings.walkingAudioIntervalMeters) : 1000,
    walkingAudioSound: Number.isInteger(Number(rawSettings.walkingAudioSound)) ? Number(rawSettings.walkingAudioSound) : 1,
    activityType,
    goalPaceCustomized: Boolean(value?.goalPaceCustomized) || `${safeMinutes}:${String(safeSeconds).padStart(2, '0')}` !== DEFAULT_GOAL_PACE,
  }
}

function readLocalHistory() {
  const value = readLocalValue(LOCAL_HISTORY_KEY, [])
  return Array.isArray(value) ? value : []
}

function normalizeHistoryRecord(record) {
  return {
    id: record.id || `${record.date}-${record.time}-${record.distance}`,
    date: record.date,
    activityType: (record.activityType || record.activity_type) === 'walking' ? 'walking' : 'running',
    distance: String(record.distance),
    time: record.time,
    pace: normalizePaceDisplay(record.pace),
    splits: Array.isArray(record.splits) ? record.splits : [],
  }
}

function activityLabel(activityType) {
  return activityType === 'walking' ? 'ウォーキング' : 'ランニング'
}

function normalizePaceDisplay(pace) {
  const match = String(pace || '').match(/^(\d+):(\d{1,2})$/)
  return match ? formatPace(Number(match[1]) * 60 + Number(match[2])) : pace
}

async function fetchProfileSettingsForUser(userId) {
  if (!hasSupabaseConfig || !userId) {
    return null
  }

  const { data, error } = await supabase
    .from('runpulse_profiles')
    .select('settings')
    .eq('user_id', userId)
    .maybeSingle()

  if (error && error.code !== 'PGRST116') {
    throw error
  }

  return data?.settings ?? null
}

async function fetchHistoryForUser(userId) {
  if (!hasSupabaseConfig || !userId) {
    return []
  }

  const { data, error } = await supabase
    .from('runpulse_history')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(HISTORY_LIMIT)

  if (error) {
    throw error
  }

  if (!data || !data.length) {
    return []
  }

  return data.map((item) => normalizeHistoryRecord(item))
}

async function persistProfileSettingsForUser(userId, settings) {
  if (!hasSupabaseConfig || !userId) {
    return
  }

  const { error } = await supabase.from('runpulse_profiles').upsert({
    user_id: userId,
    settings,
  }, { onConflict: 'user_id' })

  if (error) {
    throw error
  }
}

function formatTime(totalSeconds) {
  if (!Number.isFinite(totalSeconds) || totalSeconds <= 0) {
    return '00:00:00'
  }

  totalSeconds = Math.floor(totalSeconds)
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60

  return [hours, minutes, seconds]
    .map((value) => String(value).padStart(2, '0'))
    .join(':')
}

function formatDurationJapanese(totalSeconds) {
  if (!Number.isFinite(totalSeconds) || totalSeconds <= 0) return '0秒'
  const roundedSeconds = Math.floor(totalSeconds)
  const hours = Math.floor(roundedSeconds / 3600)
  const minutes = Math.floor((roundedSeconds % 3600) / 60)
  const seconds = roundedSeconds % 60
  if (hours > 0) return `${hours}時間${minutes}分${seconds}秒`
  if (minutes > 0) return `${minutes}分${seconds}秒`
  return `${seconds}秒`
}

function displayStoredDuration(value) {
  const match = String(value || '').match(/^(\d+):(\d{2}):(\d{2})$/)
  if (!match) return value
  return formatDurationJapanese(Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]))
}

function formatPace(secondsPerKm) {
  if (!Number.isFinite(secondsPerKm) || secondsPerKm <= 0) {
    return '—'
  }

  const minutes = Math.floor(secondsPerKm / 60)
  const seconds = Math.round(secondsPerKm % 60)
  if (seconds === 60) {
    return `${minutes + 1}分00秒／km`
  }
  return `${minutes}分${String(seconds).padStart(2, '0')}秒／km`
}

function formatDistance(meters, unit) {
  const distance = unit === 'mi' ? meters / 1609.344 : meters / 1000
  return `${distance.toFixed(1)}${unit === 'mi' ? 'mi' : 'km'}`
}

function parseTargetDistance(target) {
  if (target === '5km') return 5
  if (target === '10km') return 10
  if (target === 'ハーフ') return 21.1
  if (target === 'フル') return 42.2
  return null
}

function parsePaceToSeconds(settings) {
  return Number(settings.goalPaceMinutes) * 60 + Number(settings.goalPaceSeconds)
}

function formatDistanceLabel(distanceKm) {
  return `${distanceKm.toFixed(1)}km`
}

function kmFromMeters(distanceMeters) {
  return distanceMeters / 1000
}

function App() {
  const [session, setSession] = useState(null)
  const [authMode, setAuthMode] = useState('signIn')
  const [authEmail, setAuthEmail] = useState('')
  const [authPassword, setAuthPassword] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [authLoading, setAuthLoading] = useState(false)
  const [authError, setAuthError] = useState('')

  const [screen, setScreen] = useState('home')
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [paceSettingsOpen, setPaceSettingsOpen] = useState(false)
  const [paceMinutesInput, setPaceMinutesInput] = useState('')
  const [paceSecondsInput, setPaceSecondsInput] = useState('')
  const [logoutConfirmOpen, setLogoutConfirmOpen] = useState(false)
  const [showIntro, setShowIntro] = useState(() => !readLocalValue(LOCAL_INTRO_KEY, false))
  const [introIndex, setIntroIndex] = useState(0)
  const [selectedTarget, setSelectedTarget] = useState('10km')
  const [customDistancesKm, setCustomDistancesKm] = useState({ running: null, walking: null })
  const [customDistanceInput, setCustomDistanceInput] = useState('')
  const [customDistanceError, setCustomDistanceError] = useState('')
  const [customDistanceOpen, setCustomDistanceOpen] = useState(false)
  const [finishConfirmOpen, setFinishConfirmOpen] = useState(false)
  const [saveMessage, setSaveMessage] = useState('')
  const [saveMessageType, setSaveMessageType] = useState('success')
  const [settings, setSettings] = useState(() => readLocalSettings())
  const [elapsedSeconds, setElapsedSeconds] = useState(0)
  const [distanceMeters, setDistanceMeters] = useState(0)
  const [measurement, setMeasurement] = useState({ points: [], splits: [] })
  const [history, setHistory] = useState(() => readLocalHistory())
  const [selectedRecord, setSelectedRecord] = useState(null)
  const [gpsStatus, setGpsStatus] = useState('スタート後にGPSを取得します')
  const wakeLockSentinelRef = useRef(null)
  const timerRef = useRef(null)
  const saveMessageTimerRef = useRef(null)
  const measurementRef = useRef({ points: [], splits: [] })
  const lastPaceAlertRef = useRef(0)
  const pausePressTimerRef = useRef(null)
  const audioContextRef = useRef(null)
  const distanceAlertTimersRef = useRef([])
  const targetAlertSentRef = useRef(false)
  const [pausePressProgress, setPausePressProgress] = useState(0)

  useEffect(() => {
    if (saveMessageTimerRef.current) {
      window.clearTimeout(saveMessageTimerRef.current)
      saveMessageTimerRef.current = null
    }

    if (!saveMessage || saveMessageType !== 'success') {
      return undefined
    }

    saveMessageTimerRef.current = window.setTimeout(() => {
      setSaveMessage('')
      saveMessageTimerRef.current = null
    }, 5000)

    return () => {
      if (saveMessageTimerRef.current) {
        window.clearTimeout(saveMessageTimerRef.current)
        saveMessageTimerRef.current = null
      }
    }
  }, [saveMessage, saveMessageType, screen])

  useEffect(() => {
    if (!hasSupabaseConfig) {
      return undefined
    }

    const loadSession = async () => {
      const { data: { session: currentSession } } = await supabase.auth.getSession()
      setSession(currentSession)
    }

    loadSession()

    const { data: authListener } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      setSession(nextSession)
    })

    return () => {
      authListener.subscription.unsubscribe()
    }
  }, [])

  useEffect(() => {
    if (!session) {
      return
    }

    const loadUserData = async () => {
      try {
        const profileSettings = await fetchProfileSettingsForUser(session.user.id)
        if (profileSettings) {
          setSettings(normalizeSettings(profileSettings))
        } else {
          await persistProfileSettingsForUser(session.user.id, DEFAULT_SETTINGS)
          setSettings(DEFAULT_SETTINGS)
        }

        const nextHistory = await fetchHistoryForUser(session.user.id)
        if (nextHistory.length) {
          setHistory(nextHistory)
        } else {
          setHistory([])
        }
      } catch {
        setHistory(readLocalHistory())
      }
    }

    loadUserData()
  }, [session])

  useEffect(() => {
    if (!session && !hasSupabaseConfig) {
      writeLocalValue(LOCAL_SETTINGS_KEY, settings)
    }

    if (session && hasSupabaseConfig) {
      persistProfileSettingsForUser(session.user.id, settings).catch(() => {})
    }
  }, [session, settings])

  useEffect(() => {
    if (!session) {
      writeLocalValue(LOCAL_HISTORY_KEY, history)
    }
  }, [history, session])

  useEffect(() => {
    if (screen !== 'running' || !('wakeLock' in navigator)) {
      if (wakeLockSentinelRef.current) {
        wakeLockSentinelRef.current.release().catch(() => {})
        wakeLockSentinelRef.current = null
      }
      return undefined
    }

    let cancelled = false

    const requestWakeLock = async () => {
      try {
        const sentinel = await navigator.wakeLock.request('screen')
        if (cancelled) {
          await sentinel.release().catch(() => {})
          return
        }

        wakeLockSentinelRef.current = sentinel
      } catch {
        // Some browsers deny screen wake lock; fail silently.
      }
    }

    requestWakeLock()
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        requestWakeLock()
      }
    }
    document.addEventListener('visibilitychange', handleVisibilityChange)

    return () => {
      cancelled = true
      document.removeEventListener('visibilitychange', handleVisibilityChange)
      if (wakeLockSentinelRef.current) {
        wakeLockSentinelRef.current.release().catch(() => {})
        wakeLockSentinelRef.current = null
      }
    }
  }, [screen])

  const customDistanceKm = customDistancesKm[activityType]
  const targetDistanceKm = selectedTarget === 'カスタム' ? customDistanceKm : parseTargetDistance(selectedTarget)
  const distanceKm = kmFromMeters(distanceMeters)
  const goalPaceSeconds = parsePaceToSeconds(settings)
  const activityType = settings.activityType || 'running'

  useEffect(() => {
    const saved = readLocalValue(LOCAL_RUN_STATE_KEY, null)
    if (!saved?.timer || !saved?.measurement || !['running', 'paused'].includes(saved.screen)) {
      return
    }

    timerRef.current = saved.timer
    measurementRef.current = saved.measurement
    setMeasurement(saved.measurement)
    setDistanceMeters(saved.measurement.points.at(-1)?.cumulativeDistanceMeters ?? 0)
    setElapsedSeconds(elapsedMsAt(saved.timer, Date.now()) / 1000)
    setGpsStatus('スタート後にGPSを取得します')
    setScreen(saved.screen)
  }, [])

  useEffect(() => {
    if (!session) {
      return
    }

    if (!showIntro) {
      writeLocalValue(LOCAL_INTRO_KEY, true)
    }
  }, [session, showIntro])

  useEffect(() => {
    if (screen !== 'running') {
      return undefined
    }

    const refreshElapsed = () => {
      if (!timerRef.current) return
      setElapsedSeconds(elapsedMsAt(timerRef.current, Date.now()) / 1000)
    }
    const refreshEvents = ['visibilitychange', 'pageshow', 'focus']
    refreshEvents.forEach((eventName) => window.addEventListener(eventName, refreshElapsed))
    const timer = window.setInterval(refreshElapsed, 250)
    refreshElapsed()

    return () => {
      window.clearInterval(timer)
      refreshEvents.forEach((eventName) => window.removeEventListener(eventName, refreshElapsed))
    }
  }, [screen])

  useEffect(() => {
    if (screen !== 'running') {
      return undefined
    }

    if (!('geolocation' in navigator)) {
      setGpsStatus('GPSを取得できません')
      return undefined
    }

    const watchId = navigator.geolocation.watchPosition(
      (position) => {
        const { latitude, longitude, accuracy } = position.coords
        const point = {
          latitude,
          longitude,
          accuracy,
          timestamp: position.timestamp,
          elapsedMs: elapsedMsAt(timerRef.current, position.timestamp),
        }
        const next = appendGpsPoint(measurementRef.current, point)
        if (next.result.accepted) {
          const previousDistance = measurementRef.current.points.at(-1)?.cumulativeDistanceMeters ?? 0
          measurementRef.current = next.state
          setMeasurement(next.state)
          setDistanceMeters(next.result.cumulativeDistanceMeters)
          const audioPrefix = activityType === 'walking' ? 'walking' : 'running'
          const audioMode = settings[`${audioPrefix}AudioMode`]
          const audioInterval = settings[`${audioPrefix}AudioIntervalMeters`]
          const reachedTarget = ['target', 'targetAndInterval'].includes(audioMode) && targetDistanceKm && previousDistance < targetDistanceKm * 1000 && next.result.cumulativeDistanceMeters >= targetDistanceKm * 1000 && !targetAlertSentRef.current
          const reachedInterval = ['interval', 'targetAndInterval'].includes(audioMode) && Math.floor(next.result.cumulativeDistanceMeters / audioInterval) > Math.floor(previousDistance / audioInterval)
          if (settings.audioOn && (reachedTarget || reachedInterval)) {
            if (reachedTarget) targetAlertSentRef.current = true
            playDistanceAlert(Math.round(next.result.cumulativeDistanceMeters / 1000), settings[`${audioPrefix}AudioSound`])
          }
          writeLocalValue(LOCAL_RUN_STATE_KEY, {
            screen: 'running',
            timer: timerRef.current,
            measurement: next.state,
          })
        }
        setGpsStatus(accuracy <= 30 ? 'GPS良好' : 'GPS精度が低い')
      },
      (error) => {
        setGpsStatus(error.code === 1 ? '位置情報を許可してください' : 'GPSを取得できません')
      },
      {
        enableHighAccuracy: true,
        maximumAge: 0,
        timeout: 10000,
      },
    )

    return () => navigator.geolocation.clearWatch(watchId)
  }, [screen])

  const averagePaceSeconds = calculateAveragePaceSeconds(elapsedSeconds * 1000, distanceMeters)
  const currentPaceSeconds = calculateRollingPaceSeconds(measurement.points)
  const paceDiffSeconds = currentPaceSeconds === null ? null : currentPaceSeconds - goalPaceSeconds
  const predictedFinishSeconds = targetDistanceKm && distanceKm > 0 && currentPaceSeconds !== null
    ? Math.max(0, elapsedSeconds + (targetDistanceKm - distanceKm) * currentPaceSeconds)
    : 0

  const paceAlert = useMemo(() => {
    if (screen !== 'running') {
      return null
    }

    if (paceDiffSeconds === null) {
      return null
    }
    if (paceDiffSeconds > 20) {
      return 'ペースが遅れています'
    }

    if (paceDiffSeconds < -15) {
      return 'ペースが上回っています'
    }

    return null
  }, [paceDiffSeconds, screen])

  useEffect(() => {
    if (!paceAlert || !settings.audioOn || !('speechSynthesis' in window)) {
      return undefined
    }

    if (Date.now() - lastPaceAlertRef.current < 120000) {
      return undefined
    }
    lastPaceAlertRef.current = Date.now()
    const utterance = new SpeechSynthesisUtterance(paceAlert)
    utterance.lang = 'ja-JP'
    window.speechSynthesis.cancel()
    window.speechSynthesis.speak(utterance)

    return undefined
  }, [paceAlert, settings.audioOn])

  useEffect(() => () => {
    distanceAlertTimersRef.current.forEach((timer) => window.clearInterval(timer))
    distanceAlertTimersRef.current = []
  }, [screen])

  const resultSplits = formatSplitRows(measurement.splits, distanceMeters, elapsedSeconds * 1000)

  const userDisplayName = useMemo(() => {
    const emailName = session?.user?.email?.split('@')[0] ?? 'ユーザー'
    return session?.user?.user_metadata?.full_name || emailName
  }, [session])

  const handleAuthSubmit = async (event) => {
    event.preventDefault()

    if (!hasSupabaseConfig) {
      setAuthError('現在、ログイン機能を利用できません。')
      return
    }

    setAuthLoading(true)
    setAuthError('')

    try {
      if (authMode === 'signUp') {
        const { data, error } = await supabase.auth.signUp({
          email: authEmail,
          password: authPassword,
          options: {
            data: {
              full_name: displayName || authEmail.split('@')[0],
            },
          },
        })

        if (error) {
          throw error
        }

        if (data.user && !data.session) {
          setAuthError('確認メールを送信しました。メールのリンクを開いてログインしてください。')
        }
      } else {
        const { data, error } = await supabase.auth.signInWithPassword({
          email: authEmail,
          password: authPassword,
        })

        if (error) {
          throw error
        }

        setSession(data.session)
        setScreen('home')
      }
    } catch (error) {
      setAuthError(error.message || 'ログインに失敗しました')
    } finally {
      setAuthLoading(false)
    }
  }

  const handleSignOut = async () => {
    if (hasSupabaseConfig) {
      await supabase.auth.signOut()
    }

    setSettingsOpen(false)
    setPaceSettingsOpen(false)
    setLogoutConfirmOpen(false)
    setSession(null)
    setScreen('home')
    setAuthError('')
  }

  const playDistanceAlert = (kilometer, soundIndex = 0) => {
    if (!settings.audioOn || !('AudioContext' in window)) return
    const context = audioContextRef.current || new window.AudioContext()
    audioContextRef.current = context
    context.resume().catch(() => {})
    const startedAt = Date.now()
    const timer = window.setInterval(() => {
      if (Date.now() - startedAt >= 10000) {
        window.clearInterval(timer)
        distanceAlertTimersRef.current = distanceAlertTimersRef.current.filter((item) => item !== timer)
        return
      }
      const oscillator = context.createOscillator()
      const gain = context.createGain()
      const frequencies = [880, 660, 880, 1200, 440, 660, 1200, 520, 1000, 760]
      oscillator.frequency.value = frequencies[soundIndex % frequencies.length]
      gain.gain.setValueAtTime(0.0001, context.currentTime)
      gain.gain.exponentialRampToValueAtTime(0.18, context.currentTime + 0.02)
      gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + 0.35)
      oscillator.connect(gain)
      gain.connect(context.destination)
      oscillator.start()
      oscillator.stop(context.currentTime + 0.4)
    }, 1000)
    distanceAlertTimersRef.current.push(timer)
    setSaveMessage(`${kilometer}kmに到達しました`)
  }

  const previewDistanceAlert = (soundIndex) => {
    if (!settings.audioOn || !('AudioContext' in window)) return
    const context = audioContextRef.current || new window.AudioContext()
    audioContextRef.current = context
    context.resume().catch(() => {})
    const frequencies = [880, 660, 880, 1200, 440, 660, 1200, 520, 1000, 760]
    const oscillator = context.createOscillator()
    const gain = context.createGain()
    oscillator.frequency.value = frequencies[soundIndex % frequencies.length]
    gain.gain.setValueAtTime(0.0001, context.currentTime)
    gain.gain.exponentialRampToValueAtTime(0.18, context.currentTime + 0.02)
    gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + 0.35)
    oscillator.connect(gain)
    gain.connect(context.destination)
    oscillator.start()
    oscillator.stop(context.currentTime + 0.4)
  }

  const startRun = () => {
    if (!targetDistanceKm) {
      setCustomDistanceError('移動する距離を選択してください。')
      setCustomDistanceOpen(true)
      return
    }
    const nowMs = Date.now()
    setSaveMessage('')
    const timer = {
      startedAtMs: nowMs,
      resumedAtMs: nowMs,
      accumulatedRunningMs: 0,
      pausedAtMs: null,
    }
    const nextMeasurement = { points: [], splits: [] }
    timerRef.current = timer
    measurementRef.current = nextMeasurement
    writeLocalValue(LOCAL_RUN_STATE_KEY, { screen: 'running', timer, measurement: nextMeasurement })
    setElapsedSeconds(0)
    setDistanceMeters(0)
    setMeasurement(nextMeasurement)
    setGpsStatus('GPS取得中')

    if ('geolocation' in navigator) {
      navigator.geolocation.getCurrentPosition(
        () => {
          setGpsStatus('GPS取得中')
        },
        () => {
          setGpsStatus('位置情報を許可してください')
        },
        {
          enableHighAccuracy: true,
          timeout: 10000,
          maximumAge: 0,
        },
      )
    } else {
      setGpsStatus('GPSを取得できません')
    }

    if (settings.audioOn && 'AudioContext' in window) {
      audioContextRef.current = audioContextRef.current || new window.AudioContext()
      audioContextRef.current.resume().catch(() => {})
    }
    targetAlertSentRef.current = false
    setScreen('running')
  }

  const pauseRun = () => {
    if (!timerRef.current) return
    const timer = pauseTimer(timerRef.current, Date.now())
    timerRef.current = timer
    setElapsedSeconds(elapsedMsAt(timer, Date.now()) / 1000)
    writeLocalValue(LOCAL_RUN_STATE_KEY, { screen: 'paused', timer, measurement: measurementRef.current })
    setScreen('paused')
  }

  const resumeRun = () => {
    if (!timerRef.current) return
    const timer = resumeTimer(timerRef.current, Date.now())
    timerRef.current = timer
    writeLocalValue(LOCAL_RUN_STATE_KEY, { screen: 'running', timer, measurement: measurementRef.current })
    setScreen('running')
  }

  const finishRun = () => {
    if (timerRef.current?.resumedAtMs !== null) {
      timerRef.current = pauseTimer(timerRef.current, Date.now())
    }
    setElapsedSeconds(elapsedMsAt(timerRef.current, Date.now()) / 1000)
    window.localStorage.removeItem(LOCAL_RUN_STATE_KEY)
    setScreen('result')
    setFinishConfirmOpen(false)
  }

  const startPausePress = () => {
    if (pausePressTimerRef.current || screen !== 'running') return
    const startedAt = performance.now()
    const updateProgress = () => {
      const progress = Math.min(1, (performance.now() - startedAt) / 650)
      setPausePressProgress(progress)
      if (progress < 1) {
        pausePressTimerRef.current = window.requestAnimationFrame(updateProgress)
      } else {
        pausePressTimerRef.current = null
        pauseRun()
      }
    }
    pausePressTimerRef.current = window.requestAnimationFrame(updateProgress)
  }

  const cancelPausePress = () => {
    if (pausePressTimerRef.current) {
      window.cancelAnimationFrame(pausePressTimerRef.current)
      pausePressTimerRef.current = null
    }
    setPausePressProgress(0)
  }

  const saveRecord = async () => {
    const nextRecord = {
      id: crypto.randomUUID(),
      date: new Date().toISOString().slice(0, 10),
      activityType,
      distance: distanceKm.toFixed(1),
      time: formatDurationJapanese(elapsedSeconds),
      pace: formatPace(averagePaceSeconds),
      splits: resultSplits,
    }

    const nextHistory = [nextRecord, ...history].slice(0, HISTORY_LIMIT)

    if (session && hasSupabaseConfig) {
      const { error } = await supabase.from('runpulse_history').insert({
        id: nextRecord.id,
        user_id: session.user.id,
        date: nextRecord.date,
        activity_type: nextRecord.activityType,
        distance: nextRecord.distance,
        time: nextRecord.time,
        pace: nextRecord.pace,
        splits: nextRecord.splits,
      })

      if (error) {
        setSaveMessageType('error')
        setSaveMessage('保存に失敗しました。通信状態を確認してください。')
        return
      }
    }

    setHistory(nextHistory)
    setSaveMessageType('success')
    setSaveMessage('記録を保存しました。')

    setScreen('home')
    setElapsedSeconds(0)
    setDistanceMeters(0)
    setMeasurement({ points: [], splits: [] })
    timerRef.current = null
    measurementRef.current = { points: [], splits: [] }
    window.localStorage.removeItem(LOCAL_RUN_STATE_KEY)
    setGpsStatus('スタート後にGPSを取得します')
  }

  const closeResult = () => {
    setScreen('home')
    setElapsedSeconds(0)
    setDistanceMeters(0)
    setMeasurement({ points: [], splits: [] })
    timerRef.current = null
    measurementRef.current = { points: [], splits: [] }
    window.localStorage.removeItem(LOCAL_RUN_STATE_KEY)
    setGpsStatus('スタート後にGPSを取得します')
  }

  const selectTarget = (target) => {
    setSelectedTarget(target)
    if (target === 'カスタム') {
      setCustomDistanceInput(customDistanceKm ? String(customDistanceKm) : '')
      setCustomDistanceError('')
      setCustomDistanceOpen(true)
    }
  }

  const selectActivity = (nextActivityType) => {
    if (selectedTarget === 'カスタム') {
      setCustomDistanceInput(customDistancesKm[nextActivityType] ? String(customDistancesKm[nextActivityType]) : '')
    }
    setSettings((current) => {
      const prefix = nextActivityType === 'walking' ? 'Walking' : 'Running'
      const minutes = Number(current[`goalPace${prefix}Minutes`])
      const seconds = Number(current[`goalPace${prefix}Seconds`])
      return {
        ...current,
        activityType: nextActivityType,
        goalPaceMinutes: minutes,
        goalPaceSeconds: seconds,
        goalPace: `${minutes}:${String(seconds).padStart(2, '0')}`,
      }
    })
  }

  const confirmCustomDistance = () => {
    const value = Number(customDistanceInput)
    if (!Number.isFinite(value) || value < 1 || value > 100 || !/^\d+(\.\d)?$/.test(customDistanceInput)) {
      setCustomDistanceError('距離は1.0〜100.0kmの範囲で、小数第1位まで入力してください。')
      return
    }
    setCustomDistancesKm((current) => ({ ...current, [activityType]: Math.round(value * 10) / 10 }))
    setCustomDistanceOpen(false)
    setCustomDistanceError('')
  }

  const goHistory = () => setScreen('history')
  const selectRecord = (record) => {
    setSelectedRecord(record)
    setScreen('details')
  }

  const completeIntro = () => {
    setShowIntro(false)
    setIntroIndex(0)
    writeLocalValue(LOCAL_INTRO_KEY, true)
  }

  const dismissSaveMessage = () => setSaveMessage('')

  const renderHomeScreen = () => (
    <div className="screen home-screen">
      <div className="app-header">
        <span className="app-brand">RunPulse</span>
      </div>

      <div className="user-bar">
        <span>利用者：<strong>{userDisplayName}</strong></span>
        <button type="button" className="account-settings-button" onClick={() => setSettingsOpen(true)}>
          <span aria-hidden="true">⚙</span> 設定
        </button>
      </div>

      <div className="section-heading">運動の種類</div>
      <div className="goal-row activity-row">
        {ACTIVITY_TYPES.map((activity) => (
          <div
            key={activity.value}
            className={`target-pill activity-pill ${activityType === activity.value ? 'selected' : ''}`}
            onClick={() => selectActivity(activity.value)}
          >
            {activityType === activity.value && <span aria-hidden="true">✓ </span>}
            {activity.label}
          </div>
        ))}
      </div>

      <div className="section-heading">今回の目標距離</div>
      <p className="section-help">目標距離を選んでください</p>
      <div className="goal-row">
        {TARGETS.map((target) => (
          <button
            key={target}
            type="button"
            className={`target-pill ${selectedTarget === target ? 'selected' : ''}`}
            onClick={() => selectTarget(target)}
          >
            {selectedTarget === target && <span aria-hidden="true">✓ </span>}
            {target === 'カスタム' && customDistanceKm ? `カスタム ${formatDistanceLabel(customDistanceKm)}` : target}
          </button>
        ))}
      </div>

      <div className="goal-row secondary-row">
        <button type="button" className="target-pill subtle-pill" onClick={() => { setPaceMinutesInput(String(settings.goalPaceMinutes)); setPaceSecondsInput(String(settings.goalPaceSeconds)); setPaceSettingsOpen(true) }}>
          <span>目標ペース</span>
          <strong>{formatPace(goalPaceSeconds)}</strong>
        </button>
      </div>
      <p className="section-help pace-help">1kmを移動する目標時間</p>

      <div className="home-status">
        <span className="status-dot" />
        <span>{gpsStatus}</span>
      </div>

      {saveMessage && (
        <div className={`save-message ${saveMessageType}`} role="status" onClick={dismissSaveMessage}>
          <span>{saveMessage}</span>
          <button type="button" aria-label="メッセージを閉じる" onClick={dismissSaveMessage}>×</button>
        </div>
      )}

      <div className="primary-action-wrap">
        <button type="button" className="primary-button" onClick={startRun}>
          運動をスタート
        </button>
      </div>

      <button type="button" className="link-button" onClick={goHistory}>
        過去の記録を見る
      </button>
      <button type="button" className="help-button" onClick={() => setScreen('help')}>
        <span aria-hidden="true">?</span> 使い方・機能について
      </button>
    </div>
  )

  const renderRunScreen = () => (
    <div className="screen run-screen">
      <div className="app-header compact-header">
        <span className="app-brand">RunPulse</span>
      </div>

      <div className="gps-status-row">
        <span className="status-pill">{gpsStatus}</span>
      </div>

      <div className="pace-block">
          <div className="pace-label">現在のペース</div>
          <div className="pace-value">{currentPaceSeconds === null ? '計測準備中' : formatPace(currentPaceSeconds)}</div>
      </div>

      <div className="divider" />

      <div className="stats-row">
        <div className="stat-box">
          <span className="stat-label">運動時間</span>
          <strong>{formatTime(elapsedSeconds)}</strong>
        </div>
        <div className="stat-box">
          <span className="stat-label">移動距離</span>
          <strong>{formatDistance(distanceMeters, settings.unit)}</strong>
        </div>
      </div>

      <div className="goal-summary">
        <div>
          <span>予測ゴール時間</span>
          <strong>{predictedFinishSeconds ? formatTime(predictedFinishSeconds) : '計測準備中'}</strong>
        </div>
        <div>
          <span>ペース差</span>
          <strong className={paceDiffSeconds === null ? '' : paceDiffSeconds > 0 ? 'warning' : 'ok'}>
            {paceDiffSeconds === null
              ? '計測準備中'
              : Math.abs(paceDiffSeconds) <= 5
                ? '目標どおり'
                : paceDiffSeconds > 0
                  ? `目標より${Math.round(paceDiffSeconds)}秒遅い`
                  : `目標より${Math.round(Math.abs(paceDiffSeconds))}秒速い`}
          </strong>
        </div>
      </div>

      {paceAlert && (
        <div className="pace-alert" role="status" aria-live="polite">
          {paceAlert}
        </div>
      )}

      <button type="button" className="pause-button hold-to-pause" onPointerDown={startPausePress} onPointerUp={cancelPausePress} onPointerCancel={cancelPausePress} onPointerLeave={cancelPausePress} style={{ '--pause-progress': pausePressProgress }} aria-label="長押しで一時停止">
        一時停止
      </button>
    </div>
  )

  const renderPausedScreen = () => (
    <div className="screen run-screen paused-screen">
      <div className="app-header compact-header">
        <span className="app-brand">RunPulse</span>
      </div>

      <div className="pause-badge">一時停止中</div>

      <div className="pace-block">
        <div className="pace-label">現在のペース</div>
        <div className="pace-value">{currentPaceSeconds === null ? '計測準備中' : formatPace(currentPaceSeconds)}</div>
      </div>

      <div className="divider" />

      <div className="stats-row">
        <div className="stat-box">
          <span className="stat-label">運動時間</span>
          <strong>{formatTime(elapsedSeconds)}</strong>
        </div>
        <div className="stat-box">
          <span className="stat-label">移動距離</span>
          <strong>{formatDistance(distanceMeters, settings.unit)}</strong>
        </div>
      </div>

      <div className="pause-actions">
        <button type="button" className="primary-button" onClick={resumeRun}>
          再開
        </button>
        <button type="button" className="secondary-button" onClick={() => setFinishConfirmOpen(true)}>
          終了
        </button>
      </div>
    </div>
  )

  const renderResultScreen = () => (
    <div className="screen result-screen">
      <div className="result-header">お疲れさまです</div>

      <div className="activity-result">運動：{activityLabel(activityType)}</div>

      <div className="result-metrics">
        <div className="result-metric-item">
          <span>移動距離</span>
          <strong>{formatDistance(distanceMeters, settings.unit)}</strong>
        </div>
        <div className="result-metric-item">
          <span>運動時間</span>
          <strong>{formatDurationJapanese(elapsedSeconds)}</strong>
        </div>
        <div className="result-metric-item">
          <span>平均ペース</span>
          <strong>{formatPace(averagePaceSeconds)}</strong>
        </div>
        <div className="result-metric-item">
          <span>実施日</span>
          <strong>{new Date().toLocaleDateString('ja-JP')}</strong>
        </div>
      </div>

      <div className="split-block">
        <div className="split-title">スプリット</div>
        {resultSplits.length ? resultSplits.map((split) => (
          <div key={split.label} className="split-row">
            <span>{split.label}</span>
            <strong>{split.pace}</strong>
          </div>
        )) : <div className="split-empty">1kmスプリットはまだありません</div>}
      </div>

      <div className="result-actions">
        {saveMessage && (
          <div className={`save-message ${saveMessageType}`} role="status" onClick={dismissSaveMessage}>
            <span>{saveMessage}</span>
            <button type="button" aria-label="メッセージを閉じる" onClick={dismissSaveMessage}>×</button>
          </div>
        )}
        <button type="button" className="primary-button" onClick={saveRecord}>
          保存して終了
        </button>
        <button type="button" className="secondary-button" onClick={closeResult}>
          保存せず終了
        </button>
      </div>
    </div>
  )

  const deleteHistoryRecord = async (record) => {
    if (!window.confirm('この記録を削除しますか？')) return

    if (session && hasSupabaseConfig) {
      const { error } = await supabase.from('runpulse_history').delete().eq('id', record.id).eq('user_id', session.user.id)
      if (error) {
        setSaveMessageType('error')
        setSaveMessage('記録の削除に失敗しました。通信状態を確認してください。')
        return
      }
    }

    setHistory((currentHistory) => currentHistory.filter((item) => item.id !== record.id))
    setSaveMessageType('success')
    setSaveMessage('記録を削除しました。')
  }

  const renderHistoryScreen = () => (
    <div className="screen history-screen">
      <div className="result-header">過去の記録</div>
      <div className="history-list">
        {history.length ? history.map((record) => (
          <div
            key={record.id}
            className="history-item"
          >
            <button type="button" className="history-item-main" onClick={() => selectRecord(record)}>
            <span>{record.date.replaceAll('-', '/')}</span>
            <strong>{activityLabel(record.activityType)}</strong>
            <strong>{record.distance}km</strong>
            <span>運動時間 {displayStoredDuration(record.time)}</span>
            <span>{record.pace}</span>
            </button>
            <button type="button" className="history-delete" onClick={() => deleteHistoryRecord(record)} aria-label="この記録を削除">削除</button>
          </div>
        )) : <div className="empty-state">まだ記録がありません。最初のランニングまたはウォーキングを記録しましょう。</div>}
      </div>
      <button type="button" className="secondary-button wide-button" onClick={() => setScreen('home')}>
        戻る
      </button>
    </div>
  )

  const renderDetailScreen = () => (
    <div className="screen detail-screen">
      <div className="result-header">記録詳細</div>
      <div className="detail-card">
        <div className="detail-row">
          <span>日付</span>
          <strong>{selectedRecord?.date}</strong>
        </div>
        <div className="detail-row">
          <span>運動</span>
          <strong>{activityLabel(selectedRecord?.activityType)}</strong>
        </div>
        <div className="detail-row">
          <span>距離</span>
          <strong>{selectedRecord?.distance}km</strong>
        </div>
        <div className="detail-row">
          <span>運動時間</span>
          <strong>{displayStoredDuration(selectedRecord?.time)}</strong>
        </div>
        <div className="detail-row">
          <span>平均ペース</span>
          <strong>{selectedRecord?.pace}</strong>
        </div>
      </div>

      <div className="split-block">
        <div className="split-title">実測スプリット</div>
        {selectedRecord?.splits?.length ? selectedRecord.splits.map((split) => (
          <div key={split.label} className="split-row">
            <span>{split.label}</span>
            <strong>{split.pace}</strong>
          </div>
        )) : <div className="split-empty">1kmスプリットはまだありません</div>}
      </div>

      <button type="button" className="secondary-button wide-button" onClick={() => setScreen('history')}>
        戻る
      </button>
    </div>
  )

  const renderHelpScreen = () => (
    <div className="screen help-screen">
      <div className="result-header">RunPulseの使い方</div>
      <article className="help-content">
        <h3>計測時の注意</h3>
        <p>運動中はRunPulseを前面に表示し、画面をロックしないでください。GPSは屋外で安定しやすくなります。</p>

        <h3>RunPulseとは</h3>
        <p>RunPulseは、ランニングとウォーキングの運動時間、移動距離、ペース、1kmごとの記録を分かりやすく確認するアプリです。</p>

        <h3>ログインと更新</h3>
        <p>一度ログインすると、次回から自動的にログインした状態で開きます。ホーム画面に追加したRunPulseを更新するには、アプリを閉じてからもう一度開いてください。更新が反映されない場合は、SafariでRunPulseを開き直してからホーム画面のアプリを起動してください。</p>

        <h3>基本的な使い方</h3>
        <ol>
          <li>ランニングまたはウォーキングを選ぶ</li>
          <li>今回の目標距離を選ぶ</li>
          <li>1kmあたりの目標ペースを設定する</li>
          <li>「運動をスタート」を押す</li>
          <li>位置情報の使用を許可する</li>
          <li>終了時は「一時停止」から「終了する」を選ぶ</li>
          <li>結果を確認して保存する</li>
        </ol>

        <h3>目標距離</h3>
        <p>5km、10km、ハーフ、フル、カスタムから選択できます。選択した距離は予測ゴール時間の計算に使用します。目標距離へ到達しても計測は自動終了しません。</p>

        <h3>目標ペース</h3>
        <p>「5分00秒／km」は、1kmを5分で移動する目標という意味です。ウォーキングでは「10分00秒／km」のように設定できます。目標ペースは目安であり、実際の記録を書き換えるものではありません。</p>

        <h3>現在のペース・運動時間</h3>
        <p>現在のペースはGPSから直近の移動速度を計算した実測値です。開始直後やGPSデータが不足している間は「計測準備中」と表示されます。運動時間はGPSとは独立して計測するため、GPSが不安定でも進みます。一時停止中の時間は含まれません。</p>

        <h3>スプリット</h3>
        <p>スプリットとは、1kmごとにかかった実測時間です。どの区間で速かったか、遅くなったかを確認できます。実際のGPSデータだけから計算します。</p>

        <h3>GPSと位置情報</h3>
        <p>GPSは、移動距離の計算、現在のペースの計算、平均ペースの計算、1kmごとのスプリット計算に使用します。将来的には移動ルートの表示にも使用する予定です。運動時間の計測にはGPSを使用しません。正確な計測のため、屋外の空が見える場所で使用してください。</p>

        <h3>iPhoneで使用するときの注意</h3>
        <p>Web版では、画面をロックした状態やSafariを完全にバックグラウンドへ移した状態のGPS計測を保証できません。運動中はRunPulseを前面に表示し、画面をロックしないでください。</p>

        <h3>記録と安全上の注意</h3>
        <p>保存した記録は「過去の記録を見る」から確認できます。記録はログインした利用者ごとに分けて保存されます。</p>
        <ul>
          <li>運動中は画面を注視しない</li>
          <li>周囲の交通や路面状況を優先する</li>
          <li>安全な場所で操作する</li>
          <li>体調が悪い場合は無理をせず中止する</li>
          <li>RunPulseは医療機器ではなく、運動を補助するためのアプリです</li>
          <li>GPS環境によって距離やペースに多少の誤差が出る場合があります</li>
        </ul>
      </article>
      <button type="button" className="secondary-button wide-button" onClick={() => setScreen('home')}>ホームへ戻る</button>
    </div>
  )

  if (!session) {
    return (
      <div className="app-shell auth-shell">
        <div className="auth-card">
          <div className="auth-header">
            <span className="app-brand">RunPulse</span>
            <h1>{authMode === 'signIn' ? 'ログイン' : '新規登録'}</h1>
          </div>

          <div className="auth-toggle">
            <button type="button" className={authMode === 'signIn' ? 'active' : ''} onClick={() => setAuthMode('signIn')}>
              ログイン
            </button>
            <button type="button" className={authMode === 'signUp' ? 'active' : ''} onClick={() => setAuthMode('signUp')}>
              新規登録
            </button>
          </div>

          <form className="auth-form" onSubmit={handleAuthSubmit}>
            {authMode === 'signUp' && (
              <label className="auth-field">
                <span>名前</span>
                <input
                  type="text"
                  value={displayName}
                  onChange={(event) => setDisplayName(event.target.value)}
                  placeholder="例：田中 太郎"
                />
              </label>
            )}

            <label className="auth-field">
              <span>メールアドレス</span>
              <input
                type="email"
                value={authEmail}
                onChange={(event) => setAuthEmail(event.target.value)}
                placeholder="mail@example.com"
                required
              />
            </label>

            <label className="auth-field">
              <span>パスワード</span>
              <input
                type="password"
                value={authPassword}
                onChange={(event) => setAuthPassword(event.target.value)}
                placeholder="最低 6 文字"
                required
              />
            </label>

            {authError && <div className="auth-error">{authError}</div>}

            <button type="submit" className="primary-button auth-submit" disabled={authLoading}>
              {authLoading ? '処理中...' : authMode === 'signIn' ? 'ログイン' : '登録する'}
            </button>
          </form>

          {!hasSupabaseConfig && (
            <div className="auth-note">
              現在、ログイン機能を利用できません。
            </div>
          )}
        </div>
      </div>
    )
  }

  if (showIntro) {
    return (
      <div className="app-shell intro-shell">
        <div className="intro-card">
          <div className="intro-progress">{introIndex + 1}／3</div>

          <div className="intro-main">
            <div className="intro-visual" aria-hidden="true">RUNPULSE</div>
            <h2>{INTRO_STEPS[introIndex].title}</h2>
            <p>{INTRO_STEPS[introIndex].description}</p>
            <div className="intro-dots" aria-label={`${introIndex + 1}ページ目`}>
              {INTRO_STEPS.map((_, index) => (
                <span key={index} className={index === introIndex ? 'active' : ''} />
              ))}
            </div>
          </div>

          <div className="intro-actions">
          <button
            type="button"
            className="primary-button"
            onClick={() => {
              if (introIndex >= INTRO_STEPS.length - 1) {
                completeIntro()
                return
              }

              setIntroIndex((current) => current + 1)
            }}
          >
            {introIndex === INTRO_STEPS.length - 1 ? 'はじめる' : '次へ'}
          </button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="app-shell" data-brightness={settings.brightness}>
      {screen === 'running' && <div className="live-activity" role="status" aria-live="polite"><span className="live-activity-icon">◷</span><span>計測中</span><strong>{formatTime(elapsedSeconds)}</strong></div>}
      {screen === 'home' && renderHomeScreen()}
      {screen === 'running' && renderRunScreen()}
      {screen === 'paused' && renderPausedScreen()}
      {screen === 'result' && renderResultScreen()}
      {screen === 'history' && renderHistoryScreen()}
      {screen === 'details' && renderDetailScreen()}
      {screen === 'help' && renderHelpScreen()}

      {settingsOpen && (
        <div className="settings-overlay" onClick={() => setSettingsOpen(false)}>
          <div className="settings-sheet account-settings-sheet" onClick={(event) => event.stopPropagation()}>
            <div className="settings-header">
              <h3>設定</h3>
              <button type="button" className="close-button" onClick={() => setSettingsOpen(false)}>
                ×
              </button>
            </div>

            <div className="account-summary">
              <span>利用者名</span>
              <strong>{userDisplayName}</strong>
              <span>メールアドレス</span>
              <strong>{session.user.email}</strong>
            </div>

            <button type="button" className="settings-row-button" onClick={() => { setSettingsOpen(false); setPaceMinutesInput(String(settings.goalPaceMinutes)); setPaceSecondsInput(String(settings.goalPaceSeconds)); setPaceSettingsOpen(true) }}>
              <span>目標ペース</span>
              <strong>{formatPace(goalPaceSeconds)}</strong>
            </button>

            <label className="field">
              <span>単位</span>
              <select
                value={settings.unit}
                onChange={(event) => setSettings((current) => ({ ...current, unit: event.target.value }))}
              >
                <option value="km">km</option>
                <option value="mi">mile</option>
              </select>
            </label>

            <label className="toggle-row">
              <span>音声通知</span>
              <input
                type="checkbox"
                checked={settings.audioOn}
                onChange={(event) => setSettings((current) => ({ ...current, audioOn: event.target.checked }))}
              />
            </label>

            <div className="settings-section">
              <h4>距離通知（{activityType === 'walking' ? 'ウォーキング' : 'ランニング'}）</h4>
              <label className="field">
                <span>通知タイミング</span>
                <select value={settings[`${activityType}AudioMode`]} onChange={(event) => setSettings((current) => ({ ...current, [`${activityType}AudioMode`]: event.target.value }))}>
                  <option value="off">通知しない</option>
                  <option value="target">目標距離に到達したとき（1回のみ）</option>
                  <option value="interval">一定間隔ごと</option>
                  <option value="targetAndInterval">目標距離＋一定間隔ごと</option>
                </select>
              </label>
              {['interval', 'targetAndInterval'].includes(settings[`${activityType}AudioMode`]) && (
                <label className="field">
                  <span>通知間隔（1m単位）</span>
                  <input type="number" min="1" step="1" value={settings[`${activityType}AudioIntervalMeters`]} onChange={(event) => setSettings((current) => ({ ...current, [`${activityType}AudioIntervalMeters`]: Math.max(1, Number(event.target.value) || 1) }))} />
                </label>
              )}
              <label className="field">
                <span>通知音</span>
                <select value={settings[`${activityType}AudioSound`]} onChange={(event) => { const soundIndex = Number(event.target.value); setSettings((current) => ({ ...current, [`${activityType}AudioSound`]: soundIndex })); previewDistanceAlert(soundIndex) }}>
                  {AUDIO_SOUNDS.map((sound, index) => <option key={sound} value={index}>{sound}</option>)}
                </select>
              </label>
            </div>

            <label className="field">
              <span>画面の明るさ</span>
              <select
                value={settings.brightness}
                onChange={(event) => setSettings((current) => ({ ...current, brightness: event.target.value }))}
              >
                <option value="standard">標準</option>
                <option value="bright">明るく</option>
              </select>
            </label>

            <div className="settings-actions">
              <button type="button" className="logout-button" onClick={() => setLogoutConfirmOpen(true)}>
                ログアウト
              </button>
              <button type="button" className="secondary-button" onClick={() => setSettingsOpen(false)}>閉じる</button>
            </div>
          </div>
        </div>
      )}

      {paceSettingsOpen && (
        <div className="settings-overlay" onClick={() => setPaceSettingsOpen(false)}>
          <div className="settings-sheet" onClick={(event) => event.stopPropagation()}>
            <div className="settings-header">
              <h3>目標ペース</h3>
              <button type="button" className="close-button" onClick={() => setPaceSettingsOpen(false)} aria-label="閉じる">×</button>
            </div>
            <label className="field">
              <span>1kmあたりの目標時間</span>
              <span className="pace-inputs">
                <input aria-label="目標ペースの分" type="number" min="0" max="59" inputMode="numeric" value={paceMinutesInput} onFocus={(event) => event.target.select()} onChange={(event) => {
                  const value = event.target.value
                  setPaceMinutesInput(value)
                  if (value !== '' && Number(value) >= 0 && Number(value) <= 59) {
                    const minutes = Number(value)
                    setSettings((current) => { const prefix = current.activityType === 'walking' ? 'Walking' : 'Running'; return { ...current, goalPaceMinutes: minutes, goalPace: `${minutes}:${String(current.goalPaceSeconds).padStart(2, '0')}`, [`goalPace${prefix}Minutes`]: minutes } })
                  }
                }} />
                <span>分</span>
                <input aria-label="目標ペースの秒" type="number" min="0" max="59" inputMode="numeric" value={paceSecondsInput} onFocus={(event) => event.target.select()} onChange={(event) => {
                  const value = event.target.value
                  setPaceSecondsInput(value)
                  if (value !== '' && Number(value) >= 0 && Number(value) <= 59) {
                    const seconds = Number(value)
                    setSettings((current) => { const prefix = current.activityType === 'walking' ? 'Walking' : 'Running'; return { ...current, goalPaceSeconds: seconds, goalPace: `${current.goalPaceMinutes}:${String(seconds).padStart(2, '0')}`, [`goalPace${prefix}Seconds`]: seconds } })
                  }
                }} />
                <span>秒／km</span>
              </span>
            </label>
            <button type="button" className="primary-button" onClick={() => setPaceSettingsOpen(false)}>決定</button>
          </div>
        </div>
      )}

      {logoutConfirmOpen && (
        <div className="settings-overlay" role="dialog" aria-modal="true">
          <div className="settings-sheet confirm-sheet">
            <h3>ログアウトしますか？</h3>
            <p>保存済みの履歴は削除されません。</p>
            <div className="settings-actions">
              <button type="button" className="logout-button" onClick={handleSignOut}>ログアウトする</button>
              <button type="button" className="secondary-button" onClick={() => setLogoutConfirmOpen(false)}>キャンセル</button>
            </div>
          </div>
        </div>
      )}

      {customDistanceOpen && (
        <div className="settings-overlay" onClick={() => setCustomDistanceOpen(false)}>
          <div className="settings-sheet" onClick={(event) => event.stopPropagation()}>
            <div className="settings-header">
              <h3>カスタム距離</h3>
              <button type="button" className="close-button" onClick={() => setCustomDistanceOpen(false)} aria-label="閉じる">×</button>
            </div>
            <label className="field custom-distance-field">
              <span>今回走る距離</span>
              <span className="distance-input">
                <input
                  aria-label="カスタム距離"
                  type="number"
                  min="1"
                  max="100"
                  step="0.1"
                  inputMode="decimal"
                  value={customDistanceInput}
                  onChange={(event) => setCustomDistanceInput(event.target.value)}
                  placeholder="例：12.5"
                />
                <span>km</span>
              </span>
            </label>
            {customDistanceError && <div className="auth-error">{customDistanceError}</div>}
            <button type="button" className="primary-button" onClick={confirmCustomDistance}>この距離に決める</button>
          </div>
        </div>
      )}

      {finishConfirmOpen && (
        <div className="settings-overlay" role="dialog" aria-modal="true">
          <div className="settings-sheet confirm-sheet">
            <h3>今回の計測を終了しますか？</h3>
            <p>終了すると結果画面で記録を保存できます。</p>
            <div className="settings-actions">
              <button type="button" className="primary-button" onClick={finishRun}>終了する</button>
              <button type="button" className="secondary-button" onClick={() => setFinishConfirmOpen(false)}>運動を続ける</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export default App
