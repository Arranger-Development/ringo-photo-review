import {Zip, ZipDeflate, ZipPassThrough} from './vendor/fflate.js'
import {openZip} from './zip.js'
import {loadLibrary, mergeRating} from './library.js'
import {hash, hashPattern, id, loadSpecs, mimeTypes, now, photoIdPattern, photoLimit,
  renderVersion, scoreIssues, validListening, validatePhoto} from './score.js'
import {all, audioKey, get, photoKey, put} from './storage.js'

const partLimit = 8 * 1024 * 1024
const bundleLimit = 0xffffffff
const makeJson = value => new Blob([JSON.stringify(value, null, 2) + '\n'])
const compatibility = 'ringo-photo-arrangements'
const resultsFormat = 'ringo-photo-ratings'

async function archive(entries) {
  const chunks = []
  let error
  let size = 0
  const zip = new Zip((problem, bytes) => {
    if (problem) error = problem
    else chunks.push(bytes)
  })
  for await (const [name, blob, compress] of entries) {
    size += blob.size + 1024
    if (size >= bundleLimit) throw new Error('这份 ZIP 超过 4 GB，请先导出较小的记录范围。')
    const entry = compress ? new ZipDeflate(name, {level:3}) : new ZipPassThrough(name)
    zip.add(entry)
    for await (const chunk of blob.stream()) {
      entry.push(chunk)
      if (error) throw error
    }
    entry.push(new Uint8Array(), true)
    if (error) throw error
  }
  zip.end()
  if (error) throw error
  return new Blob(chunks, {type:'application/zip'})
}

export function saveFile(blob, name) {
  const url = URL.createObjectURL(blob)
  const link = Object.assign(document.createElement('a'), {href:url, download:name})
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 60000)
}

export async function exportRuns(runs) {
  const packId = id()
  async function* entries() {
    const index = []
    for (const run of runs) {
      const folder = 'photos/' + run.id + '/'
      index.push(run.id)
      const {id, name, mimeType, photoSha256, count, phase, createdAt, renderVersion, soundfontSha256, model, endpoint,
        error, attempt} = run
      yield [folder + 'state.json', makeJson({id, name, mimeType, photoSha256, count, phase, createdAt,
        renderVersion, soundfontSha256, model, endpoint, error, attempt}), true]
      yield [folder + 'photo', run.photo, false]
      if (run.intent) yield [folder + 'intent.json', makeJson(run.intent), true]
      if (run.score) yield [folder + 'arrangements.json', makeJson(run.score), true]
      if (run.listening) yield [folder + 'listen.json', makeJson(run.listening), true]
      if (run.partial) yield [folder + 'partial.json', makeJson(run.partial), true]
      const events = []
      for (const {rawResponse, ...call} of run.calls) {
        if (rawResponse !== undefined) {
          call.rawResponsePath = folder + 'qwen/' + call.id + '.json'
          yield [call.rawResponsePath, new Blob([rawResponse]), true]
        }
        events.push({photoId:id, kind:'qwen_request', ...call})
      }
      events.push(...(run.events ?? []).map(event => ({photoId:id, ...event})))
      yield [folder + 'events.jsonl', new Blob(events.map(event => JSON.stringify(event) + '\n')), true]
    }
    yield ['ringo.json', makeJson({format:compatibility, schemaVersion:1, packId, exportedAt:now(), photos:index}), true]
  }
  return archive(entries())
}

async function json(zip, name, limit = partLimit) {
  return JSON.parse(await (await zip.read(name, limit)).text())
}

async function prepareDeck(file) {
  const zip = await openZip(file)
  if (!zip.has('ringo.json')) return prepareLegacyDeck(file)
  const manifest = await json(zip, 'ringo.json', 1024 * 1024)
  if (manifest.format !== compatibility || manifest.schemaVersion !== 1 || !photoIdPattern.test(manifest.packId) ||
    !Array.isArray(manifest.photos) || !manifest.photos.length || manifest.photos.length > 5000 ||
    manifest.photos.some(id => typeof id !== 'string' || !photoIdPattern.test(id)) ||
    new Set(manifest.photos).size !== manifest.photos.length)
    throw new Error('请选择 Ringo 导出的编配库 ZIP。')
  const prefix = manifest.packId
  const existing = await get('decks', prefix)
  if (existing) return existing
  const {catalog} = await loadSpecs()
  const imported = []
  let skipped = 0
  for (const id of manifest.photos) {
    const folder = 'photos/' + id + '/'
    const state = await json(zip, folder + 'state.json', 128 * 1024)
    if (!zip.has(folder + 'arrangements.json')) {
      skipped++
      continue
    }
    if (state.id !== id || !hashPattern.test(state.photoSha256) || !mimeTypes.includes(state.mimeType) ||
      !Number.isFinite(Date.parse(state.createdAt)) || typeof state.name !== 'string' || state.name.length > 255 ||
      !Number.isInteger(state.count) || state.count < 4 || state.count > 8 || state.renderVersion !== renderVersion ||
      state.soundfontSha256 !== catalog.soundfontSha256)
      throw new Error('编配包里的照片索引或渲染版本无效。')
    const photo = new Blob([await zip.read(folder + 'photo', photoLimit)], {type:state.mimeType})
    await validatePhoto(photo)
    if (await hash(photo) !== state.photoSha256) throw new Error(state.name + ' 的照片哈希不匹配。')
    const score = await json(zip, folder + 'arrangements.json')
    const listening = await json(zip, folder + 'listen.json', 128 * 1024)
    if (scoreIssues(score, catalog, state.count).length || !validListening(listening, state.count))
      throw new Error(state.name + ' 的编配或盲听映射无效。')
    for (const item of listening) {
      const expected = await hash(JSON.stringify([id, score.catalogVersion, item.arrangementIndex,
        score.candidates[item.arrangementIndex]]))
      if (item.id !== expected) throw new Error(state.name + ' 的候选校验失败。')
    }
    await put('photos', photoKey(prefix, id), {...state, photo, score, listening, phase:'queued'})
    imported.push(id)
  }
  if (!imported.length) throw new Error('ZIP 中没有可用于听评的编配。')
  const deck = {id:prefix, name:file.name, photos:imported, skipped, selected:0, importedAt:now()}
  await put('decks', prefix, deck)
  return deck
}

