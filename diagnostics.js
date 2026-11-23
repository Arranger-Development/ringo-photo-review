import {duration, hash, id, now} from './score.js'
import {all, put} from './storage.js?v=2'

export const logSchemaVersion = 1
export const diagnosticsAppVersion = 'pages-diagnostics-1'
const sensitive = /^(?:authorization|proxyauthorization|apisecret|apikey|accesskey|accesskeysecret|secretaccesskey|accesskeyid|accesstoken|refreshtoken|securitytoken|sessiontoken|token|cookie|setcookie|password|signature|credentials?|clientsecret|xapikey|xamzsignature|bearertoken)$/i

export function redactText(value, secret) {
  const text = secret ? value.split(secret).join('[密钥]') : value
  return text
    .replace(/\bBearer\s+[^\s"'<>;,]+/gi, 'Bearer [密钥]')
    .replace(/\b(?:sk|st|sk-sp|sk-cp)-[a-z0-9_-]{8,}/gi, '[密钥]')
    .replace(/\b(?:LTAI|AKIA)[a-z0-9]{12,}\b/gi, '[密钥]')
    .replace(/((?:"|')(?:authorization|proxy-authorization|api[_-]?key|x[_-]?api[_-]?key|access[_-]?key(?:[_-]?(?:secret|id))?|access[_-]?token|refresh[_-]?token|security[_-]?token|token|password|client[_-]?secret|cookie|set-cookie|signature)(?:"|')\s*:\s*["'])(?:\\.|[^"'\\])*/gi, '$1[密钥]')
    .replace(/([?&](?:access[_-]?token|api[_-]?key|x[_-]?amz[_-]?signature|signature|token)=)[^&#\s"']+/gi, '$1[密钥]')
}

export function sanitize(value, secret) {
  if (typeof value === 'string') return redactText(value, secret)
  if (Array.isArray(value)) return value.map(item => sanitize(item, secret))
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [
      redactText(key, secret), sensitive.test(key.replace(/[^a-z]/gi, '')) ? '[密钥]' : sanitize(item, secret)
    ]))
  }
  return value
}

export function redactResponse(text, secret) {
  try {
    const document = JSON.parse(text)
    const safe = JSON.stringify(sanitize(document, secret))
    return safe === JSON.stringify(document) ? text : safe
  } catch { return redactText(text, secret) }
}

export const failure = (error, errorCode) => ({errorCode, errorName:error?.name, error:redactText(error?.message ?? String(error))})
const pending = new Set()
let writeFailures = 0

export function recordEvent(category, stage, outcome, details = {}) {
  const event = sanitize({...details, eventId:id(), schemaVersion:logSchemaVersion, appVersion:diagnosticsAppVersion,
    category, stage, outcome, errorCode:details.errorCode ?? null, at:now()})
  const save = put('diagnostics', event.eventId, event).catch(() => { writeFailures++ })
  pending.add(save)
  void save.finally(() => pending.delete(save))
  return save
}

export function startTrace(category, stage, context = {}, operationId = id()) {
  const startedAt = now()
  const started = performance.now()
  const scope = {...context, operationId}
  void recordEvent(category, stage, 'started', scope)
  let finished = false
  return {
    operationId,
    finish(outcome, details = {}) {
      if (finished) return Promise.resolve()
      finished = true
      return recordEvent(category, stage, outcome, {...scope, startedAt, durationMs:duration(started), ...details})
    }
  }
}

export async function readDiagnostics() {
  await Promise.all([...pending])
  return {events:await all('diagnostics'), writeFailures}
}

const object = value => value && typeof value === 'object' && !Array.isArray(value)
function parsed(value) {
  if (object(value)) return value
  if (typeof value !== 'string') return {}
  try { const data = JSON.parse(value); return object(data) ? data : {} }
  catch { return {} }
}

function metric(value) {
  if (typeof value !== 'number' && (typeof value !== 'string' || !value.trim())) return undefined
  const result = Number(value)
  return Number.isFinite(result) && result >= 0 ? result : undefined
}

function timestamp(value) {
  let date
  const epoch = metric(value)
  if (epoch !== undefined) date = new Date(epoch < 1e12 ? epoch * 1000 : epoch)
  else if (typeof value === 'string' && /(?:Z|[+-]\d\d:?\d\d)$/i.test(value)) date = new Date(value)
  return date && Number.isFinite(date.getTime()) ? date.toISOString() : undefined
}

function textField(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

export function requestId(value) {
  const raw = textField(value)
  if (!raw || raw.length > 256 || raw === '[密钥]') return undefined
  return /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(raw) ? raw.toLowerCase() : raw
}

export function normalizeAudit(value) {
  if (!object(value)) return undefined
  const origin = parsed(value.originLog)
  const row = {...origin, ...value}
  const usage = parsed(row.usage)
  const record = {
    providerRequestId:requestId(row.modelRequestId ?? row.requestId ?? row.request_id),
    workspaceId:textField(row.workspaceId ?? row.workspace_id),
    calledAt:timestamp(row.startTime ?? row.start_unix_timestamp ?? row.timestamp),
    model:textField(row.model ?? row.modelName),
    firstTokenMs:metric(row.firstTokenDuration ?? row.first_token_duration ?? row.first_token_latency),
    durationMs:metric(row.callDuration ?? row.duration),
    httpStatus:metric(row.httpStatusCode ?? row.status_code ?? row.statusCode),
    errorCode:textField(row.errorCode ?? row.error_code),
    error:textField(row.errorMessage ?? row.error_message),
    inputTokens:metric(usage.input_tokens ?? usage.prompt_tokens),
    outputTokens:metric(usage.output_tokens ?? usage.completion_tokens),
    totalTokens:metric(usage.total_tokens)
  }
  if (!record.providerRequestId && !(record.calledAt && record.model) && record.durationMs === undefined &&
    record.firstTokenMs === undefined && record.httpStatus === undefined) return undefined
  return Object.fromEntries(Object.entries(record).filter(([, item]) => item !== undefined))
}

function stableJson(value) {
  if (Array.isArray(value)) return '[' + value.map(stableJson).join(',') + ']'
  if (object(value)) return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + stableJson(value[key])).join(',') + '}'
  return JSON.stringify(value)
}

export function requestLinks(runs) {
  const links = new Map()
  for (const run of runs) for (const call of run.calls ?? []) {
    const key = requestId(call.providerRequestId)
    if (!key) continue
    const list = links.get(key) ?? []
    list.push({photoId:run.id, attempt:call.attempt, callId:call.id})
    links.set(key, list)
  }
  return links
}

async function readAuditFiles(files, runs, secret) {
  const links = requestLinks(runs)
  const records = new Map((await all('audits')).map(item => [item.eventId, item]))
  const result = {matched:0, duplicate:0, unmatched:0, invalid:0}
  for (const file of files) {
    let data
    try { data = JSON.parse(await file.text()) }
    catch { result.invalid++; continue }
    const rows = Array.isArray(data) ? data : Array.isArray(data?.list) ? data.list : [data]
    if (!rows.length) result.invalid++
    for (const value of rows) {
      const raw = sanitize(value, secret)
      const fields = normalizeAudit(raw)
      if (!fields) { result.invalid++; continue }
      const rawHash = await hash(stableJson(raw))
      const key = fields.providerRequestId ? await hash(fields.providerRequestId) : rawHash
      const eventId = 'bailian:' + key
      const previous = records.get(eventId)
      if (previous?.raw.some(item => item.sha256 === rawHash)) { result.duplicate++; continue }
      const rawEntries = [...(previous?.raw ?? []), {sha256:rawHash, value:raw}]
      const httpStatus = previous?.httpStatus ?? fields.httpStatus
      const importedAt = previous?.importedAt ?? now()
      const merged = {...fields, ...previous, eventId, source:'bailian_audit', stage:'audit',
        outcome:httpStatus === 0 ? 'interrupted' : httpStatus >= 400 ? 'failed'
          : httpStatus ? 'succeeded' : 'unknown',
        schemaVersion:logSchemaVersion, errorCode:previous?.errorCode ?? fields.errorCode ?? null,
        at:previous?.calledAt ?? fields.calledAt ?? importedAt, importedAt, raw:rawEntries}
      await put('audits', eventId, merged)
      records.set(eventId, merged)
      result[links.has(fields.providerRequestId) ? 'matched' : 'unmatched']++
    }
  }
  return result
}

export function importAuditFiles(files, runs, secret) {
  const load = () => readAuditFiles(files, runs, secret)
  return navigator.locks ? navigator.locks.request('ringo-import-audit', load) : load()
}
