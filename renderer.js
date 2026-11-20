import {hash, loadSpecs, renderVersion} from './score.js'
import {audioKey, get, put} from './storage.js'

let worker
let queue = Promise.resolve()

function renderInWorker(job, catalog, update) {
  return new Promise((resolve, reject) => {
    worker ??= new Worker(new URL('./render-worker.js', import.meta.url))
    const active = worker
    const timeout = setTimeout(() => {
      active.terminate()
      worker = undefined
      reject(new Error('音频合成超时，可以重试。'))
    }, 180000)
    active.onerror = () => {
      clearTimeout(timeout)
      active.terminate()
      worker = undefined
      reject(new Error('浏览器音频引擎无法启动，请刷新后重试。'))
    }
    active.onmessage = ({data}) => {
      if (data.status) return update(data.status)
      clearTimeout(timeout)
      if (data.error) reject(new Error(data.error))
      else resolve(data.results)
    }
    const {byId, ...portableCatalog} = catalog
    active.postMessage({score:job.score, listening:job.listening, catalog:portableCatalog})
  })
}

export const getAudio = job => get('audio', audioKey(job.id, job.listening))

export function renderJob(job, update) {
  const work = async () => {
    const cached = await getAudio(job)
    if (cached) return cached
    if (job.renderVersion !== renderVersion) throw new Error('该编配包的渲染版本不受支持。')
    const {catalog} = await loadSpecs()
    update('加载音色与音频引擎…')
    const audio = await renderInWorker(job, catalog, update)
    for (const track of audio) track.audioSha256 = await hash(track.audio)
    await put('audio', audioKey(job.id, job.listening), audio)
    return audio
  }
  const render = queue.then(() => navigator.locks
    ? navigator.locks.request('ringo-photo-render', work) : work())
  queue = render.catch(() => {})
  return render
}
