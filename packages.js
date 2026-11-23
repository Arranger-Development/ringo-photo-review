import {Zip, ZipDeflate, ZipPassThrough} from './vendor/fflate.js'
import {openZip} from './zip.js'
import {loadLibrary, mergeRating} from './library.js'
import {hash, hashPattern, id, loadSpecs, mimeTypes, now, photoIdPattern, photoLimit,
  renderVersion, scoreIssues, validListening, validatePhoto} from './score.js'
import {all, audioKey, get, photoKey, put} from './storage.js?v=2'
import {logSchemaVersion, readDiagnostics, redactResponse, requestId, requestLinks, sanitize} from './diagnostics.js?v=2'

const partLimit = 8 * 1024 * 1024
const ratingsLimit = 32 * 1024 * 1024
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

const jsonLines = rows => new Blob(rows.map(row => JSON.stringify(row) + '\n'), {type:'application/x-ndjson'})
const logIndexPath = 'logs/index.json'
const diagnosticsManifest = {schemaVersion:logSchemaVersion, indexPath:logIndexPath}

function errorCodeFor(call) {
  if (call.errorCode) return call.errorCode
  if (call.outcome === 'interrupted') return 'page_interrupted'
  if (call.outcome === 'rejected') return 'validation_rejected'
  if (call.errorType === 'TimeoutError') return 'request_timeout'
  if (call.errorType === 'TypeError' && !call.responseComplete) return 'network_error'
  if (call.httpStatus >= 400) return 'http_error'
  if (call.outcome === 'failed') return 'request_failed'
}

function callLogs(run, call, audits) {
  const {rawResponse, requestSnapshot, ...fields} = call
  const files = []
  const log = sanitize({...fields, eventId:'qwen:' + call.id, schemaVersion:logSchemaVersion,
    kind:'qwen_request', category:'qwen', stage:call.phase, photoId:run.id, callId:call.id,
    at:call.requestAt, errorCode:errorCodeFor(call) ?? null, photoPath:'photos/' + run.id + '/photo'})
  if (requestSnapshot) {
    log.requestPath = 'logs/qwen/requests/' + call.id + '.json'
    files.push([log.requestPath,makeJson(sanitize(requestSnapshot)),true,1])
  }
  if (rawResponse !== undefined) {
    const raw = redactResponse(rawResponse)
    let extension = 'txt'
    try { JSON.parse(raw); extension = 'json' } catch { /* Preserve partial and non-JSON responses as text. */ }
    log.rawResponsePath = 'logs/qwen/responses/' + call.id + '.' + extension
    files.push([log.rawResponsePath,new Blob([raw]),true,1])
  }
  const providerId = requestId(log.providerRequestId)
  if (providerId) log.auditEventId = audits.get(providerId)?.eventId ?? null
  return {log, files}
}

async function* archiveLogs({kind, packId, rows, audits = [], links = new Map(), rawCalls = [], files = [], writeFailures}) {
  const index = {schemaVersion:logSchemaVersion, exportedAt:now(), kind, packId, writeFailures, files:[],
    bailian:{matched:0, unmatched:0, requestsWithoutId:rawCalls.filter(call => !requestId(call.providerRequestId)).length,
      requestsWithoutAudit:rawCalls.filter(call => requestId(call.providerRequestId) && !call.auditEventId).length}}
  const items = [...files]
  const eventRows = rows.filter(row => row.category !== 'render')
  const renderRows = rows.filter(row => row.category === 'render')
  const byTime = (a, b) => (a.at ?? '').localeCompare(b.at ?? '') || a.eventId.localeCompare(b.eventId)
  const auditRows = []
  for (const {raw = [], ...row} of audits) {
    const calls = links.get(row.providerRequestId) ?? []
    const match = calls.length ? 'matched' : 'unmatched'
    index.bailian[match]++
    const rawPaths = []
    for (const evidence of raw) {
      const path = 'logs/bailian/raw/' + evidence.sha256 + '.json'
      rawPaths.push(path)
      items.push([path,makeJson(evidence.value),true,1])
    }
    auditRows.push({...row, match, calls, rawPaths})
  }
  for (const [name, list] of [
    ['logs/browser/events.jsonl', eventRows], ['logs/render/events.jsonl', renderRows],
    ['logs/qwen/calls.jsonl', rawCalls], ['logs/bailian/audit.jsonl', auditRows]
  ]) items.push([name,jsonLines(list.sort(byTime)),true,list.length])
  const added = new Set()
  for (const [path, blob, compress, count] of items) {
    if (added.has(path)) continue
    added.add(path)
    index.files.push({path, count})
    yield [path, blob, compress]
  }
  yield [logIndexPath, makeJson(index), true]
}

