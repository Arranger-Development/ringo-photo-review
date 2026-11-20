/* global JSSynth, createFFmpegCore */
importScripts('./vendor/libfluidsynth-2.4.6.js', './vendor/js-synthesizer.min.js', './vendor/ffmpeg-core.js')

const sampleRate = 44100
const tailSeconds = 1.8
let engine
let font
let output = []

async function prepare(expected) {
  if (!engine) {
    await JSSynth.waitForReady()
    const base = new URL('./vendor/ffmpeg-core.js', self.location.href).href
    const wasmURL = new URL('./vendor/ffmpeg-core.wasm', self.location.href).href
    engine = await createFFmpegCore({mainScriptUrlOrBlob:base + '#' + btoa(JSON.stringify({wasmURL}))})
    engine.setLogger(({message}) => output.push(message))
  }
  if (!font) {
    const response = await fetch('./vendor/GeneralUser-GS.sf2')
    if (!response.ok) throw new Error('无法下载 GeneralUser GS 音色库。')
    const bytes = await response.arrayBuffer()
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
    if (Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('') !== expected)
      throw new Error('音色库文件和编配目录不匹配。')
    font = bytes
  }
}

function be(value, size) {
  return Array.from({length:size}, (_, index) => (value >>> ((size - 1 - index) * 8)) & 255)
}

function vlq(value) {
  const bytes = [value & 127]
  while ((value >>>= 7)) bytes.unshift((value & 127) | 128)
  return bytes
}

function track(events, endTick) {
  const bytes = []
  let last = 0
  events.sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2][0] - b[2][0] || a[2][1] - b[2][1])
  for (const [tick, , message] of events) {
    bytes.push(...vlq(tick - last), ...message)
    last = tick
  }
  bytes.push(...vlq(endTick - last), 255, 47, 0)
  return [77, 84, 114, 107, ...be(bytes.length, 4), ...bytes]
}

function midi(candidate, timbres) {
  const tempo = Math.round(60000000 / candidate.bpm)
  const beats = candidate.barCount * 4
  const endTick = beats * candidate.ticksPerBeat
  const tracks = [track([[0, 0, [255, 81, 3, ...be(tempo, 3)]],
    [0, 1, [255, 88, 4, 4, 2, 24, 8]]], endTick)]
  let pitched = 0
  for (const part of candidate.tracks) {
    const timbre = timbres.get(part.timbreId)
    const channel = timbre.kind === 'percussion' ? 9 : pitched++
    const events = [[0, 1, [192 | channel, timbre.midiProgram]]]
    if (channel !== 9) events.push([0, 0, [176 | channel, 0, timbre.midiBank]])
    for (const note of part.events) {
      events.push([note.startTick, 3, [144 | channel, note.midi, note.velocity]])
      events.push([note.startTick + note.durationTicks, 2, [128 | channel, note.midi, 0]])
    }
    tracks.push(track(events, endTick))
  }
  const header = [77, 84, 104, 100, 0, 0, 0, 6, 0, 1, ...be(tracks.length, 2), ...be(candidate.ticksPerBeat, 2)]
  return {data:new Uint8Array(header.concat(...tracks)).buffer, duration:beats * tempo / 1e6 + tailSeconds}
}

