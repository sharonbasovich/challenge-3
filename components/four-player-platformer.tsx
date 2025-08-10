"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Label } from "@/components/ui/label"
import { Separator } from "@/components/ui/separator"
import { Info, Pause, Play, RefreshCw, Settings2 } from "lucide-react"

type Vec2 = { x: number; y: number }
type KeyBinding = { left: string; right: string; jump: string; action: string }
type Player = {
  id: number
  name: string
  color: string
  spawn: Vec2
  pos: Vec2
  vel: Vec2
  w: number
  h: number
  onGround: boolean
  jumpLock: boolean
  alive: boolean
  exitReached: boolean
  controls: KeyBinding
  facing: -1 | 1
  maxAirJumps: number
  airJumpsLeft: number
  // Wind dash
  isDashing: boolean
  dashUntil: number
  dashCooldownUntil: number
  // Ability cooldowns
  abilityCooldownUntil: number
  // FX
  nextStepFxTime?: number
}
type Level = {
  tiles: string[]
  w: number
  h: number
  tileSize: number
  doorOpen: boolean
}

type TempPlatform = { tx: number; ty: number; expiresAt: number }

type Particle = {
  x: number
  y: number
  vx: number
  vy: number
  life: number
  maxLife: number
  size: number
  colorStart: string
  colorEnd: string
  gravity: number
  damping: number
  shape: "circle" | "square"
  additive: boolean
}

// Plate state
type PlateState = {
  tx: number
  ty: number
  pressed: boolean
  pressTime: number
}

const TILE = 32
const GRAVITY = 1800
const MOVE_SPEED = 280
const JUMP_SPEED = 700
const MAX_FALL = 1200
const FRICTION = 0.85
const AIR_DRAG = 0.99

// Swim tuning
const SWIM_SPEED = 180
const SWIM_UP_FORCE = 1800
const SWIM_MAX_UP = -260
const SWIM_MAX_DOWN = 420
const WATER_DRAG_X = 0.92

// Wind dash tuning
const DASH_SPEED = 900
const DASH_DURATION = 0.18
const DASH_COOLDOWN = 3
const DOUBLE_TAP_WINDOW = 250

// Earth cooldown
const EARTH_COOLDOWN = 4 // seconds

const LEVEL_MAP: string[] = [
  "########################################",
  "#.................P....................#",
  "#.................#....................#",
  "#.................#.............bbbb...#",
  "#.................#....................#",
  "#...........#######....................#",
  "#..................#...................#",
  "#.............~~~~~#...................#",
  "#..................#...................#",
  "#...........######Z######..............#",
  "#..................#....#..............#",
  "#......###.........#....#..............#",
  "#..................#..................#",
  "#.1....O..O...2....#....#..............#",
  "#......#####.......#....#..............#",
  "#..................#..................#",
  "#...........######Z######..............#",
  "#..................#...................#",
  "#.....OOOOOO.......#........fane..b....#",
  "#..................#...................#",
  "#......###.........#...................#",
  "#..................#..................#",
  "#...3.........4....P...##OO..A.B.C...D.#",
  "########################################",
]

// Utilities
function clamp(v: number, min: number, max: number) {
  return Math.max(min, Math.min(max, v))
}
function rectIntersect(
  a: { x: number; y: number; w: number; h: number },
  b: { x: number; y: number; w: number; h: number },
) {
  return !(a.x + a.w <= b.x || a.x >= b.x + b.w || a.y + a.h <= b.y || a.y >= b.y + b.h)
}
function worldToTile(x: number, y: number, tileSize: number) {
  return { tx: Math.floor(x / tileSize), ty: Math.floor(y / tileSize) }
}

function createLevel(): Level {
  const h = LEVEL_MAP.length
  const w = LEVEL_MAP[0].length
  return { tiles: LEVEL_MAP.slice(), h, w, tileSize: TILE, doorOpen: false }
}

function findSpawnsAndExits(level: Level) {
  const spawns: Record<number, Vec2> = {
    1: { x: TILE, y: TILE },
    2: { x: TILE, y: TILE },
    3: { x: TILE, y: TILE },
    4: { x: TILE, y: TILE },
  }
  const exits: Record<number, Vec2[]> = { 1: [], 2: [], 3: [], 4: [] }
  for (let y = 0; y < level.h; y++) {
    for (let x = 0; x < level.w; x++) {
      const c = level.tiles[y][x]
      if (c === "1" || c === "2" || c === "3" || c === "4") {
        const idx = Number(c)
        spawns[idx] = { x: x * TILE + TILE / 2, y: y * TILE + TILE / 2 }
        level.tiles[y] = replaceChar(level.tiles[y], x, ".")
      } else if (c === "A" || c === "B" || c === "C" || c === "D") {
        const mapIdx = { A: 1, B: 2, C: 3, D: 4 } as const
        const p = mapIdx[c as keyof typeof mapIdx]
        exits[p].push({ x: x * TILE, y: y * TILE })
      }
    }
  }
  return { spawns, exits }
}

function replaceChar(str: string, index: number, char: string) {
  return str.substring(0, index) + char + str.substring(index + 1)
}

function isSolid(ch: string, doorOpen: boolean) {
  if (ch === "#") return true
  if (ch === "Z") return !doorOpen
  if (ch === "b") return true
  if (ch === "X") return true
  return false
}
function isPlate(ch: string) {
  return ch === "P"
}

// Colored hole helpers
function isColoredHole(ch: string) {
  return ch === "f" || ch === "a" || ch === "e" || ch === "n"
}
function safePlayerForColoredHole(ch: string): 1 | 2 | 3 | 4 | null {
  switch (ch) {
    case "f":
      return 1
    case "a":
      return 2
    case "e":
      return 3
    case "n":
      return 4
    default:
      return null
  }
}
function isLiquidForPlayer(ch: string, playerId: number) {
  if (ch === "W") return true
  if (isColoredHole(ch)) return safePlayerForColoredHole(ch) === (playerId as 1 | 2 | 3 | 4)
  return false
}
function isHazardFor(ch: string, playerId: number) {
  if (ch === "~") return true // poison
  if (ch === "O") return true // dark hole
  if (isColoredHole(ch)) return safePlayerForColoredHole(ch) !== (playerId as 1 | 2 | 3 | 4)
  return false
}