export async function exportRuns(runs) {
  const packId = id()
  const {events, writeFailures} = await readDiagnostics()
  const audits = await all('audits')
  const byRequest = new Map(audits.filter(row => row.providerRequestId).map(row => [row.providerRequestId, row]))
  async function* entries() {
    const index = []
    const rawCalls = []
    const files = []
    const rows = events.filter(event => !event.packId)
    for (const run of runs) {
      const folder = 'photos/' + run.id + '/'
      index.push(run.id)
      const {id, name, mimeType, photoSha256, count, phase, createdAt, renderVersion, soundfontSha256, model, endpoint,
        error, attempt, rootPhotoId, parentRunId, round} = run
      yield [folder + 'state.json', makeJson(sanitize({id, name, mimeType, photoSha256, count, phase, createdAt,
        renderVersion, soundfontSha256, model, endpoint, error, attempt, rootPhotoId, parentRunId, round})), true]
      yield [folder + 'photo', run.photo, false]
      if (run.intent) yield [folder + 'intent.json', makeJson(run.intent), true]
      if (run.score) yield [folder + 'arrangements.json', makeJson(run.score), true]
      if (run.listening) yield [folder + 'listen.json', makeJson(run.listening), true]
      if (run.partial) yield [folder + 'partial.json', makeJson(run.partial), true]
      const legacy = []
      for (const call of run.calls ?? []) {
        const exported = callLogs(run, call, byRequest)
        legacy.push(exported.log)
        rawCalls.push(exported.log)
        files.push(...exported.files)
      }
      for (const [position, event] of (run.events ?? []).entries()) {
        const row = sanitize({...event, photoId:id, eventId:'render:' + id + ':' + (event.startedAt ?? position),
          schemaVersion:logSchemaVersion, category:'render', stage:'render', at:event.endedAt ?? event.startedAt,
          errorCode:event.outcome === 'failed' ? 'render_failed' : undefined})
        legacy.push(row)
        if (!event.telemetry) rows.push(row)
      }
      yield [folder + 'events.jsonl', jsonLines(legacy), true]
    }
    yield* archiveLogs({kind:compatibility, packId, rows, audits, links:requestLinks(runs),
      rawCalls, files, writeFailures})
    yield ['ringo.json', makeJson({format:compatibility, schemaVersion:1, packId, exportedAt:now(),
      photos:index, diagnostics:diagnosticsManifest}), true]
  }
  return archive(entries())
}

async function json(zip, name, limit = partLimit) {
  return JSON.parse(await (await zip.read(name, limit)).text())
}

