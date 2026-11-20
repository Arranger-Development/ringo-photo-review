import {validateIntentShape, validateScoreShape, validateModelScoreShape} from './vendor/validators.js'

export const renderVersion = 'ringo-fluid-wasm-1'
export const letters = 'ABCDEFGH'
export const photoIdPattern = /^[a-f0-9]{32}$/
export const hashPattern = /^[a-f0-9]{64}$/
export const noteFields = ['startTick', 'durationTicks', 'midi', 'velocity']
export const loopEnd = 7680
export const photoLimit = 10 * 1024 * 1024
export const mimeTypes = ['image/jpeg', 'image/png']

export const id = () => crypto.randomUUID().replaceAll('-', '')
export const now = () => new Date().toISOString()
export const duration = begin => Math.round((performance.now() - begin) * 10) / 10

export async function hash(value) {
  const bytes = value instanceof Blob ? await value.arrayBuffer()
    : typeof value === 'string' ? new TextEncoder().encode(value) : value
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
}

function file(name) {
  return fetch(new URL('./specs/' + name, import.meta.url)).then(response => {
    if (!response.ok) throw new Error('无法加载编配规则。请刷新网页重试。')
    return response
  })
}

let loading
export function loadSpecs() {
  loading ??= Promise.all([
    file('photo-music-intent.schema.json').then(response => response.json()),
    file('photo-arrangements.schema.json').then(response => response.json()),
    file('photo-arrangements.full-timbres.json').then(response => response.json()),
    file('photo-to-music-intent.prompt.txt').then(response => response.text()),
    file('music-intent-to-arrangements.prompt.txt').then(response => response.text())
  ]).then(([intentSchema, scoreSchema, catalog, intentPrompt, scorePrompt]) => {
    catalog.byId = new Map(catalog.timbres.map(timbre => [timbre.id, timbre]))
    return {intentSchema, scoreSchema, catalog, intentPrompt, scorePrompt}
  }).catch(error => { loading = undefined; throw error })
  return loading
}

function checkShape(check, value, label) {
  if (check(value)) return
  const first = check.errors?.[0]
  throw new Error(label + ' JSON 格式无效' + (first?.instancePath ? '（' + first.instancePath + '）' : '。'))
}

export function validateIntent(intent) {
  checkShape(validateIntentShape, intent, '音乐意图')
  const range = intent.tempoBpmRange
  if (range && range.min > range.max) throw new Error('音乐意图的 BPM 区间无效。')
}

export function normalizeModelScore(score, count) {
  if (!Array.isArray(score?.candidates) || score.candidates.length !== count)
    throw new Error('期望 ' + count + ' 套编配，千问返回的数量不匹配。')
  for (const candidate of score.candidates) {
    for (const track of candidate.tracks ?? []) {
      if (!Array.isArray(track.events)) continue
      track.events = track.events.map(event => {
        if (!Array.isArray(event)) return event
        if (event.length !== noteFields.length) throw new Error('编配包含长度不正确的 MIDI 音符。')
        return Object.fromEntries(noteFields.map((field, index) => [field, event[index]]))
      })
    }
  }
  checkShape(validateModelScoreShape, score, '编配')
  let trimmed = 0
  for (const candidate of score.candidates) {
    for (const track of candidate.tracks) {
      track.events.sort((a, b) => a.startTick - b.startTick || a.midi - b.midi)
      for (const note of track.events) {
        if (note.startTick + note.durationTicks <= loopEnd) continue
        note.durationTicks = loopEnd - note.startTick
        trimmed++
      }
    }
  }
  return trimmed
}

export function scoreIssues(score, catalog, count, preferred = []) {
  checkShape(validateScoreShape, score, '编配')
  if (score.catalogVersion !== catalog.catalogVersion || score.candidates.length !== count)
    throw new Error('编配的音色目录版本或候选数不匹配。')
  const identities = new Set()
  const issues = []
  const ordered = [...new Set([...preferred, ...score.candidates.keys()])]
  for (const index of ordered) {
    try {
      const candidate = score.candidates[index]
      let percussionTracks = 0
      const tracks = []
      for (const track of candidate.tracks) {
        const timbre = catalog.byId.get(track.timbreId)
        if (!timbre) throw new Error(track.timbreId + ' 不在音色目录中。')
        const percussion = timbre.kind === 'percussion'
        if (percussion && ++percussionTracks > 1) throw new Error('有多条打击乐轨。')
        const ends = new Map()
        const notes = []
        for (const note of track.events) {
          const {startTick, durationTicks, midi} = note
          const end = startTick + durationTicks
          const allowed = percussion
            ? (timbre.drumNotes?.some(item => item.midi === midi) ||
              timbre.drumMidiRanges?.some(([low, high]) => midi >= low && midi <= high))
            : midi >= (timbre.midiMin ?? 0) && midi <= (timbre.midiMax ?? 127)
          if (!allowed) throw new Error(track.timbreId + ' 的 MIDI ' + midi + ' 超出音域或鼓件表。')
          if (end > loopEnd) throw new Error(track.timbreId + ' 的 MIDI ' + midi + ' 超出四小节。')
          if (startTick < (ends.get(midi) ?? 0))
            throw new Error(track.timbreId + ' 的 MIDI ' + midi + ' 同音高重叠。')
          ends.set(midi, end)
          notes.push([startTick, midi, durationTicks])
        }
        tracks.push(JSON.stringify([track.timbreId, notes]))
      }
      const fingerprint = JSON.stringify([candidate.bpm, tracks.sort()])
      if (identities.has(fingerprint)) throw new Error('与另一套编配重复。')
      identities.add(fingerprint)
    } catch (error) {
      issues.push({index, message: error.message})
    }
  }
  return issues
}

export async function makeListening(jobId, score) {
  const order = [...score.candidates.keys()]
  const random = crypto.getRandomValues(new Uint32Array(order.length))
  for (let index = order.length - 1; index > 0; index--) {
    const other = random[index] % (index + 1)
    ;[order[index], order[other]] = [order[other], order[index]]
  }
  return Promise.all(order.map(async (arrangementIndex, index) => ({
    label: letters[index],
    arrangementIndex,
    id: await hash(JSON.stringify([jobId, score.catalogVersion, arrangementIndex, score.candidates[arrangementIndex]]))
  })))
}

export function validListening(listening, count) {
  return Array.isArray(listening) && listening.length === count &&
    new Set(listening.map(item => item?.id)).size === count &&
    new Set(listening.map(item => item?.arrangementIndex)).size === count &&
    listening.every((item, index) => item?.label === letters[index] && hashPattern.test(item.id) &&
      Number.isInteger(item.arrangementIndex) && item.arrangementIndex >= 0 && item.arrangementIndex < count)
}

export async function validatePhoto(blob) {
  if (!mimeTypes.includes(blob.type) || blob.size > photoLimit)
    throw new Error('请选择 10 MB 以内的 JPEG 或 PNG。')
  const bytes = new Uint8Array(await blob.slice(0, 8).arrayBuffer())
  const prefix = blob.type === 'image/jpeg' ? [255, 216, 255] : [137, 80, 78, 71, 13, 10, 26, 10]
  if (!prefix.every((byte, index) => bytes[index] === byte)) throw new Error('照片格式和文件内容不一致。')
}
