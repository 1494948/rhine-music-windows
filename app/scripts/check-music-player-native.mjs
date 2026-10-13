import test from 'node:test'
import assert from 'node:assert/strict'
import { MusicPlayer } from '../src/player/music-player.ts'

/**
 * Native-kernel event plumbing.
 *
 * Why this file exists on its own: `getNativePlayback()` returns a
 * **module-level singleton**. Once any test binds a fake WebView2 host, every
 * later test in the same process sees `native.available === true` and silently
 * switches to the libmpv channel — the browser-path assertions then read a
 * `<audio>` element that was never created. The check therefore has to run in
 * its own process, which is why it is a separate script in `check:music`.
 *
 * The bug it locks down: `MusicPlayer` used to subscribe to native events only
 * when `available` was already true at construction time. The shell injects
 * `__rhinePlayerControl` asynchronously — routinely after this module is
 * constructed — so that subscription never happened, and the `eof` the kernel
 * reports when a song finishes was dropped on the floor. Playback simply
 * stopped at the end of a track instead of advancing.
 */

const settle = async () => { for (let i = 0; i < 12; i += 1) await Promise.resolve() }

/** No browser, network, real timers, or actual sound is used by these tests. */
function environment(t) {
  let now = 0
  let nextTimer = 1
  const timers = new Map()
  const instances = []
  const document = new EventTarget()
  const previousAudio = Object.getOwnPropertyDescriptor(globalThis, 'Audio')
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document')
  const previousTimeout = globalThis.setTimeout
  const previousClear = globalThis.clearTimeout
  const previousNow = Object.getOwnPropertyDescriptor(performance, 'now')

  class ControlledAudio extends EventTarget {
    constructor(src = '') {
      super()
      this.src = src
      this.volume = 1
      this.paused = true
      this.ended = false
      this.duration = 120
      this.currentTime = 0
      this.readyState = 1
      this.playCalls = 0
      instances.push(this)
    }
    play() { this.playCalls += 1; this.begin(); return Promise.resolve() }
    begin() { this.paused = false; this.dispatchEvent(new Event('playing')) }
    pause() { if (this.paused) return; this.paused = true; this.dispatchEvent(new Event('pause')) }
    removeAttribute(name) { if (name === 'src') this.src = '' }
    load() {}
  }

  Object.defineProperty(globalThis, 'Audio', { configurable: true, writable: true, value: ControlledAudio })
  Object.defineProperty(globalThis, 'document', { configurable: true, writable: true, value: document })
  Object.defineProperty(performance, 'now', { configurable: true, value: () => now })
  globalThis.setTimeout = (callback, delay = 0) => {
    const id = nextTimer++
    timers.set(id, { callback, at: now + Number(delay) })
    return id
  }
  globalThis.clearTimeout = (id) => timers.delete(id)
  t.after(() => {
    if (previousAudio) Object.defineProperty(globalThis, 'Audio', previousAudio)
    else delete globalThis.Audio
    if (previousDocument) Object.defineProperty(globalThis, 'document', previousDocument)
    else delete globalThis.document
    if (previousNow) Object.defineProperty(performance, 'now', previousNow)
    else delete performance.now
    globalThis.setTimeout = previousTimeout
    globalThis.clearTimeout = previousClear
  })

  return {
    instances,
    gesture: () => document.dispatchEvent(new Event('pointerdown')),
    async advance(milliseconds) {
      await settle()
      const end = now + milliseconds
      let next
      while ((next = [...timers.entries()].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0])) {
        now = next[1].at
        timers.delete(next[0])
        next[1].callback()
        await settle()
      }
      now = end
      await settle()
    },
  }
}

const track = (id) => ({
  id, albumId: 'album-test', title: id, artist: 'Test artist',
  duration: 120, format: 'WAV', browserPlayable: true,
  relativePath: `${id}.wav`, audioUrl: `/api/audio/${id}`,
})

/** A WebView2 host that appears only after the player was constructed. */
function lateHost() {
  const state = { listener: null }
  const host = {
    postMessage: () => true,
    addEventListener: (type, handler) => { if (type === 'message') state.listener = handler },
  }
  const inject = () => {
    Object.defineProperty(globalThis, 'window', {
      configurable: true, writable: true,
      value: {
        location: { origin: 'http://127.0.0.1:5173' },
        chrome: { webview: host },
        addEventListener: () => {},
        setInterval: () => 0, clearInterval: () => {}, setTimeout: () => 0,
      },
    })
  }
  const remove = () => { delete globalThis.window }
  return { state, inject, remove }
}

/**
 * Declaration order is load-bearing. The no-host test must run first: once any
 * test binds a fake host, the singleton keeps it for the rest of the process
 * (there is no reset), so a later "no host" test would silently take the
 * libmpv channel and assert against a `<audio>` element that never existed.
 */

test('without any host the browser backend still plays and still advances', async (t) => {
  const env = environment(t)
  const player = new MusicPlayer({ volume: 0.8, songFadeEnabled: false })
  player.setQueue([track('a'), track('b')])
  env.gesture()
  await env.advance(700)
  const starting = player.play('a')
  await env.advance(800)
  await starting
  assert.equal(player.state.backend, 'browser')
  assert.equal(player.state.currentTrack?.id, 'a')

  const song = env.instances[env.instances.length - 1]
  song.ended = true
  song.dispatchEvent(new Event('ended'))
  await env.advance(50)
  await settle()

  assert.equal(player.state.currentTrack?.id, 'b', 'the browser path must keep advancing with no host at all')
  player.dispose()
})

test('a host injected after construction still delivers eof, so the next track starts', async (t) => {
  const env = environment(t)
  const host = lateHost()
  t.after(() => host.remove())

  // The page script runs first; the shell's control endpoint is not there yet.
  assert.equal(typeof globalThis.window, 'undefined', 'no host at construction time')
  const player = new MusicPlayer({ volume: 0.8, songFadeEnabled: false })
  player.setQueue([track('a'), track('b'), track('c')])
  await settle()
  assert.equal(player.state.backend, 'browser', 'without a host the browser backend is used')

  // The shell finishes loading and injects the endpoint.
  host.inject()

  // The host is discovered the first time playback needs it — `play()` reads
  // `native.available`, which is what calls `refresh()`.
  env.gesture()
  await env.advance(700)
  const starting = player.play('a')
  await env.advance(800)
  await starting

  assert.equal(player.state.backend, 'native-libmpv', 'the late host must be adopted')
  assert.ok(host.state.listener, 'the late host must be listened to')
  assert.equal(player.state.currentTrack?.id, 'a')

  // The kernel reports playing, then end-of-file — the event sequence a real
  // libmpv produces. `eof` is the one that used to vanish.
  host.state.listener({ data: { type: 'playing', trackId: 'a' } })
  await settle()
  host.state.listener({ data: { type: 'eof', trackId: 'a' } })
  await env.advance(50)
  await settle()

  assert.equal(player.state.currentTrack?.id, 'b', 'eof from a late host must advance to the next track')
  assert.equal(player.state.transport, 'playing', 'the next track must be playing')
  player.dispose()
})
