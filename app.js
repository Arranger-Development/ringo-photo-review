import {dimensions, makeRating} from './library.js'
import {defaultEndpoint, defaultModel, endpointFrom, generate} from './qwen.js?v=5'
import {duration, hash, id, now, renderVersion, validatePhoto} from './score.js'
import {getAudio, renderJob} from './renderer.js?v=3'
import {all, allKeys, get, photoKey, put} from './storage.js?v=2'
import {exportRatings, exportRuns, importDeck, mergeResults, ratingKey, saveFile, saveRating} from './packages.js?v=4'
import {failure, importAuditFiles, recordEvent, redactText, startTrace} from './diagnostics.js?v=1'

const element = id => document.getElementById(id)
const phaseNames = {queued:'待生成', intent:'千问读图', arrange:'千问编配', repair:'补生成',
  rendering:'合成 MP3', ready:'可试听', failed:'可重试'}
const runs = new Map()
const decks = new Map()
const active = new Set()
const ownRatingScope = 'mine'
let selectedRun
let startingRun = false
let currentDeck
let deckPhotos = []
let deckRatings = []
let currentRender
let renderLoop = false
let hasArchiveLogs = false
let singleRenderEpoch = 0
let deckRenderEpoch = 0
const singleURLs = new Set()
const deckURLs = new Set()

function node(tag, label, extra = {}) {
  const result = Object.assign(document.createElement(tag), extra)
  if (label !== undefined) result.textContent = label
  return result
}

function status(where, message, error = false) {
  const target = element(where)
  target.textContent = message
  target.classList.toggle('error', error)
}

function cleanup(urls) {
  for (const url of urls) URL.revokeObjectURL(url)
  urls.clear()
}

function src(blob, urls) {
  const url = URL.createObjectURL(blob)
  urls.add(url)
  return url
}

function photoView(job, urls) {
  return node('img', undefined, {className:'preview', src:src(job.photo, urls), alt:job.name})
}

function labelControl(text, control) {
  const label = node('label', text)
  label.append(control)
  return label
}

function play(candidate, blob, urls, job, packId) {
  const player = node('audio', undefined, {controls:true, preload:'none', src:src(blob, urls)})
  const context = {photoId:job.id, candidateId:candidate.id, label:candidate.label, packId}
  player.setAttribute('aria-label', '试听 ' + candidate.label)
  player.addEventListener('play', () => {
    for (const other of document.querySelectorAll('audio')) if (other !== player) other.pause()
    void recordEvent('browser', 'playback', 'started', context)
  })
  player.addEventListener('playing', () => void recordEvent('browser', 'playback', 'playing', context))
  player.addEventListener('ended', () => void recordEvent('browser', 'playback', 'succeeded',
    {...context, playbackSeconds:player.currentTime}))
  player.addEventListener('error', () => void recordEvent('browser', 'playback', 'failed', {...context,
    errorCode:'media_playback_failed', mediaErrorCode:player.error?.code, error:player.error?.message}))
  return player
}

function datePart() {
  return new Date().toISOString().slice(0, 10)
}

function switchMode(mode) {
  element('single').hidden = mode !== 'single'
  element('review').hidden = mode !== 'review'
  for (const name of ['single', 'review']) {
    const tab = element(name + '-tab')
    if (name === mode) tab.setAttribute('aria-current', 'page')
    else tab.removeAttribute('aria-current')
  }
  for (const audio of document.querySelectorAll('audio')) audio.pause()
}
for (const mode of ['single', 'review']) {
  element(mode + '-tab').addEventListener('click', event => {
    event.preventDefault()
    history.replaceState(null, '', '?mode=' + mode)
    switchMode(mode)
  })
}
const mode = new URLSearchParams(location.search).get('mode')
switchMode(mode === 'offline' || mode === 'review' ? 'review' : 'single')