function drawLevel(
  ctx: CanvasRenderingContext2D,
  level: Level,
  gateReached: Partial<Record<1 | 2 | 3 | 4, boolean>> = {},
  plates: Map<string, PlateState> = new Map(),
  now: number = performance.now(),
) {
  const { w, h, tileSize, doorOpen } = level
  for (let y = 0; y < h; y++) {
    const row = level.tiles[y]
    for (let x = 0; x < w; x++) {
      const c = row[x]
      const px = x * tileSize
      const py = y * tileSize
      if (c === "#") {
        ctx.fillStyle = "#3f3f46"
        ctx.fillRect(px, py, tileSize, tileSize)
      } else if (c === "~") {
        ctx.fillStyle = "#16a34a"
        ctx.fillRect(px, py, tileSize, tileSize)
        ctx.fillStyle = "rgba(255,255,255,0.25)"
        ctx.fillRect(px, py + tileSize - 6, tileSize, 3)
      } else if (c === "O") {
        ctx.fillStyle = "#0f172a"
        ctx.fillRect(px, py, tileSize, tileSize)
      } else if (c === "W") {
        ctx.fillStyle = "rgba(14,165,233,0.65)"
        ctx.fillRect(px, py, tileSize, tileSize)
        ctx.fillStyle = "rgba(255,255,255,0.35)"
        ctx.fillRect(px, py + tileSize - 8, tileSize, 3)
      } else if (isColoredHole(c)) {
        const colors: Record<string, string> = {
          f: "#ef4444",
          a: "#14b8a6",
          e: "#92400e",
          n: "#38bdf8",
        }
        ctx.fillStyle = "#0f172a"
        ctx.fillRect(px, py, tileSize, tileSize)
        ctx.strokeStyle = colors[c]
        ctx.lineWidth = 3
        ctx.strokeRect(px + 2, py + 2, tileSize - 4, tileSize - 4)
        ctx.fillStyle = `${colors[c]}55`
        ctx.fillRect(px + 6, py + 6, tileSize - 12, tileSize - 12)
        ctx.fillStyle = "rgba(255,255,255,0.25)"
        ctx.fillRect(px + 4, py + tileSize - 7, tileSize - 8, 3)
      } else if (c === "P") {
        const key = `${x},${y}`
        const st = plates.get(key)
        const pressed = st?.pressed
        // Base plate
        ctx.fillStyle = pressed ? "#22c55e" : "#f59e0b"
        const inset = pressed ? 8 : 6
        ctx.fillRect(px + inset, py + tileSize - inset - 2, tileSize - inset * 2, 6)
        // Button cap
        ctx.fillStyle = pressed ? "#16a34a" : "#b45309"
        ctx.fillRect(px + inset + 2, py + tileSize - inset - 4, tileSize - (inset + 2) * 2, 3)
        // Pulse ring shortly after press
        if (pressed && st) {
          const t = (now - st.pressTime) / 600
          if (t < 1.2) {
            ctx.strokeStyle = "rgba(34,197,94,0.55)"
            ctx.lineWidth = 2
            const r = 4 + t * 12
            ctx.beginPath()
            ctx.arc(px + tileSize / 2, py + tileSize - inset - 3, r, 0, Math.PI * 2)
            ctx.stroke()
          }
        }
      } else if (c === "Z") {
        if (!doorOpen) {
          ctx.fillStyle = "#7c3aed"
          ctx.fillRect(px, py, tileSize, tileSize)
          ctx.fillStyle = "#a78bfa"
          ctx.fillRect(px + 6, py + 6, tileSize - 12, tileSize - 12)
        } else {
          ctx.strokeStyle = "rgba(124,58,237,0.4)"
          ctx.strokeRect(px + 4, py + 4, tileSize - 8, tileSize - 8)
        }
      } else if (c === "b") {
        ctx.fillStyle = "#dc2626"
        ctx.fillRect(px, py, tileSize, tileSize)
        ctx.fillStyle = "#fecaca"
        ctx.fillRect(px + 6, py + 6, tileSize - 12, tileSize - 12)
      } else if (c === "X") {
        ctx.fillStyle = "#92400e"
        ctx.fillRect(px, py, tileSize, tileSize)
        ctx.strokeStyle = "#f59e0b"
        ctx.strokeRect(px + 4, py + 4, tileSize - 8, tileSize - 8)
      } else if (c === "A" || c === "B" || c === "C" || c === "D") {
        const gateColors: Record<string, { main: string; inner: string }> = {
          A: { main: "#ef4444", inner: "#fecaca" },
          B: { main: "#14b8a6", inner: "#99f6e4" },
          C: { main: "#92400e", inner: "#f59e0b" },
          D: { main: "#38bdf8", inner: "#bae6fd" },
        }
        const gc = gateColors[c]
        ctx.fillStyle = gc.main
        ctx.fillRect(px, py, tileSize, tileSize)
        ctx.fillStyle = gc.inner
        ctx.fillRect(px + 5, py + 5, tileSize - 10, tileSize - 10)
        ctx.strokeStyle = "rgba(0,0,0,0.25)"
        ctx.lineWidth = 2
        for (let i = 0; i < 3; i++) {
          const gx = px + 8 + i * 8
          ctx.beginPath()
          ctx.moveTo(gx, py + 4)
          ctx.lineTo(gx, py + tileSize - 4)
          ctx.stroke()
        }
        const charToId: Record<string, 1 | 2 | 3 | 4> = { A: 1, B: 2, C: 3, D: 4 }
        const pid = charToId[c]
        if (gateReached[pid]) {
          ctx.strokeStyle = "rgba(0,0,0,0.6)"
          ctx.lineCap = "round"
          ctx.lineJoin = "round"
          ctx.lineWidth = 6
          ctx.beginPath()
          ctx.moveTo(px + 7, py + tileSize - 10)
          ctx.lineTo(px + tileSize / 2 - 2, py + tileSize - 7)
          ctx.lineTo(px + tileSize - 7, py + 8)
          ctx.stroke()
          ctx.strokeStyle = "#ffffff"
          ctx.lineWidth = 3.5
          ctx.beginPath()
          ctx.moveTo(px + 7, py + tileSize - 10)
          ctx.lineTo(px + tileSize / 2 - 2, py + tileSize - 7)
          ctx.lineTo(px + tileSize - 7, py + 8)
          ctx.stroke()
        }
      }
    }
  }

function useKeySet() {
  const pressed = useRef<Set<string>>(new Set())
  const lastDown = useRef<Map<string, number>>(new Map())
  const doubleTap = useRef<Set<string>>(new Set())

  useEffect(() => {
    const onDown = (e: KeyboardEvent) => {
      const blockKeys = ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", " "]
      if (blockKeys.includes(e.key)) e.preventDefault()
      if (!e.repeat) {
        const now = performance.now()
        const last = lastDown.current.get(e.key) ?? 0
        if (now - last <= DOUBLE_TAP_WINDOW) {
          doubleTap.current.add(e.key)
        }
        lastDown.current.set(e.key, now)
      }
      pressed.current.add(e.key)
    }
    const onUp = (e: KeyboardEvent) => {
      pressed.current.delete(e.key)
    }
    window.addEventListener("keydown", onDown, { passive: false })
    window.addEventListener("keyup", onUp)
    return () => {
      window.removeEventListener("keydown", onDown as any)
      window.removeEventListener("keyup", onUp as any)
    }
  }, [])

  return { pressed, doubleTap }
}

function createPlayers(spawns: Record<number, Vec2>, controls: Record<number, KeyBinding>): Player[] {
  const size = { w: 22, h: 28 }
  const mk = (id: number, name: string, color: string, maxAirJumps: number): Player => ({
    id,
    name,
    color,
    spawn: { x: spawns[id].x, y: spawns[id].y },
    pos: { x: spawns[id].x, y: spawns[id].y },
    vel: { x: 0, y: 0 },
    w: size.w,
    h: size.h,
    onGround: false,
    jumpLock: false,
    alive: true,
    exitReached: false,
    controls: controls[id],
    facing: 1,
    maxAirJumps,
    airJumpsLeft: maxAirJumps,
    isDashing: false,
    dashUntil: 0,
    dashCooldownUntil: 0,
    abilityCooldownUntil: 0,
    nextStepFxTime: 0,
  })
  return [
    mk(1, "Fire", "#ef4444", 0),
    mk(2, "Water", "#14b8a6", 0),
    mk(3, "Earth", "#92400e", 0),
    mk(4, "Wind", "#38bdf8", 0),
  ]
}

function solidAt(level: Level, x: number, y: number) {
  const { tx, ty } = worldToTile(x, y, level.tileSize)
  return isSolid(tileAt(level, tx, ty), level.doorOpen)
}
function tileCharAt(level: Level, x: number, y: number) {
  const { tx, ty } = worldToTile(x, y, level.tileSize)
  return tileAt(level, tx, ty)
}
function tileAt(level: Level, tx: number, ty: number) {
  if (ty < 0 || ty >= level.h || tx < 0 || tx >= level.w) return "#"
  return level.tiles[ty][tx]
}
function setTile(level: Level, tx: number, ty: number, ch: string) {
  if (ty < 0 || ty >= level.h || tx < 0 || tx >= level.w) return
  level.tiles[ty] = replaceChar(level.tiles[ty], tx, ch)
}

function drawPlayer(ctx: CanvasRenderingContext2D, p: Player) {
  const { x, y } = p.pos
  ctx.save()
  ctx.translate(x, y)
  ctx.fillStyle = p.color
  ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h)
  ctx.fillStyle = "#0b0b0b"
  ctx.fillRect(-p.w / 4, -p.h / 4, 4, 4)
  ctx.fillRect(p.w / 4 - 4, -p.h / 4, 4, 4)
  ctx.fillStyle = "rgba(0,0,0,0.2)"
  ctx.fillRect(-p.w / 2, p.h / 2 - 2, p.w, 4)
  ctx.fillStyle = "rgba(255,255,255,0.5)"
  ctx.fillRect(p.facing === 1 ? p.w / 2 - 2 : -p.w / 2 - 2, -p.h / 4, 2, p.h / 2)
  ctx.restore()
}

