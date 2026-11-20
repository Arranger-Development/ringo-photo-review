import {duration, hash, id, loadSpecs, makeListening, normalizeModelScore, noteFields, now,
  scoreIssues, validateIntent} from './score.js'
import {put} from './storage.js'

export const defaultEndpoint = 'https://dashscope.aliyuncs.com/compatible-mode/v1'
export const defaultModel = 'qwen3.8-flash'

export function endpointFrom(value) {
  const url = new URL(value.trim())
  const official = /^(?:(?:dashscope(?:-intl|-us)?|token-plan)\.(?:[a-z0-9-]+\.maas\.)?|[a-z0-9-]+\.[a-z0-9-]+\.maas\.)aliyuncs\.com$/
  if (url.protocol !== 'https:' || !official.test(url.hostname) || url.port || url.username || url.password ||
    url.search || url.hash || !/^\/compatible-mode\/v1(?:\/chat\/completions)?\/?$/.test(url.pathname))
    throw new Error('请填写百炼官方的 HTTPS 兼容 Base URL。')
  return url.origin + '/compatible-mode/v1'
}

function imageData(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result)
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(blob)
  })
}

async function fetchReply(config, phase, prompt, schema, content, job, changed, extra = {}) {
  const body = JSON.stringify({
    model: config.model,
    messages: [{role:'system', content:prompt}, {role:'user', content}],
    enable_thinking:false,
    stream:false,
    response_format:{type:'json_schema', json_schema:{name:phase === 'intent'
      ? 'photo_music_intent' : 'photo_arrangements_compact', strict:true, schema}}
  })
  const call = {
    id:id(), phase, attempt: job.attempt, provider:'dashscope', endpoint:config.endpoint, requestedModel:config.model,
    promptSha256:await hash(prompt), schemaSha256:await hash(JSON.stringify(schema)),
    requestBytes:new Blob([body]).size, timeoutMs:240000, stream:false, thinking:false, outcome:'pending', ...extra
  }
  job.calls.push(call)
  const save = async () => { await put('runs', job.id, job); changed(job) }
  call.requestAt = now()
  await save()
  const begin = performance.now()
  call.fetchStartedAt = now()
  const decoder = new TextDecoder()
  let raw = ''
  let responseBytes = 0
  let checkpoint = Promise.resolve()
  const saveProgress = () => {
    const snapshot = structuredClone(job)
    checkpoint = checkpoint.then(() => put('runs', job.id, snapshot)).catch(() => {})
    changed(job)
  }
  try {
    const response = await fetch(config.endpoint + '/chat/completions', {
      method:'POST', credentials:'omit', redirect:'error', signal:AbortSignal.timeout(call.timeoutMs),
      headers:{Authorization:'Bearer ' + config.key, 'Content-Type':'application/json'}, body
    })
    call.headersAt = now()
    call.headersMs = duration(begin)
    call.httpStatus = response.status
    call.exposedHeaders = Object.fromEntries(
      ['x-request-id', 'x-dashscope-request-id', 'retry-after', 'req-cost-time', 'x-envoy-upstream-service-time']
        .map(name => [name, response.headers.get(name)]).filter(([, value]) => value !== null))
    saveProgress()
    if (response.body) {
      const reader = response.body.getReader()
      try {
        while (true) {
          const {value, done} = await reader.read()
          if (done) break
          if (call.firstByteMs === undefined && value.byteLength) {
            call.firstByteAt = now()
            call.firstByteMs = duration(begin)
            call.responseBytes = value.byteLength
            saveProgress()
          }
          responseBytes += value.byteLength
          if (responseBytes > 8 * 1024 * 1024) {
            await reader.cancel()
            throw new Error('千问回包超出 8 MB。')
          }
          raw += decoder.decode(value, {stream:true})
        }
        raw += decoder.decode()
      } finally { reader.releaseLock() }
    }
    call.responseComplete = true
    call.responseEndedAt = now()
    call.upstreamMs = duration(begin)
    const parsedAt = performance.now()
    let envelope
    try { envelope = JSON.parse(raw.split(config.key).join('[密钥]')) }
    catch (error) { if (response.ok) throw error }
    call.parseMs = duration(parsedAt)
    call.providerRequestId = call.exposedHeaders['x-request-id'] ?? call.exposedHeaders['x-dashscope-request-id'] ?? envelope?.request_id
    if (!response.ok) {
      call.providerErrorCode = envelope?.code ?? envelope?.error?.code ?? null
      throw new Error('百炼返回 HTTP ' + response.status + (call.providerErrorCode ? ' · ' + call.providerErrorCode : ''))
    }
    call.returnedModel = envelope.model
    call.completionId = envelope.id
    call.usage = envelope.usage ?? null
    call.providerCreatedAt = envelope.created
    const choice = envelope.choices?.[0]
    call.finishReason = choice?.finish_reason ?? null
    if (call.finishReason !== 'stop') throw new Error('千问未完整返回结果' + (call.finishReason ? ' · ' + call.finishReason : '。'))
    const contentParsedAt = performance.now()
    const result = JSON.parse(choice.message.content)
    call.parseMs += duration(contentParsedAt)
    call.outcome = 'received'
    return {result, call}
  } catch (error) {
    call.outcome = 'failed'
    call.errorType = error.name
    call.error = error.message.split(config.key).join('[密钥]')
    if (error.name === 'TimeoutError') {
      call.failureStage = call.headersAt ? 'response_body' : 'response_headers'
      call.error = '千问请求超过 240 秒，可从当前阶段重试。'
    } else if (error instanceof TypeError && !call.responseComplete) {
      call.browserError = call.error
      call.failureStage = call.headersAt ? 'response_body' : 'response_headers'
      call.error = call.headersAt
        ? '已收到 HTTP ' + call.httpStatus + '，但读取回包时连接断开。'
        : '等待约 ' + Math.round(duration(begin) / 1000) + ' 秒，浏览器未收到可读的百炼 HTTP 回包。请检查接入地址的网络和系统代理。'
    }
    throw new Error(call.error)
  } finally {
    call.responseBytes = responseBytes
    call.requestEndedAt = now()
    call.upstreamMs ??= duration(begin)
    if (raw) call.rawResponse = raw.split(config.key).join('[密钥]')
    await checkpoint
    await save()
  }
}