function orderedRuns() {
  return [...runs.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

const roundLabel = job => '第 ' + job.round + ' 轮'
const runTitle = job => job.round ? job.name + ' · ' + roundLabel(job) : job.name
const rootOf = job => job.rootPhotoId ?? job.id

function updateGenerationControls() {
  const busy = startingRun || active.size > 0
  element('generate-button').disabled = busy
  const more = element('generate-more')
  if (more) more.disabled = busy
}

function renderRunList() {
  const list = orderedRuns()
  element('run-count').textContent = list.length ? list.length + ' 条记录' : '暂无记录'
  element('export-runs').disabled = (!list.length && !hasArchiveLogs) || active.size > 0
  element('run-list').replaceChildren(...list.map(job => {
    const row = node('button', undefined, {type:'button', title:runTitle(job)})
    row.toggleAttribute('aria-current', job.id === selectedRun)
    const phase = phaseNames[job.phase] ?? job.phase
    row.append(node('span', job.name), node('span', job.round ? roundLabel(job) + ' · ' + phase : phase))
    row.addEventListener('click', () => {
      selectedRun = job.id
      renderRunList()
      void renderSingle()
    })
    const item = node('li')
    item.append(row)
    return item
  }))
}

const showTime = value => value ? new Date(value).toLocaleTimeString() : '—'
function updateWaitingTimes() {
  for (const item of element('single-detail').querySelectorAll('[data-wait-since]')) {
    const seconds = Math.max(0, Math.floor((Date.now() - Date.parse(item.dataset.waitSince)) / 1000))
    item.textContent = ' · 已等待 ' + seconds + ' 秒'
  }
}
setInterval(updateWaitingTimes, 1000)

function callLog(job) {
  const details = node('details')
  details.append(node('summary', '调用与合成记录（' + job.calls.length + ' 次千问请求）'))
  const items = node('ol', undefined, {className:'log'})
  for (const call of job.calls) {
    const end = call.responseEndedAt ?? call.requestEndedAt
    const phase = phaseNames[call.phase] ?? call.phase
    const headers = call.headersMs === undefined ? '未收到可读 HTTP 响应' : '响应头 ' + call.headersMs + ' ms'
    const firstByte = call.firstByteMs === undefined ? '' : ' · 首字节 ' + call.firstByteMs + ' ms'
    const progress = call.outcome === 'interrupted' ? '页面已中断'
      : call.upstreamMs !== undefined ? '请求 ' + call.upstreamMs + ' ms'
        : call.firstByteAt ? '正在读取回包' : call.headersAt ? '已收到响应头' : '正在等待响应头'
    const item = node('li', phase + ' · ' + showTime(call.requestAt) + ' → ' + showTime(end) +
      '\n' + progress + ' · ' + headers + firstByte + (call.httpStatus ? ' · HTTP ' + call.httpStatus : '') +
      (call.validationError || call.error ? '\n' + (call.validationError || call.error) : ''))
    if (call.requestAt && !call.requestEndedAt && call.outcome !== 'interrupted' && active.has(job.id)) {
      const live = node('span')
      live.dataset.waitSince = call.fetchStartedAt ?? call.requestAt
      item.append(live)
    }
    items.append(item)
  }
  for (const event of job.events)
    items.append(node('li', '合成 · ' + showTime(event.startedAt) + ' → ' + showTime(event.endedAt) +
      ' · ' + event.durationMs + ' ms' + (event.error ? ' · ' + event.error : '')))
  if (!items.childElementCount) items.append(node('li', '等待生成。'))
  details.append(items)
  return details
}

async function renderSingle() {
  const epoch = ++singleRenderEpoch
  const job = runs.get(selectedRun)
  const target = element('single-detail')
  const rater = reviewer()
  const [audio, previous] = job?.phase === 'ready' ? await Promise.all([
    getAudio(job),
    get('ratings', ratingKey(ownRatingScope, {photoId:job.id, raterId:rater}))
  ]) : []
  if (epoch !== singleRenderEpoch) return
  target.hidden = !job
  element('single-empty').hidden = Boolean(job)
  const showLog = target.dataset.jobId === job?.id && target.querySelector('details')?.open
  target.dataset.jobId = job?.id ?? ''
  cleanup(singleURLs)
  target.replaceChildren()
  if (!job) return
  target.append(node('h2', runTitle(job)), photoView(job, singleURLs))
  const phase = node('p', job.error ?? (phaseNames[job.phase] ?? job.phase), {className:'status'})
  phase.setAttribute('role', 'status')
  phase.classList.toggle('error', Boolean(job.error))
  target.append(phase)
  if (job.intent) target.append(node('p', job.intent.summary, {className:'muted'}))
  if (audio) target.append(scoresForm(job, audio, {
    rater, previous, scope:ownRatingScope, urls:singleURLs, onSaved:updateMerged
  }))
  if (job.score && job.intent && (job.phase === 'ready' || job.phase === 'failed')) {
    const more = node('button', '生成更多', {id:'generate-more', type:'button'})
    more.addEventListener('click', () => void generateMore(job))
    target.append(more)
    updateGenerationControls()
  }
  if (job.phase === 'failed' && !active.has(job.id)) {
    const retry = node('button', '继续 / 重试', {type:'button'})
    retry.addEventListener('click', () => void processSingle(job, undefined, true))
    target.append(retry)
  }
  const log = callLog(job)
  log.open = Boolean(showLog)
  target.append(log)
  updateWaitingTimes()
}

function config() {
  const key = element('key').value.trim()
  const model = element('model').value.trim()
  if (!/^[!-~]{1,1024}$/.test(key)) throw new Error('请填写当前会话使用的百炼 API Key。')
  if (!/^[a-zA-Z0-9._-]{1,100}$/.test(model || defaultModel)) throw new Error('模型 ID 格式无效。')
  return {key, model:model || defaultModel, endpoint:endpointFrom(element('endpoint').value || defaultEndpoint)}
}

function changed(job) {
  runs.set(job.id, job)
  renderRunList()
  if (selectedRun === job.id) void renderSingle()
}

const currentKey = () => element('key').value.trim()
const diagnosticFailure = (error, code) => ({...failure(error, code), error:redactText(error?.message ?? String(error), currentKey())})

window.addEventListener('error', event => {
  if (!event.message) return
  void recordEvent('browser', 'uncaught_error', 'failed', {
    ...diagnosticFailure(event.error ?? event.message, 'uncaught_error'), line:event.lineno
  })
})
window.addEventListener('unhandledrejection', event => {
  void recordEvent('browser', 'uncaught_error', 'failed', diagnosticFailure(event.reason, 'unhandled_rejection'))
})

async function runSingle(job, supplied, isRetry) {
  if (active.has(job.id)) return
  active.add(job.id)
  const trace = startTrace('browser', isRetry ? 'retry' : 'generation', {
    photoId:job.id, rootPhotoId:rootOf(job), parentRunId:job.parentRunId, round:job.round ?? 1,
    attempt:job.score ? job.attempt : job.attempt + 1, previousPhase:job.phase
  })
  status('single-status', '')
  updateGenerationControls()
  try {
    if (!job.score) await generate(job, supplied ?? config(), changed)
    job.phase = 'rendering'
    job.error = undefined
    await put('runs', job.id, job)
    changed(job)
    const began = performance.now()
    const event = {kind:'render', startedAt:now(), attempt:job.attempt, renderVersion, telemetry:true}
    try {
      const audio = await renderJob(job, message => status('single-status', message))
      event.outcome = 'ready'
      event.candidates = audio.map(({id, render, audioSha256}) => ({id, render, audioSha256}))
      job.phase = 'ready'
      await trace.finish('succeeded')
      status('single-status', '试听已保存。')
    } catch (error) {
      event.outcome = 'failed'
      event.error = error.message
      throw error
    } finally {
      job.events.push({...event, endedAt:now(), durationMs:duration(began)})
    }
  } catch (error) {
    const stage = job.phase
    job.phase = 'failed'
    const details = diagnosticFailure(error, stage === 'rendering' ? 'render_failed' : 'generation_failed')
    job.error = details.error
    await trace.finish('failed', {...details, failedStage:stage})
    status('single-status', job.error, true)
  } finally {
    active.delete(job.id)
    updateGenerationControls()
    try { await put('runs', job.id, job) } catch (error) {
      void recordEvent('browser', 'generation_save', 'failed', {photoId:job.id, attempt:job.attempt,
        ...diagnosticFailure(error, 'storage_write_failed')})
      status('single-status', '无法保存浏览器数据 · ' + error.message, true)
    }
    changed(job)
  }
}

async function processSingle(job, supplied, isRetry = false) {
  if (!navigator.locks) return runSingle(job, supplied, isRetry)
  return navigator.locks.request('ringo-generate-' + job.id, {ifAvailable:true}, async lock => {
    if (!lock) {
      void recordEvent('browser', 'retry', 'skipped', {photoId:job.id, errorCode:'already_processing'})
      return status('single-status', '该照片已在另一个标签页处理。')
    }
    const saved = await get('runs', job.id)
    if (saved?.phase === 'ready') return changed(saved)
    await runSingle(saved ?? job, supplied, isRetry)
  })
}

element('generate').addEventListener('submit', async event => {
  event.preventDefault()
  if (startingRun || active.size) return
  startingRun = true
  updateGenerationControls()
  const photo = element('photo-input').files[0]
  const photoId = id()
  const trace = startTrace('browser', 'photo_select', {photoId, mimeType:photo?.type, imageBytes:photo?.size})
  hasArchiveLogs = true
  try {
    const supplied = config()
    if (!photo) throw new Error('请先选择一张照片。')
    await validatePhoto(photo)
    const job = {
      id:photoId, name:photo.name.slice(0, 255), photo, mimeType:photo.type, photoSha256:await hash(photo), createdAt:now(),
      rootPhotoId:photoId, round:1, count:Number(element('count').value),
      renderVersion, attempt:0, calls:[], events:[], phase:'queued'
    }
    await put('runs', job.id, job)
    await trace.finish('succeeded', {photoSha256:job.photoSha256, candidateCount:job.count})
    selectedRun = job.id
    changed(job)
    element('photo-input').value = ''
    await processSingle(job, supplied)
  } catch (error) {
    await trace.finish('failed', diagnosticFailure(error, 'photo_selection_failed'))
    status('single-status', error.message, true)
    renderRunList()
  } finally {
    startingRun = false
    updateGenerationControls()
  }
})

async function generateMore(source) {
  if (startingRun || active.size) return
  startingRun = true
  updateGenerationControls()
  const rootPhotoId = rootOf(source)
  const trace = startTrace('browser', 'generate_more', {rootPhotoId, parentRunId:source.id})
  try {
    const supplied = config()
    const count = Number(element('count').value)
    const addRound = async () => {
      const related = (await all('runs')).filter(job => rootOf(job) === rootPhotoId)
        .sort((a, b) => (b.round ?? 1) - (a.round ?? 1))
      const pastCandidates = related.filter(job => job.score).slice(0, 3)
        .flatMap(job => job.score.candidates)
      const {name, photo, mimeType, photoSha256, intent} = source
      const job = {
        id:id(), rootPhotoId, parentRunId:source.id, round:(related[0]?.round ?? 1) + 1,
        name, photo, mimeType, photoSha256, intent, count, createdAt:now(), renderVersion,
        previousDirections:pastCandidates.map(candidate => ({
          direction:candidate.direction,
          timbres:candidate.tracks.map(track => track.timbreId)
        })),
        attempt:0, calls:[], events:[], phase:'queued'
      }
      await put('runs', job.id, job)
      return job
    }
    const job = navigator.locks
      ? await navigator.locks.request('ringo-photo-round-' + rootPhotoId, addRound)
      : await addRound()
    await trace.finish('succeeded', {photoId:job.id, round:job.round, candidateCount:count})
    selectedRun = job.id
    changed(job)
    await processSingle(job, supplied)
  } catch (error) {
    const details = diagnosticFailure(error, 'generate_more_failed')
    await trace.finish('failed', details)
    status('single-status', details.error, true)
  } finally {
    startingRun = false
    updateGenerationControls()
  }
}

async function withDownload(button, where, create, name, context) {
  const trace = startTrace('browser', 'zip_export', context)
  button.disabled = true
  status(where, '正在打包…')
  try {
    const bundle = await create()
    saveFile(bundle, name + '-' + datePart() + '.zip')
    await trace.finish('handed_to_browser', {zipBytes:bundle.size})
    status(where, '打包完成。')
  } catch (error) {
    await trace.finish('failed', diagnosticFailure(error, 'zip_export_failed'))
    status(where, error.message, true)
  }
  finally { button.disabled = false }
}
element('export-runs').addEventListener('click', event => {
  void withDownload(event.currentTarget, 'single-status', () => exportRuns(orderedRuns().reverse()), 'Ringo-我的编配库', {scope:'generation'})
})
element('import-audit').addEventListener('change', async event => {
  const input = event.currentTarget
  if (!input.files.length) return
  input.disabled = true
  const trace = startTrace('browser', 'audit_import', {scope:'generation', fileCount:input.files.length})
  hasArchiveLogs = true
  try {
    const result = await importAuditFiles([...input.files], orderedRuns(), currentKey())
    await trace.finish('succeeded', result)
    status('single-status', '审计日志 · 匹配 ' + result.matched + ' · 重复 ' + result.duplicate +
      ' · 未匹配 ' + result.unmatched + ' · 格式错误 ' + result.invalid)
  } catch (error) {
    await trace.finish('failed', diagnosticFailure(error, 'audit_import_failed'))
    status('single-status', error.message, true)
  } finally { input.value = ''; input.disabled = false; renderRunList() }
})

element('import-results').addEventListener('change', async event => {
  const input = event.currentTarget
  const file = input.files[0]
  if (!file) return
  input.disabled = true
  const sourceType = /\.jsonl$/i.test(file.name) ? 'jsonl' : 'zip'
  const trace = startTrace('browser', 'rating_merge', {scope:'merge', sourceType,
    sourceBytes:file.size, zipBytes:sourceType === 'zip' ? file.size : undefined})
  status('single-status', '正在检查并合并评分…')
  try {
    const {added, skipped, sourcePackId} = await mergeResults(file, orderedRuns())
    await trace.finish('succeeded', {added, skipped, sourcePackId})
    status('single-status', '合并 ' + added + ' 条评分 · 跳过 ' + skipped + ' 条已有、较旧或不匹配的评分。')
    if (added) await renderSingle()
    await updateMerged()
  } catch (error) {
    await trace.finish('failed', diagnosticFailure(error, 'rating_merge_failed'))
    status('single-status', error.message, true)
  }
  finally { input.value = ''; input.disabled = false }
})
async function updateMerged() {
  element('export-merged').disabled = !(await all('ratings')).some(item => item.scope === 'mine')
}
element('export-merged').addEventListener('click', event => {
  void withDownload(event.currentTarget, 'single-status', async () => {
    const records = (await all('ratings')).filter(item => item.scope === 'mine')
    return exportRatings(null, records, new Set(records.map(item => item.photoId)).size)
  }, 'Ringo-汇总评分', {scope:'merge'})
})

const reviewer = () => element('rater').value.trim()
function setReviewer(value) {
  element('rater').value = element('single-rater').value = value
}
const isRated = job => deckRatings.some(record => record.photoId === job.id && record.raterId === reviewer())
const currentRatings = () => deckRatings.filter(record => record.raterId === reviewer())
function deckProgress() {
  if (!currentDeck) return
  const done = deckPhotos.filter(job => job.phase === 'ready').length
  const rated = deckPhotos.filter(isRated).length
  const failed = deckPhotos.filter(job => job.phase === 'failed').length
  element('review-progress').textContent = '已可试听 ' + done + ' / ' + deckPhotos.length +
    ' · 已评 ' + rated + ' / ' + deckPhotos.length +
    (failed ? ' · 合成失败 ' + failed + ' 张' : '') +
    (currentDeck.skipped ? ' · 包内未完成编配 ' + currentDeck.skipped + ' 张' : '')
  element('retry-renders').hidden = !failed || renderLoop
  element('export-ratings').disabled = !currentRatings().length
  const jump = element('jump')
  jump.replaceChildren(...deckPhotos.map((job, index) => node('option',
    (index + 1) + ' · ' + runTitle(job) + (isRated(job) ? '（已评）' : '（' + (phaseNames[job.phase] ?? job.phase) + '）'),
    {value:String(index), selected:index === currentDeck.selected})))
}

async function selectCard(index, focus = true) {
  const deck = currentDeck
  if (!deck || index < 0 || index >= deckPhotos.length) return
  deck.selected = index
  await put('decks', deck.id, deck)
  if (deck !== currentDeck) return
  deckProgress()
  await renderCard()
  if (focus) element('card-title')?.focus()
}

function scoresForm(job, audio, {rater, previous, scope, packId, urls, onSaved, advance}) {
  const form = node('form')
  const cards = node('div', undefined, {className:'players'})
  const inputs = new Map()
  const none = node('input', undefined, {type:'checkbox', checked:previous?.none ?? false})
  const note = node('textarea', undefined, {maxLength:1000, rows:2, value:previous?.note ?? ''})
  for (const candidate of job.listening) {
    const track = audio.find(item => item.id === candidate.id)
    const card = node('fieldset', undefined, {className:'player'})
    card.append(node('legend', candidate.label), play(candidate, track.audio, urls, job, packId))
    const row = node('div', undefined, {className:'dimensions'})
    const points = {}
    for (const [key, label] of Object.entries(dimensions)) {
      const select = node('select', undefined, {required:true})
      select.append(node('option', '—', {value:''}))
      for (let score = 1; score <= 5; score++) select.append(node('option', String(score), {value:String(score)}))
      select.value = previous?.scores[candidate.id]?.[key] ?? ''
      points[key] = select
      row.append(labelControl(label, select))
    }
    const picks = node('div', undefined, {className:'picks'})
    const favorite = node('input', undefined, {type:'checkbox', checked:previous?.favorites.includes(candidate.id) ?? false})
    const usable = node('input', undefined, {type:'checkbox',
      checked:(previous?.usable ?? previous?.favorites)?.includes(candidate.id) ?? false})
    favorite.addEventListener('change', () => { if (favorite.checked) { usable.checked = true; none.checked = false } })
    usable.addEventListener('change', () => {
      if (usable.checked) none.checked = false
      else favorite.checked = false
    })
    picks.append(labelControl('首选', favorite), labelControl('可用', usable))
    card.append(row, picks)
    cards.append(card)
    inputs.set(candidate.id, {points, favorite, usable})
  }
  none.addEventListener('change', () => {
    if (none.checked) for (const values of inputs.values()) values.favorite.checked = values.usable.checked = false
  })
  const rubric = node('details')
  rubric.append(node('summary', '评分标准'), node('p', '1 分表示明显不合适，3 分表示基本成立，5 分表示表现准确。可并列首选。'))
  const noneLabel = labelControl('都不合适', none)
  noneLabel.className = 'check'
  const actions = node('div', undefined, {className:'deck-actions'})
  const save = node('button', '保存评分', {type:'submit', className:advance ? '' : 'primary'})
  const next = advance && node('button', advance.label, {type:'submit', className:'primary'})
  const message = node('p', previous ? '已保存，可修改。' : '', {className:'status'})
  message.setAttribute('role', 'status')
  actions.append(save)
  if (next) actions.append(next)
  const setSaving = disabled => {
    save.disabled = disabled
    if (next) next.disabled = disabled
  }
  form.append(rubric, cards, noneLabel, labelControl('备注', note), actions, message)
  form.addEventListener('submit', async event => {
    event.preventDefault()
    setSaving(true)
    message.classList.remove('error')
    const trace = startTrace('browser', 'rating_save', {packId, photoId:job.id, scope,
      candidateCount:job.listening.length})
    try {
      if (!rater) throw new Error('请先填写评审名。')
      const scores = {}
      const favorites = []
      const usable = []
      for (const [id, fields] of inputs) {
        scores[id] = Object.fromEntries(Object.entries(fields.points).map(([key, input]) => [key, Number(input.value)]))
        if (fields.usable.checked) usable.push(id)
        if (fields.favorite.checked) favorites.push(id)
      }
      const record = makeRating({...job, candidates:job.listening}, rater,
        {scores, favorites, usable, none:none.checked, note:redactText(note.value, currentKey())})
      await saveRating(scope, record)
      await trace.finish('succeeded')
      message.textContent = '评分已保存。'
      await onSaved(record)
      if (next && event.submitter === next) await advance.run()
    } catch (error) {
      await trace.finish('failed', diagnosticFailure(error, 'rating_save_failed'))
      message.textContent = error.message
      message.classList.add('error')
    }
    finally { setSaving(false) }
  })
  return form
}

async function renderCard() {
  const epoch = ++deckRenderEpoch
  const deck = currentDeck
  const job = deck && deckPhotos[deck.selected]
  const audio = job && job.phase === 'ready' ? await getAudio(job) : undefined
  if (epoch !== deckRenderEpoch) return
  const target = element('review-detail')
  target.hidden = !job
  element('review-empty').hidden = Boolean(job)
  cleanup(deckURLs)
  target.replaceChildren()
  if (!job) return
  const heading = node('h3', runTitle(job), {id:'card-title', tabIndex:-1})
  const row = node('div', undefined, {className:'control-row'})
  const position = node('p', '第 ' + (deck.selected + 1) + ' / ' + deck.photos.length + ' 张', {className:'muted'})
  const actions = node('div', undefined, {className:'deck-actions'})
  for (const [offset, label] of [[-1, '上一张'], [1, '下一张']]) {
    const index = deck.selected + offset
    const button = node('button', label, {type:'button', disabled:index < 0 || index >= deck.photos.length})
    button.addEventListener('click', () => void selectCard(index))
    actions.append(button)
  }
  row.append(position, actions)
  target.append(row, heading, photoView(job, deckURLs))
  if (audio) {
    const rater = reviewer()
    target.append(scoresForm(job, audio, {
      rater, previous:deckRatings.find(record => record.photoId === job.id && record.raterId === rater),
      scope:deck.id, packId:deck.id, urls:deckURLs,
      onSaved:record => {
        if (deck !== currentDeck) return
        const key = ratingKey(deck.id, record)
        deckRatings = deckRatings.filter(item => ratingKey(deck.id, item) !== key).concat({...record, scope:deck.id})
        deckProgress()
      },
      advance:{
        label:deck.selected === deck.photos.length - 1 ? '保存并完成' : '保存并下一张',
        run:async () => {
          if (deck !== currentDeck || deck.photos[deck.selected] !== job.id || rater !== reviewer()) return
          if (deck.selected + 1 < deck.photos.length) await selectCard(deck.selected + 1)
          else status('review-status', currentRatings().length === deck.photos.length
            ? '这份编配包已全部评完，可以下载结果 ZIP。' : '已到最后一张，可从进度选择尚未评的照片。')
        }
      }
    }))
  } else {
    const text = job.phase === 'failed' ? job.error : '试听在合成队列中，准备好后会出现在这里。'
    target.append(node('p', text, {className:job.phase === 'failed' ? 'error' : 'muted'}))
    if (job.phase === 'failed') {
      const retry = node('button', '重试这张', {type:'button'})
      retry.addEventListener('click', () => {
        void recordEvent('browser', 'render_retry', 'queued', {packId:deck.id, photoId:job.id, attempt:(job.renderAttempt ?? 0) + 1})
        job.phase = 'queued'
        void processDeck()
      })
      target.append(retry)
    }
  }
}

async function processDeck() {
  if (renderLoop || !currentDeck) return
  renderLoop = true
  try {
    while (currentDeck) {
      const deck = currentDeck
      const job = deckPhotos.find(photo => photo.phase === 'queued' || photo.phase === 'rendering')
      if (!job) break
      currentRender = {deckId:deck.id, job}
      if (job.phase === 'rendering') void recordEvent('browser', 'render_resume', 'queued', {
        packId:deck.id, photoId:job.id, attempt:job.renderAttempt
      })
      job.phase = 'rendering'
      job.renderAttempt = (job.renderAttempt ?? 0) + 1
      await put('photos', photoKey(deck.id, job.id), job)
      if (currentDeck === deck) deckProgress()
      try {
        await renderJob(job, message => {
          if (currentDeck === deck) status('review-status', '第 ' + (deck.photos.indexOf(job.id) + 1) + ' 张 · ' + message)
        }, deck.id)
        job.phase = 'ready'
        job.error = undefined
      } catch (error) {
        job.phase = 'failed'
        job.error = error.message
      }
      await put('photos', photoKey(deck.id, job.id), job)
      if (currentDeck === deck) {
        deckProgress()
        if (deck.photos[deck.selected] === job.id) await renderCard()
      }
    }
  } catch (error) {
    void recordEvent('browser', 'review_progress_save', 'failed', {packId:currentDeck?.id,
      photoId:currentRender?.job.id, ...diagnosticFailure(error, 'storage_write_failed')})
    status('review-status', '无法保存听评进度 · ' + error.message, true)
  }
  finally {
    renderLoop = false
    currentRender = undefined
    deckProgress()
    if (currentDeck && deckPhotos.every(job => job.phase === 'ready' || job.phase === 'failed'))
      status('review-status', deckPhotos.some(job => job.phase === 'failed') ? '队列完成，有照片可重试。' : '本包试听已准备好。')
  }
}

function deckOptions() {
  const select = element('deck-select')
  select.replaceChildren(...[...decks.values()].sort((a, b) => b.importedAt.localeCompare(a.importedAt))
    .map(deck => node('option', deck.name, {value:deck.id, selected:deck.id === currentDeck?.id})))
  element('deck-control').hidden = !decks.size
}

let deckSelection = 0
async function openDeck(deck) {
  const selection = ++deckSelection
  const photos = await Promise.all(deck.photos.map(id => get('photos', photoKey(deck.id, id))))
  const ratings = (await all('ratings')).filter(record => record.scope === deck.id)
  if (selection !== deckSelection) return
  currentDeck = deck
  deckPhotos = photos.map(job => currentRender?.deckId === deck.id && currentRender.job.id === job.id
    ? currentRender.job : job)
  deckRatings = ratings
  element('review-controls').hidden = false
  deckOptions()
  deckProgress()
  await put('settings', 'deck', deck.id)
  await renderCard()
  void processDeck()
}

async function importReview(event) {
  const input = event.currentTarget
  const files = [...input.files]
  if (!files.length) return
  const folder = input.id === 'import-deck-folder'
  const controls = [element('import-deck'), element('import-deck-folder')]
  for (const control of controls) control.disabled = true
  status('review-import-status', folder ? '正在检查编配文件夹…' : '正在检查并导入 ZIP…')
  const trace = startTrace('browser', folder ? 'folder_import' : 'zip_import', {
    scope:'review', sourceType:folder ? 'folder' : 'zip', fileCount:files.length,
    zipBytes:folder ? undefined : files[0].size
  })
  hasArchiveLogs = true
  let importedPackId
  try {
    const deck = await importDeck(folder ? files : files[0])
    importedPackId = deck.id
    decks.set(deck.id, deck)
    await trace.finish('succeeded', {packId:deck.id, photoCount:deck.photos.length, skipped:deck.skipped})
    status('review-import-status', '导入完成 · ' + deck.photos.length + ' 张。')
    await openDeck(deck)
  } catch (error) {
    await trace.finish('failed', {packId:importedPackId,
      ...diagnosticFailure(error, folder ? 'folder_import_failed' : 'zip_import_failed')})
    status('review-import-status', error.message, true)
  } finally {
    input.value = ''
    for (const control of controls) control.disabled = false
    renderRunList()
  }
}
for (const field of ['import-deck', 'import-deck-folder']) element(field).addEventListener('change', importReview)
element('deck-select').addEventListener('change', event => {
  void openDeck(decks.get(event.currentTarget.value)).catch(error => status('review-status', error.message, true))
})
element('jump').addEventListener('change', event => void selectCard(Number(event.currentTarget.value)))
for (const field of ['rater', 'single-rater']) {
  element(field).addEventListener('change', async event => {
    const value = event.currentTarget.value.trim()
    setReviewer(value)
    deckProgress()
    await Promise.all([put('settings', 'rater', value), renderSingle(), renderCard()])
  })
}
element('retry-renders').addEventListener('click', () => {
  for (const job of deckPhotos) {
    if (job.phase !== 'failed') continue
    void recordEvent('browser', 'render_retry', 'queued', {packId:currentDeck.id, photoId:job.id,
      attempt:(job.renderAttempt ?? 0) + 1})
    job.phase = 'queued'
  }
  void processDeck()
})
element('export-ratings').addEventListener('click', event => {
  const deck = currentDeck
  void withDownload(event.currentTarget, 'review-status',
    () => exportRatings(deck.id, currentRatings(), deck.photos.length), 'Ringo-听评结果', {packId:deck.id, scope:'review'})
})

async function restoreRun(run) {
  if (!['queued', 'intent', 'arrange', 'repair', 'rendering'].includes(run.phase)) return run
  const interrupt = async () => {
    const latest = await get('runs', run.id)
    if (!latest || ['ready', 'failed'].includes(latest.phase)) return latest ?? run
    for (const call of latest.calls) {
      if (call.requestEndedAt || call.outcome === 'interrupted') continue
      call.outcome = 'interrupted'
      call.errorCode = 'page_interrupted'
      call.interruptionObservedAt = now()
      call.error = '页面中断，未记录到完整回包。'
    }
    const phase = latest.phase
    latest.phase = 'failed'
    latest.error = '上次处理已中断。可从已保存的阶段继续。'
    await put('runs', latest.id, latest)
    await recordEvent('browser', 'page_interrupt', 'interrupted', {photoId:latest.id,
      attempt:latest.attempt, interruptedStage:phase, errorCode:'page_interrupted'})
    return latest
  }
  return navigator.locks
    ? navigator.locks.request('ringo-generate-' + run.id, {ifAvailable:true}, lock => lock ? interrupt() : run)
    : interrupt()
}

async function restore() {
  hasArchiveLogs ||= (await allKeys('audits')).length > 0 || (await allKeys('diagnostics')).length > 0
  for (const run of await all('runs')) runs.set(run.id, await restoreRun(run))
  setReviewer(await get('settings', 'rater') ?? '')
  selectedRun = orderedRuns()[0]?.id
  renderRunList()
  await renderSingle()
  await updateMerged()
  for (const deck of await all('decks')) decks.set(deck.id, deck)
  deckOptions()
  const recent = decks.get(await get('settings', 'deck'))
  if (recent) await openDeck(recent)
}
restore().catch(error => {
  status('fatal', '无法读取浏览器工作台 · ' + error.message, true)
  element('fatal').hidden = false
})