async function wav(candidate, timbres) {
  const {data, duration} = midi(candidate, timbres)
  const frames = Math.ceil(duration * sampleRate)
  const bytes = new Uint8Array(44 + frames * 8)
  const view = new DataView(bytes.buffer)
  const name = (offset, value) => bytes.set(new TextEncoder().encode(value), offset)
  name(0, 'RIFF')
  view.setUint32(4, bytes.length - 8, true)
  name(8, 'WAVEfmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 3, true)
  view.setUint16(22, 2, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 8, true)
  view.setUint16(32, 8, true)
  view.setUint16(34, 32, true)
  name(36, 'data')
  view.setUint32(40, frames * 8, true)
  const synth = new JSSynth.Synthesizer()
  synth.init(sampleRate, {initialGain:0.7, midiBankSelect:'gs'})
  try {
    await synth.loadSFont(font)
    await synth.addSMFDataToPlayer(data)
    await synth.playPlayer()
    const left = new Float32Array(4096)
    const right = new Float32Array(4096)
    for (let start = 0; start < frames; start += left.length) {
      synth.render([left, right])
      const length = Math.min(left.length, frames - start)
      for (let index = 0; index < length; index++) {
        const offset = 44 + (start + index) * 8
        view.setFloat32(offset, left[index], true)
        view.setFloat32(offset + 4, right[index], true)
      }
    }
    synth.stopPlayer()
  } finally { synth.close() }
  return {bytes, duration}
}

function ffmpeg(...args) {
  output = []
  let status
  try { status = engine.exec('-hide_banner', '-nostats', ...args) }
  finally { engine.reset() }
  if (status !== 0) throw new Error('MP3 编码或响度检测失败。')
  return output.join('\n')
}

function measure(path, filters) {
  const result = ffmpeg('-loglevel', 'info', '-i', path, '-af', filters, '-f', 'null', '-').split('Summary:').at(-1)
  const loudness = Number(result.match(/I:\s+([-\d.]+) LUFS/)?.[1])
  const peak = Number(result.match(/Peak:\s+([-\d.]+) dBFS/)?.[1])
  if (!Number.isFinite(loudness) || !Number.isFinite(peak) || loudness <= -65)
    throw new Error(path + ' 的响度无法测量，可能静音或音量过低。')
  return {loudness, peak}
}

async function render(score, listening, catalog, notify) {
  await prepare(catalog.soundfontSha256)
  const timbres = new Map(catalog.timbres.map(timbre => [timbre.id, timbre]))
  const rendered = []
  try {
    for (const candidate of listening) {
      notify('合成 ' + candidate.label + ' · ' + (rendered.length + 1) + ' / ' + listening.length)
      const started = performance.now()
      const {bytes, duration} = await wav(score.candidates[candidate.arrangementIndex], timbres)
      const path = candidate.label + '.wav'
      engine.FS.writeFile(path, bytes)
      const filters = 'atrim=end=' + duration.toFixed(6) + ',afade=t=out:st=' + (duration - 0.15).toFixed(6) + ':d=0.15'
      const {loudness, peak} = measure(path, filters + ',ebur128=peak=true')
      rendered.push({path, candidate, duration, filters, loudness, peak, synthesisMs:performance.now() - started})
    }
    const target = Math.min(-18, ...rendered.map(({loudness, peak}) => loudness - 2 - peak))
    return rendered.map(({path, candidate, duration, filters, loudness, synthesisMs}, index) => {
      notify('编码 ' + candidate.label + ' · ' + (index + 1) + ' / ' + listening.length)
      const started = performance.now()
      const mp3 = candidate.label + '.mp3'
      ffmpeg('-loglevel', 'error', '-i', path, '-af', filters + ',volume=' + (target - loudness).toFixed(3) + 'dB',
        '-c:a', 'libmp3lame', '-q:a', '2', '-metadata', 'title=' + candidate.label, mp3)
      const measured = measure(mp3, 'ebur128=peak=true')
      if (Math.abs(measured.loudness - target) > 1.1 || measured.peak >= -0.3)
        throw new Error('试听 ' + candidate.label + ' 的响度或峰值异常。')
      return {
        id:candidate.id, audio:new Blob([engine.FS.readFile(mp3)], {type:'audio/mpeg'}),
        render:{durationSeconds:duration, synthesisMs, encodingMs:performance.now() - started,
          targetLufs:target, lufs:measured.loudness, peakDbfs:measured.peak}
      }
    })
  } finally {
    for (const {label} of listening) {
      for (const extension of ['.wav', '.mp3']) {
        try { engine.FS.unlink(label + extension) } catch { /* A failing render may leave no file. */ }
      }
    }
  }
}

self.onmessage = async ({data}) => {
  try {
    const results = await render(data.score, data.listening, data.catalog,
      status => self.postMessage({status}))
    self.postMessage({results})
  } catch (error) { self.postMessage({error:error.message || '音频合成失败。'}) }
}