function compactSchema(scoreSchema, count) {
  const schema = structuredClone(scoreSchema)
  schema.properties.candidates.minItems = count
  schema.properties.candidates.maxItems = count
  const properties = schema.$defs.event.properties
  schema.$defs.event = {
    type:'array', minItems:noteFields.length, maxItems:noteFields.length,
    prefixItems:noteFields.map(field => properties[field])
  }
  return schema
}

export async function generate(job, config, changed) {
  const specs = await loadSpecs()
  job.attempt++
  job.error = undefined
  job.soundfontSha256 = specs.catalog.soundfontSha256
  job.model = config.model
  job.endpoint = config.endpoint
  const stage = async phase => {
    job.phase = phase
    await put('runs', job.id, job)
    changed(job)
  }
  if (!job.intent) {
    await stage('intent')
    const image = {type:'image_url', image_url:{url:await imageData(job.photo)}}
    if (/^qwen(?:3\.[5-8]|3-vl)/.test(config.model)) image.max_pixels = 960 * 960
    const {result, call} = await fetchReply(config, 'intent', specs.intentPrompt, specs.intentSchema,
      [image, {type:'text', text:'请把这张照片转换成音乐意图 JSON。'}], job, changed,
      {imageBytes:job.photo.size, imageMaxPixels:image.max_pixels})
    const validationStarted = performance.now()
    try {
      validateIntent(result)
      job.intent = result
      call.outcome = 'accepted'
    } catch (error) {
      call.outcome = 'rejected'
      call.validationError = error.message
      throw error
    } finally {
      call.validationMs = duration(validationStarted)
      await put('runs', job.id, job)
    }
  }

  if (!job.score) {
    const {catalog} = specs
    const timbreCatalog = {
      catalogVersion:catalog.catalogVersion,
      pitched:catalog.timbres.filter(timbre => timbre.kind === 'pitched').map(({id, name}) => [id, name]),
      percussion:catalog.timbres.filter(timbre => timbre.kind === 'percussion')
        .map(({id, name, drumMidiRanges}) => [id, name, drumMidiRanges])
    }
    const prompt = specs.scorePrompt +
      '\n本次 API 使用紧凑事件格式。events 中的每个音符都是四个整数的数组 [startTick, durationTicks, midi, velocity]，按此顺序输出。'
    for (let pass = 0; pass < 2 && !job.score; pass++) {
      const partial = job.partial
      const repair = partial?.issues ?? []
      const kept = [...Array(job.count).keys()].filter(index => !repair.some(issue => issue.index === index))
      const replacing = repair.length > 0 && repair.length < job.count
      const count = replacing ? repair.length : job.count
      const context = {photoIntent:job.intent, timbreCatalog, candidateCount:count}
      if (replacing) {
        context.repairIssues = repair.map(({index, message}) => ({
          position:index + 1, message, candidate:partial.score.candidates[index]
        }))
        context.retainedDirections = kept.map(index => partial.score.candidates[index].direction)
      }
      await stage(replacing ? 'repair' : 'arrange')
      const {result, call} = await fetchReply(config, replacing ? 'repair' : 'arrange',
        prompt, compactSchema(specs.scoreSchema, count), JSON.stringify(context), job, changed,
        {requestedCandidates:count, repairPositions:replacing ? repair.map(({index}) => index + 1) : []})
      const validationStarted = performance.now()
      try {
        call.trimmedNotes = normalizeModelScore(result, count)
        if (result.catalogVersion !== catalog.catalogVersion) throw new Error('千问返回的音色目录版本不匹配。')
        const full = replacing ? structuredClone(partial.score) : result
        if (replacing) repair.forEach(({index}, position) => { full.candidates[index] = result.candidates[position] })
        const issues = scoreIssues(full, catalog, job.count, replacing ? kept : [])
        if (issues.length) {
          job.partial = {score:full, issues}
          call.outcome = 'rejected'
          call.validationIssues = issues
          if (pass === 1 || issues.length === job.count)
            throw new Error(issues.map(({index, message}) => '第 ' + (index + 1) + ' 套 · ' + message).join('\n'))
        } else {
          job.score = full
          job.listening = await makeListening(job.id, full)
          job.partial = undefined
          call.outcome = 'accepted'
        }
      } catch (error) {
        call.outcome = 'rejected'
        call.validationError = error.message
        throw error
      } finally {
        call.validationMs = duration(validationStarted)
        await put('runs', job.id, job)
      }
    }
  }
}