async function prepareLegacyDeck(file) {
  const library = await loadLibrary(file)
  const prefix = await hash(JSON.stringify([...library.jobs.values()].map(job => [
    job.id, job.photoSha256, job.candidates.map(candidate => candidate.id)])))
  const existing = await get('decks', prefix)
  if (existing) return existing
  for (const item of library.jobs.values()) {
    const {id, name, createdAt, mimeType, photoSha256, candidates:listening} = item
    const photo = await library.photo(item)
    await put('photos', photoKey(prefix, id), {id, name, createdAt, mimeType, photoSha256,
      listening, photo, phase:'queued', cachedOnly:true})
    const audio = []
    for (const candidate of listening) audio.push({id:candidate.id, audio:await library.audio(item, candidate),
      audioSha256:candidate.audioSha256})
    await put('audio', audioKey(id, listening), audio)
  }
  let saved = []
  try { saved = JSON.parse(localStorage.getItem('ringo-offline-review-ratings-v1') ?? '[]') } catch { /* Legacy optional data. */ }
  for (const record of saved) mergeRating(library.ratings, library.jobs, record)
  for (const record of library.ratings.values()) await saveRating(prefix, record)
  const deck = {id:prefix, name:file.name, photos:[...library.jobs.keys()], skipped:library.skipped,
    selected:0, importedAt:now()}
  await put('decks', prefix, deck)
  return deck
}

export function importDeck(file) {
  return navigator.locks ? navigator.locks.request('ringo-import-deck', () => prepareDeck(file)) : prepareDeck(file)
}

export const ratingKey = (scope, record) => JSON.stringify([scope, record.photoId, record.raterId])
export const saveRating = (scope, record) => put('ratings', ratingKey(scope, record), {...record, scope})

export async function exportRatings(packId, ratings, total) {
  const {length:rated} = ratings
  const metadata = {format:resultsFormat, schemaVersion:1, packId,
    exportedAt:now(), totalPhotos:total, ratedPhotos:rated}
  const text = ratings.map(({scope, ...record}) => JSON.stringify(record) + '\n')
  return archive([['ringo.json', makeJson(metadata), true], ['ratings.jsonl', new Blob(text), true]])
}

async function mergeResultRecords(file, runs) {
  const zip = await openZip(file)
  const manifest = await json(zip, 'ringo.json', 1024 * 1024)
  if (manifest.schemaVersion !== 1 || manifest.format !== resultsFormat)
    throw new Error('请选择 Ringo 导出的听评结果 ZIP。')
  const jobs = new Map(runs.filter(run => run.listening).map(run => [run.id, {...run, candidates:run.listening}]))
  const saved = await all('ratings')
  const normalized = new Map()
  for (const {scope, ...record} of saved) {
    if (scope === 'mine') mergeRating(normalized, jobs, record)
  }
  const received = await (await zip.read('ratings.jsonl', 32 * 1024 * 1024)).text()
  let added = 0
  let skipped = 0
  for (const line of received.split('\n')) {
    if (!line.trim()) continue
    let record
    try { record = JSON.parse(line) } catch { skipped++; continue }
    if (!record || typeof record !== 'object') { skipped++; continue }
    const latest = normalized.get(JSON.stringify([record.photoId, record.raterId]))
    if ((latest && Date.parse(latest.ratedAt) >= Date.parse(record.ratedAt))
      || !mergeRating(normalized, jobs, record)) { skipped++; continue }
    await saveRating('mine', record)
    added++
  }
  return {added, skipped}
}

export function mergeResults(file, runs) {
  const merge = () => mergeResultRecords(file, runs)
  return navigator.locks ? navigator.locks.request('ringo-merge-results', merge) : merge()
}
