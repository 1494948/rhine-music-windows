import test from 'node:test'
import assert from 'node:assert/strict'
import { LyricsPane } from '../src/music-lyrics-pane.ts'
import { parseLrc } from '../src/music-lyrics.ts'

/**
 * The lyrics pane as a component.
 *
 * `check-music-lyrics.mjs` covers the parsing model and the archive panel;
 * nothing covered `LyricsPane` itself, which is where the reported defect
 * lived: switching tracks while the pane was open left the first track's lyrics
 * on screen — or no lyrics at all.
 *
 * The root cause was that `setTrack()` handed its work to `prepare()`, which
 * **re-derived** the target from `options.current()` instead of using the track
 * it had just been given. That second read can disagree with the first:
 * `currentAlbum()` is momentarily undefined while an album switches, and
 * `lyricTarget` falls back to `tracks[0]` whenever the playing track is not
 * found in the open album. Both outcomes read to a user as "only the first song
 * in the list ever shows lyrics".
 */

const settle = async () => { for (let i = 0; i < 20; i += 1) await Promise.resolve() }

/** The smallest DOM surface the pane actually touches. */
class FakeElement {
  constructor(tag = 'div') {
    this.tagName = tag
    this.children = []
    this.dataset = {}
    this.hidden = false
    this.textContent = ''
    this._classes = new Set()
    this._byClass = new Map()
    this.style = { setProperty() {}, getPropertyValue() { return '' } }
    this.clientHeight = 400
    this.id = ''
  }
  set className(value) { this._classes = new Set(String(value).split(/\s+/).filter(Boolean)) }
  get className() { return [...this._classes].join(' ') }
  get classList() {
    const set = this._classes
    return {
      toggle: (name, on) => {
        const next = on === undefined ? !set.has(name) : !!on
        if (next) set.add(name); else set.delete(name)
      },
      add: (name) => set.add(name),
      remove: (name) => set.delete(name),
      contains: (name) => set.has(name),
    }
  }
  set innerHTML(html) {
    this.children = []
    this._byClass = new Map()
    this.textContent = ''
    const pattern = /class="([^"]+)"/g
    let match
    while ((match = pattern.exec(String(html)))) {
      for (const name of match[1].split(/\s+/)) {
        if (name && !this._byClass.has(name)) {
          const child = new FakeElement('span')
          child.className = name
          this._byClass.set(name, child)
        }
      }
    }
  }
  get innerHTML() { return '' }
  append(...nodes) { for (const node of nodes) this.children.push(node) }
  querySelector(selector) { return this._byClass.get(selector.replace(/^\./, '')) ?? null }
  setAttribute() {}
  getAttribute() { return null }
  addEventListener() {}
  removeEventListener() {}
  remove() {}
}

const fakeDocument = {
  createElement: (tag) => new FakeElement(tag),
  createDocumentFragment: () => new FakeElement('#fragment'),
  addEventListener() {},
}

const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document')
const previousRaf = Object.getOwnPropertyDescriptor(globalThis, 'requestAnimationFrame')
const previousCancelRaf = Object.getOwnPropertyDescriptor(globalThis, 'cancelAnimationFrame')
Object.defineProperty(globalThis, 'document', { configurable: true, writable: true, value: fakeDocument })
Object.defineProperty(globalThis, 'requestAnimationFrame', { configurable: true, writable: true, value: () => 0 })
Object.defineProperty(globalThis, 'cancelAnimationFrame', { configurable: true, writable: true, value: () => {} })

const lrc = (text) => `[00:00.00]${text} 第一句\n[00:04.00]${text} 第二句\n[00:08.00]${text} 第三句`

/** A pane whose `load` answers per track id, and whose `current` is steerable. */
function makePane({ onLoad, current }) {
  const loaded = []
  const load = async (trackId) => {
    loaded.push(trackId)
    onLoad?.(trackId)
    return parseLrc(lrc(trackId))
  }
  const pane = new LyricsPane(new FakeElement('div'), { load, current })
  return { pane, loaded }
}

test('switching to the second track mounts the second track\'s own lyrics', async (t) => {
  const { pane, loaded } = makePane({})
  t.after(() => pane.dispose())

  pane.setTrack({ trackId: 'track-1', title: 'track-1', artist: 'A' })
  await pane.prepare()
  pane.setReveal(1)
  await settle()
  assert.equal(pane.trackId, 'track-1')
  assert.equal(pane.lyricsReady, true, 'the first track loads')

  // Playback advances. `current()` is stale here on purpose — that is exactly
  // the disagreement that used to pin the pane to the first track.
  pane.setTrack({ trackId: 'track-2', title: 'track-2', artist: 'A' })
  await settle()
  assert.equal(pane.trackId, 'track-2', 'the pane must remember the second track')
  assert.ok(loaded.includes('track-2'), `the second track must be read, got: ${loaded.join(', ')}`)
  assert.equal(pane.lyricsReady, true, 'the second track must mount its own lyrics')

  pane.setTrack({ trackId: 'track-3', title: 'track-3', artist: 'A' })
  await settle()
  assert.ok(loaded.includes('track-3'), `the third track must be read, got: ${loaded.join(', ')}`)
  assert.equal(pane.lyricsReady, true)
})

test('a current() that yields nothing must not leave the pane lyricless', async (t) => {
  // `currentAlbum()` is momentarily undefined while an album switches.
  let resolvable = true
  const { pane, loaded } = makePane({ current: () => (resolvable ? { trackId: 'track-1', title: 'track-1', artist: 'A' } : undefined) })
  t.after(() => pane.dispose())

  pane.setTrack({ trackId: 'track-1', title: 'track-1', artist: 'A' })
  await pane.prepare()
  pane.setReveal(1)
  await settle()
  assert.equal(pane.lyricsReady, true)

  resolvable = false
  pane.setTrack({ trackId: 'track-2', title: 'track-2', artist: 'A' })
  await settle()

  assert.equal(pane.trackId, 'track-2')
  assert.ok(loaded.includes('track-2'), `the named track must still be read, got: ${loaded.join(', ')}`)
  assert.equal(pane.lyricsReady, true, 'the pane must not be stranded without lyrics')
})

test('a track chosen while the pane is closed is the one that opens', async (t) => {
  let target = 'track-2'
  const { pane, loaded } = makePane({ current: () => ({ trackId: target, title: target, artist: 'A' }) })
  t.after(() => pane.dispose())

  // Nothing playing yet: the album's first track is the placeholder.
  pane.setTrack({ trackId: 'track-1', title: 'track-1', artist: 'A' })
  await settle()
  assert.equal(pane.trackId, 'track-1')
  assert.equal(loaded.length, 0, 'a closed pane reads nothing')

  // Playback advances while the pane stays closed.
  pane.setTrack({ trackId: 'track-2', title: 'track-2', artist: 'A' })
  await settle()
  assert.equal(pane.trackId, 'track-2')

  await pane.prepare()
  pane.setReveal(1)
  await settle()
  assert.equal(loaded.at(-1), 'track-2', `opening the pane must read the current track, got ${loaded.at(-1)}`)
  assert.equal(pane.lyricsReady, true)
})
