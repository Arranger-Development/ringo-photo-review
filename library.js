import {openZip} from './zip.js';

export const dimensions = {photoMatch:'贴图', arrangement:'编配', timbre:'音色'};
const hashPattern = /^[0-9a-f]{64}$/;
const mimeTypes = ['image/jpeg','image/png'];
const maxJson = 1024 * 1024;
const ratingKey = (photoId, raterId) => JSON.stringify([photoId,raterId]);
const order = job => job.candidates.map(candidate => candidate.id);

function verifyRating(job, record) {
  const rater = record.raterId;
  const ids = order(job);
  const choices = values => Array.isArray(values) && values.every(value => ids.includes(value))
    && new Set(values).size === values.length;
  return typeof rater === 'string' && rater.trim() === rater && rater.length >= 1 && rater.length <= 48
    && [1,2].includes(record.schemaVersion) && record.photoId === job.id && record.photoSha256 === job.photoSha256
    && JSON.stringify(record.displayOrder) === JSON.stringify(ids)
    && record.scores && Object.keys(record.scores).length === ids.length
    && ids.every(id => Object.keys(dimensions).every(field => {
      const score = record.scores[id]?.[field];
      return Number.isInteger(score) && score >= 1 && score <= 5;
    }))
    && typeof record.none === 'boolean' && choices(record.favorites) && record.none === (record.favorites.length === 0)
    && (record.schemaVersion === 1 || (choices(record.usable) && record.favorites.every(id=>record.usable.includes(id))
      && record.none === (record.usable.length === 0)))
    && typeof record.note === 'string' && record.note.length <= 1000
    && Number.isFinite(Date.parse(record.ratedAt));
}

export function mergeRating(ratings, jobs, record) {
  const job = jobs.get(record?.photoId);
  if (!job || !verifyRating(job,record)) return false;
  const key = ratingKey(record.photoId,record.raterId);
  if (!ratings.has(key) || Date.parse(record.ratedAt) >= Date.parse(ratings.get(key).ratedAt)) {
    ratings.set(key,record);
    return true;
  }
  return false;
}

export const getRating = (ratings, photoId, raterId) => ratings.get(ratingKey(photoId,raterId));

export function makeRating(job,raterId,values) {
  const record = {schemaVersion:2, photoId:job.id, photoSha256:job.photoSha256, raterId, displayOrder:order(job),
    scores:values.scores, favorites:values.favorites, usable:values.usable, none:values.none,
    note:values.note.trim(), ratedAt:new Date().toISOString()};
  if (!verifyRating(job,record)) throw new Error('请填好三项评分，并选择首选或「都不合适」。');
  return record;
}

export async function loadLibrary(file) {
  const zip = await openZip(file);
  const stateFiles = zip.names.filter(path => !path.startsWith('__MACOSX/') && /(?:^|\/)photos\/[a-f0-9]{32}\/state\.json$/.test(path));
  if (!stateFiles.length) throw new Error('请选择含原图和 MP3 的「完整听评库」ZIP。');
  const json = async path => JSON.parse(await (await zip.read(path,maxJson)).text());
  const jobs = new Map();
  const ratings = new Map();
  const skipped = [];
  const ratingFiles = new Map();
  for (const path of zip.names) {
    if (!/\/rating-[a-f0-9]{64}\.json$/.test(path)) continue;
    const folder = path.slice(0,path.lastIndexOf('/')+1);
    if (!ratingFiles.has(folder)) ratingFiles.set(folder,[]);
    ratingFiles.get(folder).push(path);
  }
  for (const stateFile of stateFiles) {
    const folder = stateFile.slice(0,-'state.json'.length);
    try {
      const state = await json(stateFile);
      if (state.example || state.phase !== 'ready') continue;
      const id = folder.split('/').at(-2);
      if (id !== state.id || !hashPattern.test(state.photoSha256) || !mimeTypes.includes(state.mimeType)
        || typeof state.name !== 'string' || !Number.isFinite(Date.parse(state.createdAt))
        || !zip.has(folder+'photo') || jobs.has(id)) throw new Error('照片索引不一致。');
      const candidates = await json(folder+'listen.json');
      if (!Array.isArray(candidates) || candidates.length !== state.count || candidates.length < 4
        || candidates.length > 8 || new Set(candidates.map(candidate=>candidate.id)).size !== candidates.length
        || candidates.some((candidate,index) => candidate.label !== 'ABCDEFGH'[index] || !hashPattern.test(candidate.id)
          || !hashPattern.test(candidate.audioSha256) || !zip.has(folder+candidate.label+'.mp3')))
        throw new Error('试听清单不完整。');
      jobs.set(id,{id, name:state.name, mimeType:state.mimeType, photoSha256:state.photoSha256,
        createdAt:state.createdAt, candidates, folder});
    } catch {
      skipped.push(folder.split('/').at(-2));
    }
  }
  if (!jobs.size) throw new Error('这份 ZIP 里没有完整的正式试听。请先在本机工作台生成音频。');
  for (const job of jobs.values()) {
    for (const path of ratingFiles.get(job.folder) ?? []) {
      try { mergeRating(ratings,jobs,await json(path)); }
      catch { /* A malformed optional rating does not prevent listening. */ }
    }
  }
  async function photo(job) {
    return new Blob([await zip.read(job.folder+'photo',10*1024*1024)],{type:job.mimeType});
  }
  async function thumb(job) {
    return zip.has(job.folder+'thumbnail.jpg')
      ? new Blob([await zip.read(job.folder+'thumbnail.jpg',128*1024)],{type:'image/jpeg'}) : null;
  }
  async function audio(job,candidate) {
    const contents = await zip.read(job.folder+candidate.label+'.mp3',8*1024*1024);
    const bytes = await contents.arrayBuffer();
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256',bytes));
    if (Array.from(digest, byte=>byte.toString(16).padStart(2,'0')).join('') !== candidate.audioSha256)
      throw new Error('试听 ' + candidate.label + ' 的音频完整性校验失败。');
    return new Blob([bytes],{type:'audio/mpeg'});
  }
  return {jobs,ratings,photo,thumb,audio,skipped:skipped.length};
}