// Audio synthesis
function useSound() {
  const ctxRef = useRef<AudioContext | null>(null)
  function ensureCtx() {
    if (typeof window === "undefined") return null
    if (!ctxRef.current) {
      const Ctx = (window as any).AudioContext || (window as any).webkitAudioContext
      if (!Ctx) return null
      ctxRef.current = new Ctx()
    }
    if (ctxRef.current?.state === "suspended") ctxRef.current.resume()
    return ctxRef.current
  }
  function makeGain(ctx: AudioContext, value: number) {
    const g = ctx.createGain()
    g.gain.value = value
    g.connect(ctx.destination)
    return g
  }
  function playNoiseBurst({
    duration = 0.15,
    volume = 0.25,
    type = "white",
    filterType,
    filterFreq,
    decay = 0.15,
  }: {
    duration?: number
    volume?: number
    type?: "white" | "pink"
    filterType?: BiquadFilterType
    filterFreq?: number
    decay?: number
  }) {
    const ctx = ensureCtx()
    if (!ctx) return
    const bufferSize = Math.floor(duration * ctx.sampleRate)
    const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate)
    const data = buffer.getChannelData(0)
    let pink = 0
    for (let i = 0; i < bufferSize; i++) {
      const white = Math.random() * 2 - 1
      if (type === "pink") {
        pink = 0.98 * pink + 0.02 * white
        data[i] = pink
      } else {
        data[i] = white
      }
    }
    const src = ctx.createBufferSource()
    src.buffer = buffer
    let node: AudioNode = src
    if (filterType) {
      const filt = ctx.createBiquadFilter()
      filt.type = filterType
      filt.frequency.value = filterFreq ?? 800
      node.connect(filt)
      node = filt
    }
    const gain = ctx.createGain()
    gain.gain.value = volume
    node.connect(gain)
    gain.connect(ctx.destination)
    const now = ctx.currentTime
    gain.gain.setValueAtTime(volume, now)
    gain.gain.exponentialRampToValueAtTime(0.0001, now + decay)
    src.start()
    src.stop(now + duration)
  }
  function playTone({
    freq = 400,
    duration = 0.12,
    volume = 0.2,
    type = "sine",
    sweep = 0,
  }: {
    freq?: number
    duration?: number
    volume?: number
    type?: OscillatorType
    sweep?: number
  }) {
    const ctx = ensureCtx()
    if (!ctx) return
    const osc = ctx.createOscillator()
    const gain = makeGain(ctx, volume)
    osc.type = type
    const now = ctx.currentTime
    osc.frequency.setValueAtTime(freq, now)
    if (sweep !== 0) osc.frequency.linearRampToValueAtTime(freq + sweep, now + duration)
    gain.gain.setValueAtTime(0.0001, now)
    gain.gain.exponentialRampToValueAtTime(volume, now + 0.01)
    gain.gain.exponentialRampToValueAtTime(0.0001, now + duration)
    osc.connect(gain)
    osc.start()
    osc.stop(now + duration + 0.02)
  }
  return {
    fireBreak: () => {
      playNoiseBurst({
        duration: 0.12,
        volume: 0.3,
        type: "pink",
        filterType: "bandpass",
        filterFreq: 1200,
        decay: 0.12,
      })
      playTone({ freq: 600, duration: 0.08, volume: 0.12, type: "triangle", sweep: -200 })
    },
    waterSplash: () => {
      playNoiseBurst({
        duration: 0.18,
        volume: 0.25,
        type: "white",
        filterType: "lowpass",
        filterFreq: 1500,
        decay: 0.18,
      })
      playTone({ freq: 700, duration: 0.15, volume: 0.08, type: "sine", sweep: -500 })
    },
    earthThud: () => playTone({ freq: 140, duration: 0.12, volume: 0.2, type: "sine", sweep: -40 }),
    windDash: () => {
      playNoiseBurst({
        duration: 0.2,
        volume: 0.22,
        type: "white",
        filterType: "highpass",
        filterFreq: 800,
        decay: 0.2,
      })
    },
    jump: () => playTone({ freq: 420, duration: 0.08, volume: 0.07, type: "square", sweep: 60 }),
    platePress: () => playTone({ freq: 900, duration: 0.1, volume: 0.14, type: "triangle", sweep: -200 }),
  }
}

// Particles helpers
function lerp(a: number, b: number, t: number) {
  return a + (b - a) * t
}
function hexToRgb(hex: string) {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex)
  if (!m) return { r: 255, g: 255, b: 255 }
  return { r: Number.parseInt(m[1], 16), g: Number.parseInt(m[2], 16), b: Number.parseInt(m[3]) }
}
function parseColor(c: string) {
  if (c.startsWith("#")) return hexToRgb(c)
  const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(c)
  if (!m) return { r: 255, g: 255, b: 255 }
  return { r: Number.parseInt(m[1]), g: Number.parseInt(m[2]), b: Number.parseInt(m[3]) }
}

