import {dimensions, makeRating} from './library.js'
import {defaultEndpoint, defaultModel, endpointFrom, generate} from './qwen.js'
import {duration, hash, id, now, renderVersion, validatePhoto} from './score.js'
import {getAudio, renderJob} from './renderer.js?v=2'
import {all, get, photoKey, put} from './storage.js'
import {exportRatings, exportRuns, importDeck, mergeResults, ratingKey, saveFile, saveRating} from './packages.js'

const element = id => document.getElementById(id)
const phaseNames = {queued:'待生成', intent:'千问读图', arrange:'千问编配', repair:'补生成',
  rendering:'合成 MP3', ready:'可试听', failed:'可重试'}
const runs = new Map()
const decks = new Map()
const active = new Set()
let selectedRun
let currentDeck
let deckPhotos = []
let deckRatings = []
let currentRender
let renderLoop = false
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

function play(label, blob, urls) {
  const player = node('audio', undefined, {controls:true, preload:'none', src:src(blob, urls)})
  player.setAttribute('aria-label', '试听 ' + label)
  player.addEventListener('play', () => {
    for (const other of document.querySelectorAll('audio')) if (other !== player) other.pause()
  })
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

function renderRunList() {
  const list = orderedRuns()
  element('run-count').textContent = list.length ? list.length + ' 条记录' : '暂无记录'
  element('export-runs').disabled = !list.length || active.size > 0
  element('run-list').replaceChildren(...list.map(job => {
    const row = node('button', undefined, {type:'button', title:job.name})
    row.toggleAttribute('aria-current', job.id === selectedRun)
    row.append(node('span', job.name), node('span', phaseNames[job.phase] ?? job.phase))
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
function callLog(job) {
  const details = node('details')
  details.append(node('summary', '调用与合成记录（' + job.calls.length + ' 次千问请求）'))
  const items = node('ol', undefined, {className:'log'})
  for (const call of job.calls) {
    const end = call.responseEndedAt ?? call.requestEndedAt
    const metrics = call.upstreamMs === undefined ? '请求尚未完成'
      : '请求 ' + call.upstreamMs + ' ms · 首字节 ' + (call.firstByteMs ?? '—') + ' ms'
    const phase = phaseNames[call.phase] ?? call.phase
    items.append(node('li', phase + ' · ' + showTime(call.requestAt) + ' → ' + showTime(end) +
      '\n' + metrics + (call.httpStatus ? ' · HTTP ' + call.httpStatus : '') +
      (call.validationError || call.error ? '\n' + (call.validationError || call.error) : '')))
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
  const audio = job?.listening ? await getAudio(job) : undefined
  if (epoch !== singleRenderEpoch) return
  target.hidden = !job
  element('single-empty').hidden = Boolean(job)
  cleanup(singleURLs)
  target.replaceChildren()
  if (!job) return
  target.append(node('h2', job.name), photoView(job, singleURLs))
  const phase = node('p', job.error ?? (phaseNames[job.phase] ?? job.phase), {className:'status'})
  phase.setAttribute('role', 'status')
  phase.classList.toggle('error', Boolean(job.error))
  target.append(phase)
  if (job.intent) target.append(node('p', job.intent.summary, {className:'muted'}))
  if (audio) {
    const players = node('div', undefined, {className:'players'})
    for (const candidate of job.listening) {
      const track = audio.find(item => item.id === candidate.id)
      const view = node('div', undefined, {className:'player'})
      view.append(node('strong', candidate.label), play(candidate.label, track.audio, singleURLs))
      players.append(view)
    }
    target.append(players)
  }
  if (!active.has(job.id) && job.phase !== 'ready') {
    const retry = node('button', '继续 / 重试', {type:'button'})
    retry.addEventListener('click', () => void processSingle(job))
    target.append(retry)
  }
  target.append(callLog(job))
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

async function runSingle(job, supplied) {
  if (active.has(job.id)) return
  active.add(job.id)
  element('generate-button').disabled = true
  try {
    if (!job.score) await generate(job, supplied ?? config(), changed)
    job.phase = 'rendering'
    job.error = undefined
    await put('runs', job.id, job)
    changed(job)
    const began = performance.now()
    const event = {kind:'render', startedAt:now(), attempt:job.attempt, renderVersion}
    try {
      const audio = await renderJob(job, message => status('single-status', message))
      event.outcome = 'ready'
      event.candidates = audio.map(({id, render, audioSha256}) => ({id, render, audioSha256}))
      job.phase = 'ready'
      status('single-status', '试听已保存。')
    } catch (error) {
      event.outcome = 'failed'
      event.error = error.message
      throw error
    } finally {
      job.events.push({...event, endedAt:now(), durationMs:duration(began)})
    }
  } catch (error) {
    job.phase = 'failed'
    job.error = error.message
    status('single-status', error.message, true)
  } finally {
    active.delete(job.id)
    element('generate-button').disabled = active.size > 0
    try { await put('runs', job.id, job) } catch (error) {
      status('single-status', '无法保存浏览器数据 · ' + error.message, true)
    }
    changed(job)
  }
}

async function processSingle(job, supplied) {
  if (!navigator.locks) return runSingle(job, supplied)
  return navigator.locks.request('ringo-generate-' + job.id, {ifAvailable:true}, async lock => {
    if (!lock) return status('single-status', '该照片已在另一个标签页处理。')
    const saved = await get('runs', job.id)
    if (saved?.phase === 'ready') return changed(saved)
    await runSingle(saved ?? job, supplied)
  })
}

element('generate').addEventListener('submit', async event => {
  event.preventDefault()
  if (active.size) return
  element('generate-button').disabled = true
  try {
    const supplied = config()
    const photo = element('photo-input').files[0]
    if (!photo) throw new Error('请先选择一张照片。')
    await validatePhoto(photo)
    const job = {
      id:id(), name:photo.name.slice(0, 255), photo, mimeType:photo.type, photoSha256:await hash(photo), createdAt:now(),
      count:Number(element('count').value), renderVersion, attempt:0, calls:[], events:[], phase:'queued'
    }
    await put('runs', job.id, job)
    selectedRun = job.id
    changed(job)
    element('photo-input').value = ''
    await processSingle(job, supplied)
  } catch (error) {
    status('single-status', error.message, true)
  } finally { element('generate-button').disabled = active.size > 0 }
})

async function withDownload(button, where, create, name) {
  button.disabled = true
  status(where, '正在打包…')
  try {
    saveFile(await create(), name + '-' + datePart() + '.zip')
    status(where, '打包完成。')
  } catch (error) { status(where, error.message, true) }
  finally { button.disabled = false }
}
element('export-runs').addEventListener('click', event => {
  void withDownload(event.currentTarget, 'single-status', () => exportRuns(orderedRuns().reverse()), 'Ringo-我的编配库')
})
element('import-results').addEventListener('change', async event => {
  const input = event.currentTarget
  const file = input.files[0]
  if (!file) return
  input.disabled = true
  try {
    const {added, skipped} = await mergeResults(file, orderedRuns())
    status('single-status', '合并 ' + added + ' 条评分 · 跳过 ' + skipped + ' 条已有、较旧或不匹配的评分。')
    await updateMerged()
  } catch (error) { status('single-status', error.message, true) }
  finally { input.value = ''; input.disabled = false }
})
async function updateMerged() {
  element('export-merged').disabled = !(await all('ratings')).some(item => item.scope === 'mine')
}
element('export-merged').addEventListener('click', event => {
  void withDownload(event.currentTarget, 'single-status', async () => {
    const records = (await all('ratings')).filter(item => item.scope === 'mine')
    return exportRatings(null, records, new Set(records.map(item => item.photoId)).size)
  }, 'Ringo-汇总评分')
})

const reviewer = () => element('rater').value.trim()
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
    (index + 1) + ' · ' + job.name + (isRated(job) ? '（已评）' : '（' + (phaseNames[job.phase] ?? job.phase) + '）'),
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

function scoresForm(job, audio, deck) {
  const rater = reviewer()
  const previous = deckRatings.find(record => record.photoId === job.id && record.raterId === rater)
  const form = node('form')
  const cards = node('div', undefined, {className:'players'})
  const inputs = new Map()
  const none = node('input', undefined, {type:'checkbox', checked:previous?.none ?? false})
  const note = node('textarea', undefined, {maxLength:1000, rows:2, value:previous?.note ?? ''})
  for (const candidate of job.listening) {
    const track = audio.find(item => item.id === candidate.id)
    const card = node('fieldset', undefined, {className:'player'})
    card.append(node('legend', candidate.label), play(candidate.label, track.audio, deckURLs))
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
  const save = node('button', '保存评分', {type:'submit'})
  const next = node('button', deck.selected === deckPhotos.length - 1 ? '保存并完成' : '保存并下一张',
    {type:'submit', className:'primary'})
  const message = node('p', previous ? '已保存，可修改。' : '', {className:'status'})
  message.setAttribute('role', 'status')
  actions.append(save, next)
  form.append(rubric, cards, noneLabel, labelControl('备注', note), actions, message)
  form.addEventListener('submit', async event => {
    event.preventDefault()
    save.disabled = next.disabled = true
    message.classList.remove('error')
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
        {scores, favorites, usable, none:none.checked, note:note.value})
      await saveRating(deck.id, record)
      if (deck !== currentDeck) return
      const key = ratingKey(deck.id, record)
      deckRatings = deckRatings.filter(item => ratingKey(deck.id, item) !== key).concat({...record, scope:deck.id})
      message.textContent = '评分已保存。'
      deckProgress()
      if (event.submitter === next && deck.photos[deck.selected] === job.id) {
        if (deck.selected + 1 < deck.photos.length) await selectCard(deck.selected + 1)
        else status('review-status', currentRatings().length === deck.photos.length
          ? '这份编配包已全部评完，可以下载结果 ZIP。' : '已到最后一张，可从进度选择尚未评的照片。')
      }
    } catch (error) { message.textContent = error.message; message.classList.add('error') }
    finally { save.disabled = next.disabled = false }
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
  const heading = node('h3', job.name, {id:'card-title', tabIndex:-1})
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
  if (audio) target.append(scoresForm(job, audio, deck))
  else {
    const text = job.phase === 'failed' ? job.error : '试听在合成队列中，准备好后会出现在这里。'
    target.append(node('p', text, {className:job.phase === 'failed' ? 'error' : 'muted'}))
    if (job.phase === 'failed') {
      const retry = node('button', '重试这张', {type:'button'})
      retry.addEventListener('click', () => { job.phase = 'queued'; void processDeck() })
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
      job.phase = 'rendering'
      if (currentDeck === deck) deckProgress()
      try {
        const cached = await getAudio(job)
        if (!cached && job.cachedOnly) throw new Error('旧 ZIP 的音频缓存缺失，请重新导入原 ZIP。')
        if (!cached) await renderJob(job, message => {
          if (currentDeck === deck) status('review-status', '第 ' + (deck.photos.indexOf(job.id) + 1) + ' 张 · ' + message)
        })
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
  } catch (error) { status('review-status', '无法保存听评进度 · ' + error.message, true) }
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

element('import-deck').addEventListener('change', async event => {
  const input = event.currentTarget
  const file = input.files[0]
  if (!file) return
  input.disabled = true
  status('review-status', '正在检查并导入 ZIP…')
  try {
    const deck = await importDeck(file)
    decks.set(deck.id, deck)
    status('review-status', '导入完成 · ' + deck.photos.length + ' 张。')
    await openDeck(deck)
  } catch (error) { status('review-status', error.message, true) }
  finally { input.disabled = false; input.value = '' }
})
element('deck-select').addEventListener('change', event => {
  void openDeck(decks.get(event.currentTarget.value)).catch(error => status('review-status', error.message, true))
})
element('jump').addEventListener('change', event => void selectCard(Number(event.currentTarget.value)))
element('rater').addEventListener('change', async () => {
  await put('settings', 'rater', reviewer())
  deckProgress()
  await renderCard()
})
element('retry-renders').addEventListener('click', () => {
  for (const job of deckPhotos) if (job.phase === 'failed') job.phase = 'queued'
  void processDeck()
})
element('export-ratings').addEventListener('click', event => {
  const deck = currentDeck
  void withDownload(event.currentTarget, 'review-status',
    () => exportRatings(deck.id, currentRatings(), deck.photos.length), 'Ringo-听评结果')
})

async function restore() {
  for (const run of await all('runs')) runs.set(run.id, run)
  selectedRun = orderedRuns()[0]?.id
  renderRunList()
  await renderSingle()
  await updateMerged()
  element('rater').value = await get('settings', 'rater') ?? ''
  for (const deck of await all('decks')) decks.set(deck.id, deck)
  deckOptions()
  const recent = decks.get(await get('settings', 'deck'))
  if (recent) await openDeck(recent)
}
restore().catch(error => {
  status('fatal', '无法读取浏览器工作台 · ' + error.message, true)
  element('fatal').hidden = false
})
