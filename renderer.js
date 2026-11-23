import {hash, loadSpecs, renderVersion} from './score.js'
import {audioKey, get, put} from './storage.js?v=2'
import {failure, recordEvent, startTrace} from './diagnostics.js?v=2'

let resources
let queue = Promise.resolve()

function asset(name) {
  return fetch(new URL('./vendor/' + name, import.meta.url)).then(response => {
    if (!response.ok) throw new Error('无法加载浏览器音频资源 · ' + name)
    return response
  })
}

function renderResources(expectedHash) {
  resources ??= Promise.all([
    asset('GeneralUser-GS.sf2').then(response => response.blob()),
    asset('ffmpeg-core.wasm').then(async response =>
      response.headers.get('Content-Type')?.startsWith('application/wasm')
        ? WebAssembly.compileStreaming(response) : WebAssembly.compile(await response.arrayBuffer()))
  ]).then(async ([font, codec]) => {
    if (await hash(font) !== expectedHash) throw new Error('音色库文件和编配目录不匹配。')
    return {font, codec}
  }).catch(error => { resources = undefined; throw error })
  return resources
}

function renderInWorker(job, catalog, resources, update, context) {
  return new Promise((resolve, reject) => {
    // The native audio libraries keep memory between invocations. Each photo uses a
    // fresh Worker, sharing the immutable soundfont and compiled codec instead.
    const worker = new Worker(new URL('./render-worker.js?v=3', import.meta.url))
    const timeout = setTimeout(() => finish(new Error('音频合成超时，可以重试。')), 180000)
    function finish(error, results) {
      clearTimeout(timeout)
      worker.terminate()
      if (error) reject(error)
      else resolve(results)
    }
    worker.onerror = () => finish(new Error('浏览器音频引擎无法启动，请刷新后重试。'))
    worker.onmessage = ({data}) => {
      if (data.status) return update(data.status)
      if (data.trace) {
        const {stage, outcome, ...details} = data.trace
        void recordEvent('render', stage, outcome, {...context, ...details})
        return
      }
      finish(data.error ? new Error(data.error) : null, data.results)
    }
    try { worker.postMessage({score:job.score, listening:job.listening, timbres:catalog.timbres, ...resources}) }
    catch (error) { finish(error) }
  })
}

export const getAudio = job => get('audio', audioKey(job.id, job.listening))

export function renderJob(job, update, packId) {
  const context = {photoId:job.id, ...(packId ? {packId} : {}), attempt:packId ? job.renderAttempt : job.attempt,
    renderVersion:job.renderVersion}
  const queued = startTrace('render', 'queue', context)
  const operation = {...context, operationId:queued.operationId}
  const work = async () => {
    void queued.finish('succeeded')
    const trace = startTrace('render', 'render', context, queued.operationId)
    try {
      const cached = await getAudio(job)
      if (cached) {
        await trace.finish('succeeded', {cacheHit:true, candidateCount:cached.length})
        return cached
      }
      if (job.cachedOnly) throw new Error('旧 ZIP 的音频缓存缺失，请重新导入原 ZIP。')
      if (job.renderVersion !== renderVersion) throw new Error('该编配包的渲染版本不受支持。')
      update('加载音色与音频引擎…')
      const engine = startTrace('render', 'engine_load', context, queued.operationId)
      let catalog
      let assets
      try {
        const specs = await loadSpecs()
        catalog = specs.catalog
        const cacheHit = Boolean(resources)
        assets = await renderResources(catalog.soundfontSha256)
        void engine.finish('succeeded', {cacheHit, soundfontSha256:catalog.soundfontSha256})
      } catch (error) {
        void engine.finish('failed', failure(error, 'engine_load_failed'))
        throw error
      }
      const audio = await renderInWorker(job, catalog, assets, update, operation)
      for (const track of audio) track.audioSha256 = await hash(track.audio)
      await put('audio', audioKey(job.id, job.listening), audio)
      await trace.finish('succeeded', {cacheHit:false, candidateCount:audio.length,
        candidates:audio.map(({id, audioSha256, render}) => ({candidateId:id, audioSha256, ...render}))})
      return audio
    } catch (error) {
      await trace.finish('failed', failure(error, 'render_failed'))
      throw error
    }
  }
  const render = queue.then(() => navigator.locks
    ? navigator.locks.request('ringo-photo-render', work) : work())
  queue = render.catch(() => {})
  return render
}