export default function FourPlayerPlatformer() {
  // Controls
  const [bindings, setBindings] = useState<Record<number, KeyBinding>>({
    1: { left: "a", right: "d", jump: "w", action: "s" },
    2: { left: "j", right: "l", jump: "i", action: "k" },
    3: { left: "ArrowLeft", right: "ArrowRight", jump: "ArrowUp", action: "ArrowDown" },
    4: { left: "z", right: "c", jump: "x", action: "" },
  })
  const [showSettings, setShowSettings] = useState(false)
  const [showHelp, setShowHelp] = useState(false)

  const modalCountRef = useRef(0)
  const pausedBeforeModalRef = useRef(false)
  const handleModalOpenChange = useCallback(
    (next: boolean, which: "settings" | "help") => {
      const prevCount = modalCountRef.current
      const nextCount = prevCount + (next ? 1 : -1)
      modalCountRef.current = nextCount
      if (next && prevCount === 0) {
        pausedBeforeModalRef.current = paused
        setPaused(true)
      }
      if (!next && nextCount === 0) {
        setPaused(pausedBeforeModalRef.current)
      }
      if (which === "settings") setShowSettings(next)
      else setShowHelp(next)
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  )

  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const wrapperRef = useRef<HTMLDivElement | null>(null)
  const input = useKeySet()
  const sound = useSound()

  const levelRef = useRef<Level>(createLevel())
  const { spawns, exits } = useMemo(() => findSpawnsAndExits(levelRef.current), [])
  const playersRef = useRef<Player[]>(createPlayers(spawns, bindings))

  // Plate states
  const platesRef = useRef<Map<string, PlateState>>(new Map())
  function initPlates(level: Level) {
    const m = new Map<string, PlateState>()
    for (let y = 0; y < level.h; y++) {
      for (let x = 0; x < level.w; x++) {
        if (level.tiles[y][x] === "P") {
          m.set(`${x},${y}`, { tx: x, ty: y, pressed: false, pressTime: 0 })
        }
      }
    }
    platesRef.current = m
  }
  useEffect(() => {
    initPlates(levelRef.current)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Particles
  const particlesRef = useRef<Particle[]>([])
  const MAX_PARTICLES = 4000

  // update controls if bindings change
  const tempPlatformsRef = useRef<TempPlatform[]>([])
  const prevActionDownRef = useRef<Record<number, boolean>>({ 1: false, 2: false, 3: false, 4: false })

  useEffect(() => {
    playersRef.current = playersRef.current.map((p) => ({
      ...p,
      controls: bindings[p.id],
    }))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bindings])

  const [paused, setPaused] = useState(false)
  const [won, setWon] = useState(false)
  const [deaths, setDeaths] = useState(0)

  const lastTimeRef = useRef<number>(0)
  const rafRef = useRef<number>(0)

  const resizeCanvas = useCallback(() => {
    const wrap = wrapperRef.current
    const canvas = canvasRef.current
    if (!wrap || !canvas) return
    const level = levelRef.current
    const targetW = level.w * level.tileSize
    const targetH = level.h * level.tileSize
    const maxW = wrap.clientWidth
    const maxH = wrap.clientHeight
    const scale = Math.min(maxW / targetW, maxH / targetH)
    const cssW = Math.floor(targetW * scale)
    const cssH = Math.floor(targetH * scale)
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    canvas.style.width = cssW + "px"
    canvas.style.height = cssH + "px"
    canvas.width = Math.floor(targetW * dpr)
    canvas.height = Math.floor(targetH * dpr)
    const ctx = canvas.getContext("2d")
    if (ctx) ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  }, [])

  useEffect(() => {
    resizeCanvas()
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(() => resizeCanvas()) : null
    if (ro && wrapperRef.current) ro.observe(wrapperRef.current)
    window.addEventListener("resize", resizeCanvas)
    return () => {
      window.removeEventListener("resize", resizeCanvas)
      ro?.disconnect()
    }
  }, [resizeCanvas])

  const resetGame = useCallback(() => {
    const level = createLevel()
    levelRef.current = level
    tempPlatformsRef.current = []
    initPlates(level)
    const fresh = createPlayers(spawns, bindings)
    playersRef.current = fresh
    prevActionDownRef.current = { 1: false, 2: false, 3: false, 4: false }
    particlesRef.current = []
    setWon(false)
    setDeaths(0)
    setPaused(false)
    lastTimeRef.current = performance.now()
  }, [bindings, spawns])

  // keyboard: R reset, P/Esc toggle pause
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() === "r") {
        e.preventDefault()
        resetGame()
      } else if (e.key.toLowerCase() === "p" || e.key === "Escape") {
        e.preventDefault()
        setPaused((p) => !p)
      }
    }
    window.addEventListener("keydown", handler)
    return () => window.removeEventListener("keydown", handler)
  }, [resetGame])

  function updateDoorOpen(level: Level, players: Player[]) {
    // Keep the door logic as "2 players currently standing on plates"
    let onPlates = 0
    for (const p of players) {
      const ch = tileCharAt(level, p.pos.x, p.pos.y + p.h / 2 + 1)
      if (isPlate(ch)) onPlates++
    }
    level.doorOpen = onPlates >= 2
  }

  // Particle spawners
  function spawnFireBurstAt(x: number, y: number) {
    const count = 18 * 5
    for (let i = 0; i < count; i++) {
      const a = Math.random() * Math.PI * 2
      const sp = 120 + Math.random() * 220
      particlesRef.current.push({
        x,
        y,
        vx: Math.cos(a) * sp,
        vy: Math.sin(a) * sp - 60,
        life: 0,
        maxLife: 0.3 + Math.random() * 0.25,
        size: 4 + Math.random() * 6,
        colorStart: "#f97316",
        colorEnd: "#ef4444",
        gravity: 600,
        damping: 0.92,
        shape: "square",
        additive: true,
      })
    }
  }
  function spawnWaterSplashAt(x: number, y: number) {
    const count = 22 * 5
    for (let i = 0; i < count; i++) {
      const a = -Math.PI / 2 + (Math.random() - 0.5) * Math.PI * 0.8
      const sp = 180 + Math.random() * 200
      particlesRef.current.push({
        x,
        y,
        vx: Math.cos(a) * sp,
        vy: Math.sin(a) * sp,
        life: 0,
        maxLife: 0.35 + Math.random() * 0.25,
        size: 4 + Math.random() * 4,
        colorStart: "rgba(56,189,248,0.9)",
        colorEnd: "rgba(125,211,252,0.1)",
        gravity: 900,
        damping: 0.9,
        shape: "circle",
        additive: false,
      })
    }
  }
  function spawnEarthDustAt(x: number, y: number) {
    const count = 16 * 5
    for (let i = 0; i < count; i++) {
      const a = (Math.random() - 0.5) * Math.PI
      const sp = 90 + Math.random() * 140
      particlesRef.current.push({
        x,
        y,
        vx: Math.cos(a) * sp,
        vy: -Math.abs(Math.sin(a) * sp) - 50,
        life: 0,
        maxLife: 0.4 + Math.random() * 0.3,
        size: 6 + Math.random() * 6,
        colorStart: "#92400e",
        colorEnd: "#f59e0b",
        gravity: 1000,
        damping: 0.88,
        shape: "square",
        additive: false,
      })
    }
  }
  function spawnEarthCrumbleAt(x: number, y: number) {
    const count = 24 * 5
    for (let i = 0; i < count; i++) {
      const a = Math.random() * Math.PI * 2
      const sp = 60 + Math.random() * 180
      particlesRef.current.push({
        x,
        y,
        vx: Math.cos(a) * sp,
        vy: Math.sin(a) * sp - 40,
        life: 0,
        maxLife: 0.45 + Math.random() * 0.35,
        size: 4 + Math.random() * 4,
        colorStart: "#92400e",
        colorEnd: "rgba(245,158,11,0.1)",
        gravity: 1100,
        damping: 0.9,
        shape: "square",
        additive: false,
      })
    }
  }
  function spawnWindTrailAt(x: number, y: number, color: string) {
    const count = 3 * 5
    for (let i = 0; i < count; i++) {
      const a = Math.random() * Math.PI * 2
      const sp = 30 + Math.random() * 60
      particlesRef.current.push({
        x,
        y,
        vx: Math.cos(a) * sp,
        vy: Math.sin(a) * sp,
        life: 0,
        maxLife: 0.25 + Math.random() * 0.2,
        size: 6 + Math.random() * 6,
        colorStart: color,
        colorEnd: "rgba(56,189,248,0.0)",
        gravity: 0,
        damping: 0.9,
        shape: "circle",
        additive: true,
      })
    }
  }
  function spawnPlatePressAt(x: number, y: number) {
    const count = 14
    for (let i = 0; i < count; i++) {
      const a = Math.random() * Math.PI * 2
      const sp = 60 + Math.random() * 140
      particlesRef.current.push({
        x,
        y,
        vx: Math.cos(a) * sp,
        vy: Math.sin(a) * sp - 20,
        life: 0,
        maxLife: 0.35 + Math.random() * 0.2,
        size: 6 + Math.random() * 6,
        colorStart: "#22c55e",
        colorEnd: "rgba(34,197,94,0.05)",
        gravity: 900,
        damping: 0.88,
        shape: "circle",
        additive: false,
      })
    }
  }
  // Footsteps
  function spawnFireStep(x: number, y: number, dir: number) {
    const count = 4 * 5
    for (let i = 0; i < count; i++) {
      particlesRef.current.push({
        x: x - dir * (4 + Math.random() * 4),
        y,
        vx: (Math.random() - 0.6) * 70 - dir * 20,
        vy: -40 - Math.random() * 40,
        life: 0,
        maxLife: 0.28 + Math.random() * 0.16,
        size: 4 + Math.random() * 4,
        colorStart: "#fb923c",
        colorEnd: "rgba(239,68,68,0.1)",
        gravity: 500,
        damping: 0.9,
        shape: "square",
        additive: true,
      })
    }
  }
  function spawnWaterStep(x: number, y: number, dir: number) {
    const count = 5 * 5
    for (let i = 0; i < count; i++) {
      particlesRef.current.push({
        x: x - dir * (4 + Math.random() * 4),
        y,
        vx: (Math.random() - 0.5) * 60 - dir * 10,
        vy: -30 - Math.random() * 30,
        life: 0,
        maxLife: 0.32 + Math.random() * 0.18,
        size: 4 + Math.random() * 4,
        colorStart: "rgba(14,165,233,0.9)",
        colorEnd: "rgba(125,211,252,0.05)",
        gravity: 800,
        damping: 0.9,
        shape: "circle",
        additive: false,
      })
    }
  }
  function spawnEarthStep(x: number, y: number, dir: number) {
    const count = 5 * 5
    for (let i = 0; i < count; i++) {
      particlesRef.current.push({
        x: x - dir * (4 + Math.random() * 4),
        y,
        vx: (Math.random() - 0.5) * 80 - dir * 15,
        vy: -20 - Math.random() * 30,
        life: 0,
        maxLife: 0.35 + Math.random() * 0.2,
        size: 4 + Math.random() * 6,
        colorStart: "#92400e",
        colorEnd: "rgba(245,158,11,0.05)",
        gravity: 900,
        damping: 0.88,
        shape: "square",
        additive: false,
      })
    }
  }
  function spawnWindStep(x: number, y: number, dir: number) {
    const count = 4 * 5
    for (let i = 0; i < count; i++) {
      particlesRef.current.push({
        x: x - dir * (4 + Math.random() * 4),
        y,
        vx: (Math.random() - 0.5) * 60 - dir * 10,
        vy: -10 - Math.random() * 20,
        life: 0,
        maxLife: 0.25 + Math.random() * 0.15,
        size: 4 + Math.random() * 4,
        colorStart: "rgba(56,189,248,0.6)",
        colorEnd: "rgba(56,189,248,0.0)",
        gravity: 0,
        damping: 0.92,
        shape: "circle",
        additive: true,
      })
    }
  }
  function trimParticles() {
    if (particlesRef.current.length > MAX_PARTICLES) {
      particlesRef.current.splice(0, particlesRef.current.length - MAX_PARTICLES)
    }
  }

  function doFireAction(level: Level, p: Player) {
    const aheadX = p.pos.x + p.facing * (p.w / 2 + 4)
    const aheadY = p.pos.y
    const { tx: tx1, ty: ty1 } = worldToTile(aheadX, aheadY, level.tileSize)
    const { tx: tx2, ty: ty2 } = worldToTile(p.pos.x, p.pos.y, level.tileSize)
    const candidates: Array<[number, number]> = [
      [tx1, ty1],
      [tx2, ty2],
      [tx2, ty2 + 1],
      [tx2, ty2 - 1],
    ]
    let brokeAny = false
    for (const [tx, ty] of candidates) {
      const ch = tileAt(level, tx, ty)
      if (ch === "b" || ch === "X") {
        setTile(level, tx, ty, ".")
        const cx = tx * TILE + TILE / 2
        const cy = ty * TILE + TILE / 2
        spawnFireBurstAt(cx, cy)
        if (ch === "X") spawnEarthCrumbleAt(cx, cy)
        brokeAny = true
      }
    }
    if (brokeAny) sound.fireBreak()
    tempPlatformsRef.current = tempPlatformsRef.current.filter((tp) => tileAt(level, tp.tx, tp.ty) === "X")
    trimParticles()
  }

  function doWaterAction(level: Level, p: Player) {
    const start = worldToTile(p.pos.x, p.pos.y, level.tileSize)
    // Seed from any dark holes in the 3x3 around the player (including diagonals)
    const seeds: Array<{ tx: number; ty: number }> = []
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const ux = start.tx + dx
        const uy = start.ty + dy
        if (tileAt(level, ux, uy) === "O") {
          seeds.push({ tx: ux, ty: uy })
        }
      }
    }
    if (seeds.length === 0) return

    // Flood fill across all connected dark holes (8-direction adjacency)
    const q: Array<{ tx: number; ty: number }> = [...seeds]
    const seen = new Set<string>(seeds.map((s) => `${s.tx},${s.ty}`))
    const dirs8 = [
      [-1, -1],
      [0, -1],
      [1, -1],
      [-1, 0],
      [1, 0],
      [-1, 1],
      [0, 1],
      [1, 1],
    ]
    let convertedCount = 0
    const maxFill = 2000 // safety cap
    while (q.length && convertedCount < maxFill) {
      const { tx, ty } = q.shift()!
      if (tileAt(level, tx, ty) !== "O") continue
      setTile(level, tx, ty, "W")
      convertedCount++
      const cx = tx * TILE + TILE / 2
      const cy = ty * TILE + TILE / 2
      spawnWaterSplashAt(cx, cy)

      for (const [dx, dy] of dirs8) {
        const nx = tx + dx
        const ny = ty + dy
        const key = `${nx},${ny}`
        if (!seen.has(key) && tileAt(level, nx, ny) === "O") {
          seen.add(key)
          q.push({ tx: nx, ty: ny })
        }
      }
    }
    if (convertedCount > 0) {
      sound.waterSplash()
      trimParticles()
    }
  }

  // returns true if a platform was placed (for cooldown)
  function doEarthAction(level: Level, p: Player): boolean {
    const now = performance.now()
    const under = worldToTile(p.pos.x, p.pos.y + p.h / 2 + 4, level.tileSize)
    const ahead = worldToTile(p.pos.x + p.facing * (p.w / 2 + 8), p.pos.y, level.tileSize)
    const canPlace = (tx: number, ty: number) => {
      const ch = tileAt(level, tx, ty)
      return ch === "." || ch === "O" || ch === "W" || isColoredHole(ch)
    }
    let placedAt: { tx: number; ty: number } | null = null
    if (canPlace(under.tx, under.ty)) {
      setTile(level, under.tx, under.ty, "X")
      tempPlatformsRef.current.push({ tx: under.tx, ty: under.ty, expiresAt: now + 7000 })
      placedAt = { tx: under.tx, ty: under.ty }
    } else if (canPlace(ahead.tx, ahead.ty)) {
      setTile(level, ahead.tx, ahead.ty, "X")
      tempPlatformsRef.current.push({ tx: ahead.tx, ty: ahead.ty, expiresAt: now + 7000 })
      placedAt = { tx: ahead.tx, ty: ahead.ty }
    }
    if (placedAt) {
      sound.earthThud()
      const cx = placedAt.tx * TILE + TILE / 2
      const cy = placedAt.ty * TILE + TILE / 2
      spawnEarthDustAt(cx, cy)
      if (tempPlatformsRef.current.length > 12) {
        const oldest = tempPlatformsRef.current.shift()
        if (oldest) {
          const ocx = oldest.tx * TILE + TILE / 2
          const ocy = oldest.ty * TILE + TILE / 2
          spawnEarthCrumbleAt(ocx, ocy)
          setTile(level, oldest.tx, oldest.ty, ".")
        }
      }
      trimParticles()
      return true
    }
    return false
  }

  function moveAndCollide(level: Level, p: Player, dt: number) {
    let nx = p.pos.x + p.vel.x * dt
    let ny = p.pos.y + p.vel.y * dt

    const halfW = p.w / 2
    const halfH = p.h / 2

    // Horizontal collision
    if (p.vel.x > 0) {
      if (solidAt(level, nx + halfW, p.pos.y - halfH) || solidAt(level, nx + halfW, p.pos.y + halfH - 1)) {
        const tx = Math.floor((nx + halfW) / level.tileSize)
        nx = tx * level.tileSize - halfW - 0.01
        p.vel.x = 0
      }
    } else if (p.vel.x < 0) {
      if (solidAt(level, nx - halfW, p.pos.y - halfH) || solidAt(level, nx - halfW, p.pos.y + halfH - 1)) {
        const tx = Math.floor((nx - halfW) / level.tileSize) + 1
        nx = tx * level.tileSize + halfW + 0.01
        p.vel.x = 0
      }
    }

    // Vertical collision
    p.onGround = false
    if (p.vel.y > 0) {
      if (solidAt(level, nx - halfW + 1, ny + halfH) || solidAt(level, nx + halfW - 1, ny + halfH)) {
        const ty = Math.floor((ny + halfH) / level.tileSize)
        ny = ty * level.tileSize - halfH - 0.01
        p.vel.y = 0
        p.onGround = true
        p.jumpLock = false
        p.airJumpsLeft = p.maxAirJumps
      }
    } else if (p.vel.y < 0) {
      if (solidAt(level, nx - halfW + 1, ny - halfH) || solidAt(level, nx + halfW - 1, ny - halfH)) {
        const ty = Math.floor((ny - halfH) / level.tileSize) + 1
        ny = ty * level.tileSize + halfH + 0.01
        p.vel.y = 0
      }
    }

    p.pos.x = nx
    p.pos.y = ny
  }

  function tryStartWindDash(p: Player) {
    if (p.id !== 4) return
    const now = performance.now()
    const { left, right, jump } = p.controls
    const dtap = input.doubleTap.current
    if (now < p.dashCooldownUntil) {
      dtap.delete(left)
      dtap.delete(right)
      dtap.delete(jump)
      return
    }
    if (p.isDashing) return
    const tappedKey = [left, right, jump].find((k) => dtap.has(k))
    if (!tappedKey) return
    dtap.delete(tappedKey)
    const pressed = input.pressed.current
    let dx = tappedKey === left ? -1 : tappedKey === right ? 1 : 0
    let dy = tappedKey === jump ? -1 : 0
    if (pressed.has(left)) dx -= 1
    if (pressed.has(right)) dx += 1
    if (pressed.has(jump)) dy -= 1
    const len = Math.hypot(dx, dy)
    if (len === 0) {
      dx = p.facing
      dy = 0
    } else {
      dx /= len
      dy /= len
    }
    p.isDashing = true
    p.dashUntil = now + DASH_DURATION * 1000
    p.dashCooldownUntil = now + DASH_COOLDOWN * 1000
    p.vel.x = dx * DASH_SPEED
    p.vel.y = dy * DASH_SPEED
    sound.windDash()
    spawnWindTrailAt(p.pos.x, p.pos.y, "#38bdf8")
    trimParticles()
  }

  function pressPlateIfStanding(level: Level, p: Player) {
    // Check center and feet tiles for a plate and latch it
    const center = worldToTile(p.pos.x, p.pos.y, level.tileSize)
    const feet = worldToTile(p.pos.x, p.pos.y + p.h / 2 + 2, level.tileSize)
    const candidates = [center, feet]
    for (const { tx, ty } of candidates) {
      if (tileAt(level, tx, ty) === "P") {
        const key = `${tx},${ty}`
        const m = platesRef.current
        const st = m.get(key)
        if (st && !st.pressed) {
          st.pressed = true
          st.pressTime = performance.now()
          m.set(key, st)
          const cx = tx * TILE + TILE / 2
          const cy = ty * TILE + TILE / 2
          spawnPlatePressAt(cx, cy)
          sound.platePress()
          trimParticles()
        }
      }
    }
  }

  function updatePlayer(level: Level, p: Player, dt: number) {
    const pressed = input.pressed.current
    const { left, right, jump, action } = p.controls
    const leftDown = pressed.has(left)
    const rightDown = pressed.has(right)
    const jumpDown = pressed.has(jump)
    const actionDown = action ? pressed.has(action) : false
    const prevAction = prevActionDownRef.current[p.id] || false
    const justPressedAction = actionDown && !prevAction
    prevActionDownRef.current[p.id] = actionDown

    // Liquids
    const centerChar = tileCharAt(level, p.pos.x, p.pos.y)
    const inLiquid = isLiquidForPlayer(centerChar, p.id)

    // Wind dash
    if (p.id === 4) {
      const now = performance.now()
      if (p.isDashing && now >= p.dashUntil) {
        p.isDashing = false
      }
      if (!p.isDashing) {
        tryStartWindDash(p)
      } else {
        spawnWindTrailAt(p.pos.x, p.pos.y, "rgba(56,189,248,0.5)")
      }
    }

    // Horizontal movement
    if (!p.isDashing) {
      const speed = inLiquid ? SWIM_SPEED : MOVE_SPEED
      if (leftDown && !rightDown) {
        p.vel.x = -speed
        p.facing = -1
      } else if (rightDown && !leftDown) {
        p.vel.x = speed
        p.facing = 1
      } else {
        if (p.onGround && !inLiquid) p.vel.x *= FRICTION
        else p.vel.x *= inLiquid ? WATER_DRAG_X : AIR_DRAG
        if (Math.abs(p.vel.x) < 6) p.vel.x = 0
      }
    }

    // Vertical physics
    if (!p.isDashing) {
      if (inLiquid) {
        p.vel.y += GRAVITY * 0.15 * dt
        if (jumpDown) p.vel.y -= SWIM_UP_FORCE * dt
        p.vel.y = clamp(p.vel.y, SWIM_MAX_UP, SWIM_MAX_DOWN)
      } else {
        p.vel.y += GRAVITY * dt
        p.vel.y = clamp(p.vel.y, -JUMP_SPEED, MAX_FALL)
      }
    }

    // Jump (on land)
    if (!p.isDashing && !inLiquid) {
      if (jumpDown) {
        if (p.onGround && !p.jumpLock) {
          p.vel.y = -JUMP_SPEED
          p.onGround = false
          p.jumpLock = true
          if (p.id !== 4) sound.jump()
        } else if (!p.onGround && p.airJumpsLeft > 0) {
          p.vel.y = -JUMP_SPEED * 0.9
          p.airJumpsLeft -= 1
        }
      }
      if (!jumpDown && p.onGround) {
        p.jumpLock = false
      }
    }

    moveAndCollide(level, p, dt)

    // Plate press check
    pressPlateIfStanding(level, p)

    // Hazard check: kill if center or feet tile is hazardous (fix side-entry issue)
    const belowChar = tileCharAt(level, p.pos.x, p.pos.y + p.h / 2 + 2)
    if (isHazardFor(centerChar, p.id) || isHazardFor(belowChar, p.id)) {
      p.pos = { x: p.spawn.x, y: p.spawn.y }
      p.vel = { x: 0, y: 0 }
      p.alive = true
      p.exitReached = false
      p.airJumpsLeft = p.maxAirJumps
      p.isDashing = false
      p.dashUntil = 0
      setDeaths((d) => d + 1)
    }

    // Abilities
    if (justPressedAction) {
      if (p.id === 1) {
        doFireAction(level, p)
      } else if (p.id === 2) {
        doWaterAction(level, p)
      } else if (p.id === 3) {
        const now = performance.now()
        if (now >= p.abilityCooldownUntil) {
          const placed = doEarthAction(level, p)
          if (placed) {
            p.abilityCooldownUntil = now + EARTH_COOLDOWN * 1000
          }
        }
      }
    }

    // Step particles
    const now = performance.now()
    const speedX = Math.abs(p.vel.x)
    const stepThreshold = 60
    if (!inLiquid && p.onGround && !p.isDashing && speedX > stepThreshold && (p.nextStepFxTime ?? 0) <= now) {
      const dir = p.vel.x === 0 ? p.facing : p.vel.x > 0 ? 1 : -1
      const footY = p.pos.y + p.h / 2 - 2
      const footX = p.pos.x
      if (p.id === 1) spawnFireStep(footX, footY, dir)
      else if (p.id === 2) spawnWaterStep(footX, footY, dir)
      else if (p.id === 3) spawnEarthStep(footX, footY, dir)
      else if (p.id === 4) spawnWindStep(footX, footY, dir)
      p.nextStepFxTime = now + 90
      trimParticles()
    }

    // Exit check (still set exitReached for UI; win gating handled globally)
    const exitList = exits[p.id]
    p.exitReached = false
    for (const ex of exitList) {
      const rectE = { x: ex.x, y: ex.y, w: level.tileSize, h: level.tileSize }
      const rectP = { x: p.pos.x - p.w / 2, y: p.pos.y - p.h / 2, w: p.w, h: p.h }
      if (rectIntersect(rectP, rectE)) {
        p.exitReached = true
        break
      }
    }
  }

  function updateParticles(dt: number) {
    const arr = particlesRef.current
    for (let i = arr.length - 1; i >= 0; i--) {
      const p = arr[i]
      p.life += dt
      if (p.life >= p.maxLife) {
        arr.splice(i, 1)
        continue
      }
      p.vx *= p.damping
      p.vy = p.vy * p.damping + p.gravity * dt
      p.x += p.vx * dt
      p.y += p.vy * dt
    }
  }

  // Main loop
  const loop = useCallback(
    (t: number) => {
      const canvas = canvasRef.current
      const ctx = canvas?.getContext("2d")
      if (!canvas || !ctx) return

      const last = lastTimeRef.current || t
      const dt = clamp((t - last) / 1000, 0, 1 / 30)
      lastTimeRef.current = t

      const level = levelRef.current

      if (!paused && !won) {
        // Expire temporary platforms
        const now = performance.now()
        const remaining: TempPlatform[] = []
        for (const tp of tempPlatformsRef.current) {
          if (now >= tp.expiresAt) {
            if (tileAt(level, tp.tx, tp.ty) === "X") {
              const cx = tp.tx * TILE + TILE / 2
              const cy = tp.ty * TILE + TILE / 2
              spawnEarthCrumbleAt(cx, cy)
              setTile(level, tp.tx, tp.ty, ".")
            }
          } else {
            remaining.push(tp)
          }
        }
        tempPlatformsRef.current = remaining

        updateDoorOpen(level, playersRef.current)
        for (const p of playersRef.current) updatePlayer(level, p, dt)
        updateParticles(dt)

        // Win condition: all players at their gates AND all plates pressed
        const allPlayersAtGates = playersRef.current.every((p) => p.exitReached)
        let allPlatesPressed = true
        platesRef.current.forEach((st) => {
          if (!st.pressed) allPlatesPressed = false
        })
        if (allPlayersAtGates && allPlatesPressed) {
          setWon(true)
          setPaused(true)
        }
      }

      // Build reached map for gate checkmarks
      const gateReached: Record<1 | 2 | 3 | 4, boolean> = {
        1: !!playersRef.current.find((p) => p.id === 1)?.exitReached,
        2: !!playersRef.current.find((p) => p.id === 2)?.exitReached,
        3: !!playersRef.current.find((p) => p.id === 3)?.exitReached,
        4: !!playersRef.current.find((p) => p.id === 4)?.exitReached,
      }

      // Draw
      ctx.clearRect(0, 0, canvas.width, canvas.height)
      drawLevel(ctx, level, gateReached, platesRef.current, performance.now())
      for (const p of playersRef.current) drawPlayer(ctx, p)

      // Particles over players
      {
        const arr = particlesRef.current
        for (const prt of arr) {
          const tt = clamp(prt.life / prt.maxLife, 0, 1)
          const c1 = parseColor(prt.colorStart)
          const c2 = parseColor(prt.colorEnd)
          const r = Math.floor(lerp(c1.r, c2.r, tt))
          const g = Math.floor(lerp(c1.g, c2.g, tt))
          const b = Math.floor(lerp(c1.b, c2.b, tt))
          const alpha = 1 - tt
          if (prt.additive) ctx.globalCompositeOperation = "lighter"
          else ctx.globalCompositeOperation = "source-over"
          const s = prt.size * (1 - tt)
          ctx.fillStyle = `rgba(${r},${g},${b},${alpha})`
          if (prt.shape === "circle") {
            ctx.beginPath()
            ctx.arc(prt.x, prt.y, s, 0, Math.PI * 2)
            ctx.fill()
          } else {
            ctx.fillRect(prt.x - s / 2, prt.y - s / 2, s, s)
          }
        }
        ctx.globalCompositeOperation = "source-over"
      }

      rafRef.current = requestAnimationFrame(loop)
    },
    [paused, won],
  )

  useEffect(() => {
    lastTimeRef.current = performance.now()
    rafRef.current = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(rafRef.current)
  }, [loop])

  // capture rebinding
  const [capturing, setCapturing] = useState<{ pid: number; field: keyof KeyBinding } | null>(null)
  useEffect(() => {
    if (!capturing) return
    const handler = (e: KeyboardEvent) => {
      e.preventDefault()
      if (e.key === "Meta" || e.key === "OS") return
      const { pid, field } = capturing
      setBindings((prev) => ({
        ...prev,
        [pid]: { ...prev[pid], [field]: e.key },
      }))
      setCapturing(null)
    }
    window.addEventListener("keydown", handler, { once: true })
    return () => window.removeEventListener("keydown", handler as any)
  }, [capturing])

  return (
    <div className="fixed inset-0 flex flex-col">
      {/* Top bar */}
      <Card className="rounded-none border-b">
        <CardContent className="p-2">
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" variant={paused ? "default" : "outline"} onClick={() => setPaused((p) => !p)}>
              {paused ? <Play className="mr-2 h-4 w-4" /> : <Pause className="mr-2 h-4 w-4" />}
              {paused ? "Resume (P/Esc)" : "Pause (P/Esc)"}
            </Button>
            <Button size="sm" variant="outline" onClick={resetGame}>
              <RefreshCw className="mr-2 h-4 w-4" />
              Reset (R)
            </Button>

            {/* Controls modal */}
            <Dialog open={showSettings} onOpenChange={(next) => handleModalOpenChange(next, "settings")}>
              <DialogTrigger asChild>
                <Button size="sm" variant="outline">
                  <Settings2 className="mr-2 h-4 w-4" />
                  Controls
                </Button>
              </DialogTrigger>
              <DialogContent className="max-w-lg">
                <DialogHeader>
                  <DialogTitle>Controls</DialogTitle>
                  <DialogDescription>
                    Click a control and press a key to rebind. Note: OS/Meta/Fn keys can&apos;t be captured.
                  </DialogDescription>
                </DialogHeader>
                <div className="space-y-3">
                  {[1, 2, 3, 4].map((pid) => {
                    const pNames: Record<number, string> = {
                      1: "Player 1 (Fire)",
                      2: "Player 2 (Water)",
                      3: "Player 3 (Earth)",
                      4: "Player 4 (Wind)",
                    }
                    const colors: Record<number, string> = {
                      1: "#ef4444",
                      2: "#14b8a6",
                      3: "#92400e",
                      4: "#38bdf8",
                    }
                    const kb = bindings[pid]
                    return (
                      <div key={pid} className="rounded-md border p-3">
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-2">
                            <div className="h-3 w-3 rounded-full" style={{ backgroundColor: colors[pid] }} />
                            <Label className="font-medium">{pNames[pid]}</Label>
                          </div>
                        </div>
                        <div className={`mt-3 grid ${pid === 4 ? "grid-cols-3" : "grid-cols-4"} gap-2`}>
                          {(pid === 4
                            ? (["left", "right", "jump"] as (keyof KeyBinding)[])
                            : (["left", "right", "jump", "action"] as (keyof KeyBinding)[])
                          ).map((field) => (
                            <button
                              key={field}
                              className={`text-sm rounded-md border px-3 py-2 text-left hover:bg-muted ${capturing && capturing.pid === pid && capturing.field === field ? "ring-2 ring-amber-500" : ""}`}
                              onClick={() => setCapturing({ pid, field })}
                            >
                              <div className="text-xs text-muted-foreground uppercase">{field}</div>
                              <div className="font-mono">{kb[field]}</div>
                            </button>
                          ))}
                        </div>
                      </div>
                    )
                  })}
                </div>
              </DialogContent>
            </Dialog>

            {/* How to play modal */}
            <Dialog open={showHelp} onOpenChange={(next) => handleModalOpenChange(next, "help")}>
              <DialogTrigger asChild>
                <Button size="sm" variant="outline">
                  <Info className="mr-2 h-4 w-4" />
                  How to play
                </Button>
              </DialogTrigger>
              <DialogContent className="max-w-lg">
                <DialogHeader>
                  <DialogTitle>How to play</DialogTitle>
                  <DialogDescription>The game pauses while this window is open.</DialogDescription>
                </DialogHeader>
                <div className="space-y-4 text-sm text-muted-foreground">
                  <div>
                    <div className="font-medium text-foreground">Goal</div>
                    <ul className="list-disc pl-5 space-y-1">
                      <li>Get all 4 players to their color-coded gates that match their character.</li>
                      <li>Green pools are deadly for everyone.</li>
                      <li>Dark holes are deadly for everyone until Water fills them.</li>
                      <li>
                        Colored holes: Red/Teal/Brown/Blue are safe for Fire/Water/Earth/Wind respectively, deadly to
                        others.
                      </li>
                      <li>Stand on plates (orange) to open purple doors. You need 2 players on plates at once.</li>
                      <li>All plates must be pressed at least once before you can win.</li>
                    </ul>
                  </div>
                  <Separator />
                  <div>
                    <div className="font-medium text-foreground">Characters & Abilities</div>
                    <ul className="list-disc pl-5 space-y-1">
                      <li>
                        Fire: Breaks red barriers and earth platforms. Fiery sparks on action; ember steps while
                        running.
                      </li>
                      <li>
                        Water: Fills adjacent dark holes (including diagonals) into water you can swim through; splash
                        on fill; droplets while running.
                      </li>
                      <li>
                        Earth: Creates temporary stone platforms (4s cooldown); dust on spawn; crumble particles on
                        despawn; dusty steps.
                      </li>
                      <li>Wind: Double-tap Z/C/X to dash (3s cooldown) with airy trail; wisps while running.</li>
                    </ul>
                  </div>
                  <Separator />
                  <div>
                    <div className="font-medium text-foreground">Default Controls</div>
                    <ul className="list-disc pl-5 space-y-1">
                      <li>Fire: A/D move, W jump, S action</li>
                      <li>Water: J/L move, I jump, K action</li>
                      <li>Earth: Arrow Left/Right move, Arrow Up jump, Arrow Down action</li>
                      <li>Wind: Z/C move, X jump — double-tap Z/C/X to dash</li>
                    </ul>
                    <div className="mt-2">Tip: Use the Controls window to rebind keys.</div>
                  </div>
                </div>
              </DialogContent>
            </Dialog>

            <Separator orientation="vertical" className="mx-2 h-6" />
            <div className="text-sm text-muted-foreground">Deaths: {deaths}</div>
            {won && (
              <div className="ml-2 rounded bg-emerald-100 px-2 py-1 text-sm font-medium text-emerald-700">
                You all escaped!
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Full-screen play area below the top bar */}
      <div ref={wrapperRef} className="relative flex-1 overflow-hidden bg-white">
        <canvas ref={canvasRef} />
        {paused && (
          <div className="pointer-events-none absolute inset-0 grid place-items-center bg-black/40">
            <div className="pointer-events-auto rounded-md bg-white p-4 shadow">
              <div className="text-center font-semibold">{won ? "Victory!" : "Paused"}</div>
              <div className="mt-2 text-center text-sm text-muted-foreground">
                {won ? "All players reached their exits and all plates were pressed." : "Press P/Esc to resume"}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