async function prepareDeck(archive, name) {
  const manifest = await json(archive, 'ringo.json', 1024 * 1024)
  if (manifest.format === resultsFormat)
    throw new Error('这是评分结果。请到「单图验证」的「导入听评结果」导入。')
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
    const state = await json(archive, folder + 'state.json', 128 * 1024)
    if (!archive.has(folder + 'arrangements.json')) {
      skipped++
      continue
    }
    if (state.id !== id || !hashPattern.test(state.photoSha256) || !mimeTypes.includes(state.mimeType) ||
      !Number.isFinite(Date.parse(state.createdAt)) || typeof state.name !== 'string' || state.name.length > 255 ||
      !Number.isInteger(state.count) || state.count < 4 || state.count > 8 || state.renderVersion !== renderVersion ||
      state.soundfontSha256 !== catalog.soundfontSha256)
      throw new Error('编配包里的照片索引或渲染版本无效。')
    const photo = new Blob([await archive.read(folder + 'photo', photoLimit)], {type:state.mimeType})
    await validatePhoto(photo)
    if (await hash(photo) !== state.photoSha256) throw new Error(state.name + ' 的照片哈希不匹配。')
    const score = await json(archive, folder + 'arrangements.json')
    const listening = await json(archive, folder + 'listen.json', 128 * 1024)
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
  if (!imported.length) throw new Error('这份编配包中没有可用于听评的记录。')
  const deck = {id:prefix, name, photos:imported, skipped, selected:0, importedAt:now()}
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

function openDeckFolder(files) {
  const name = files[0]?.webkitRelativePath.split('/')[0]
  const entries = new Map()
  for (const file of files) {
    const path = file.webkitRelativePath
    if (!name || !path.startsWith(name + '/')) throw new Error('请选择一个完整的编配文件夹。')
    entries.set(path.slice(name.length + 1), file)
  }
  if (!entries.has('ringo.json') || ![...entries.keys()].some(path => path.startsWith('photos/')))
    throw new Error('请选择含 ringo.json 和 photos 的整个编配文件夹。')
  return {name, archive:{
    has: path => entries.has(path),
    read: async (path, limit) => {
      const file = entries.get(path)
      if (!file || file.size > limit) throw new Error('文件缺失或超出大小限制：' + path)
      return file
    }
  }}
}

export function importDeck(source) {
  const load = async () => {
    if (Array.isArray(source)) {
      const {archive, name} = openDeckFolder(source)
      return prepareDeck(archive, name)
    }
    if (/\.jsonl$/i.test(source.name))
      throw new Error('单个 JSONL 不能用于批量听评。请选择完整编配 ZIP，或解压后的整个编配文件夹。')
    const zip = await openZip(source)
    return zip.has('ringo.json') ? prepareDeck(zip, source.name) : prepareLegacyDeck(source)
  }
  return navigator.locks ? navigator.locks.request('ringo-import-deck', load) : load()
}

export const ratingKey = (scope, record) => JSON.stringify([scope, record.photoId, record.raterId])
export const saveRating = (scope, record) => put('ratings', ratingKey(scope, record), {...record, scope})

export async function exportRatings(packId, ratings, total) {
  const {length:rated} = ratings
  const metadata = {format:resultsFormat, schemaVersion:1, packId,
    exportedAt:now(), totalPhotos:total, ratedPhotos:rated, diagnostics:diagnosticsManifest}
  const {events, writeFailures} = await readDiagnostics()
  const inScope = event => packId ? event.packId === packId : event.scope === 'merge' || event.scope === 'mine'
  const operations = new Set(events.filter(inScope).map(event => event.operationId).filter(Boolean))
  const rows = events.filter(event => inScope(event) || operations.has(event.operationId))
  async function* entries() {
    yield ['ringo.json', makeJson(metadata), true]
    yield ['ratings.jsonl', jsonLines(ratings.map(({scope, ...record}) => sanitize(record))), true]
    yield* archiveLogs({kind:resultsFormat, packId, rows, writeFailures})
  }
  return archive(entries())
}

async function readResultFile(file) {
  if (/\.jsonl$/i.test(file.name)) {
    if (file.size > ratingsLimit) throw new Error('评分 JSONL 超出大小限制。')
    return {received:await file.text(), fileType:'jsonl'}
  }
  const zip = await openZip(file)
  if (!zip.has('ringo.json')) throw new Error('请选择 Ringo 导出的听评结果 ZIP 或 ratings.jsonl。')
  const manifest = await json(zip, 'ringo.json', 1024 * 1024)
  if (manifest.format === compatibility)
    throw new Error('这是编配库。请到「批量听评」的「选择编配 ZIP」导入。')
  if (manifest.schemaVersion !== 1 || manifest.format !== resultsFormat)
    throw new Error('请选择 Ringo 导出的听评结果 ZIP 或 ratings.jsonl。')
  return {received:await (await zip.read('ratings.jsonl', ratingsLimit)).text(),
    sourcePackId:manifest.packId, fileType:'zip'}
}

async function mergeResultRecords(file, runs) {
  const {received, sourcePackId, fileType} = await readResultFile(file)
  const jobs = new Map(runs.filter(run => run.listening).map(run => [run.id, {...run, candidates:run.listening}]))
  const saved = await all('ratings')
  const normalized = new Map()
  for (const {scope, ...record} of saved) {
    if (scope === 'mine') mergeRating(normalized, jobs, record)
  }
  let foundRatings = false
  let added = 0
  let skipped = 0
  for (const line of received.split('\n')) {
    if (!line.trim()) continue
    let record
    try { record = JSON.parse(line) } catch { skipped++; continue }
    if (!record || typeof record !== 'object') { skipped++; continue }
    if (record.scores && typeof record.raterId === 'string' && typeof record.photoId === 'string') foundRatings = true
    const latest = normalized.get(JSON.stringify([record.photoId, record.raterId]))
    if ((latest && Date.parse(latest.ratedAt) >= Date.parse(record.ratedAt))
      || !mergeRating(normalized, jobs, record)) { skipped++; continue }
    await saveRating('mine', record)
    added++
  }
  if (fileType === 'jsonl' && !foundRatings)
    throw new Error('这个 JSONL 中没有评分。请选择评分 ZIP 或其中的 ratings.jsonl。')
  return {added, skipped, sourcePackId}
}

export function mergeResults(file, runs) {
  const merge = () => mergeResultRecords(file, runs)
  return navigator.locks ? navigator.locks.request('ringo-merge-results', merge) : merge()
}
