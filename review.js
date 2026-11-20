import {dimensions, getRating, loadLibrary, makeRating, mergeRating} from './library.js';
import {connectShared, sharedConfigured} from './shared.js';

const el = id => document.getElementById(id);
const storageKey = 'ringo-offline-review-ratings-v1';
const raterKey = 'ringo-offline-review-rater';
const requestedMode = new URLSearchParams(location.search).get('mode');
const online = requestedMode === 'online' || (!requestedMode && sharedConfigured);
const shared = connectShared(() => signOut('登录已过期，请重新登录。'));
const phases = {queued:'排队中',reading:'读图中',arranging:'编配中',repairing:'补生成中',rendering:'合成音频中',failed:'失败'};
const drafts = new Map();
let library;
let currentId;
let filter = 'pending';
let rater = el('rater').value;
let reviewerTimer;
let detailKey;
let assetUrls = [];
let thumbUrls = [];
let renderVersion = 0;
let queueVersion = 0;
let listKey;
let refreshRequest;
let uploadAttempt;
let jobRevision = 0;
let bundleBusy = false;

el(online ? 'online-mode' : 'offline-mode').setAttribute('aria-current','page');
el('online-tools').hidden = !online;
el('offline-tools').hidden = online;
el('offline-rater').hidden = online;
el('online-exports').hidden = !online;
if (online) {
  el('login').hidden = !sharedConfigured;
  el('empty').textContent = '登录后可查看共享照片和试听。';
  if (!sharedConfigured) status('import-status','在线主机地址待配置。可以切换到「离线听评」。');
}

function readStorage(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; }
  catch { return fallback; }
}
rater = readStorage(raterKey,rater);
el('rater').value = rater;

function node(tag, value, className) {
  const result = document.createElement(tag);
  if (className) result.className = className;
  if (value !== undefined) result.textContent = value;
  return result;
}

function status(id,message,error=false) {
  const target = typeof id === 'string' ? el(id) : id;
  target.textContent = message;
  target.classList.toggle('error',error);
}

const allJobs = () => [...(library?.jobs.values() ?? [])].sort((a,b) => Date.parse(a.createdAt)-Date.parse(b.createdAt) || a.id.localeCompare(b.id));
const pendingJobs = () => allJobs().filter(job => online
  ? job.phase === 'ready' && !job.rated : !getRating(library.ratings,job.id,rater));
const visibleJobs = () => filter === 'pending' ? pendingJobs() : allJobs().reverse();
const currentRatings = () => [...(library?.ratings.values() ?? [])].filter(record => record.raterId === rater);

function select(id,focus=false) {
  currentId = id;
  renderQueue();
  renderDetail();
  if (focus) el('photo-name').focus();
}

function renderQueue() {
  const visible = visibleJobs();
  const count = filter === 'pending' ? visible.length + ' 张待评' : visible.length + ' 张照片';
  const active = online ? allJobs().filter(job => phases[job.phase] && job.phase !== 'failed').length : 0;
  status('count',count + (active ? ' · ' + active + ' 张生成中' : ''));
  el('pending').setAttribute('aria-pressed',String(filter === 'pending'));
  el('all').setAttribute('aria-pressed',String(filter === 'all'));
  el('export').disabled = online ? !allJobs().some(job=>job.rated) : !currentRatings().length;
  el('download-bundle').disabled = bundleBusy || !allJobs().some(job=>job.phase === 'ready');
  const photos = el('photos');
  const key = visible.map(job => job.id + (online ? ':' + job.phase : '')).join(',');
  if (listKey !== key) {
    listKey = key;
    const version = ++queueVersion;
    thumbUrls.forEach(url => URL.revokeObjectURL(url));
    thumbUrls = [];
    photos.replaceChildren(...visible.map(job => {
      const row = node('button');
      row.type = 'button';
      row.dataset.id = job.id;
      const img = node('img');
      img.alt = '';
      img.loading = 'lazy';
      const name = node('span',job.name);
      name.title = job.name;
      row.append(img,name);
      if (online && phases[job.phase]) row.append(node('small',phases[job.phase]));
      row.addEventListener('click',() => { status('saved-status',''); select(job.id,true); });
      void library.thumb(job).then(part => {
        if (part && version === queueVersion) {
          img.src = URL.createObjectURL(part);
          thumbUrls.push(img.src);
        }
      }).catch(() => {});
      return row;
    }));
  }
  for (const row of photos.children) row.setAttribute('aria-pressed',String(row.dataset.id === currentId));
}

function switchFilter(next) {
  filter = next;
  const visible = visibleJobs();
  status('saved-status','');
  select(visible.some(job => job.id === currentId) ? currentId : visible[0]?.id);
}
el('pending').addEventListener('click',() => switchFilter('pending'));
el('all').addEventListener('click',() => switchFilter('all'));

function updateRater() {
  clearTimeout(reviewerTimer);
  const next = el('rater').value.trim();
  if (rater === next) return;
  rater = next;
  try { localStorage.setItem(raterKey,JSON.stringify(rater)); } catch { /* Ratings can still be downloaded. */ }
  switchFilter(filter);
}
el('rater').addEventListener('change',updateRater);
el('rater').addEventListener('input',() => {
  clearTimeout(reviewerTimer);
  reviewerTimer = setTimeout(updateRater,250);
});

function ratingForm(job,version) {
  const reviewer = rater;
  const key = JSON.stringify([job.id,reviewer]);
  const saved = getRating(library.ratings,job.id,reviewer);
  const initial = drafts.get(key) || saved;
  const form = node('form',undefined,'stack');
  const cards = node('div',undefined,'candidates');
  const rubric = node('details',undefined,'muted');
  rubric.append(node('summary','评分标准（1・3・5 分）'),
    node('p','贴图 · 1 明显冲突 / 3 氛围大致相符 / 5 准确表达画面的情绪和动势'),
    node('p','编配 · 1 声部或节奏打架 / 3 基本成立 / 5 声部协调，律动和循环自然'),
    node('p','音色 · 1 选音失配 / 3 搭配可用 / 5 音色有层次，强化画面表达'));
  const selections = new Map();
  const players = [];
  const choices = (label,isChecked) => {
    const field = node('label',undefined,'check');
    const input = node('input');
    input.type = 'checkbox';
    input.checked = isChecked;
    field.append(input,node('span',label));
    return {field,input};
  };
  const {field: noneField,input:none} = choices('都不合适',Boolean(initial?.none));
  const controls = [];
  for (const candidate of job.candidates) {
    const {id,label} = candidate;
    const card = node('article',undefined,'candidate');
    const player = node('audio');
    player.controls = true;
    player.preload = 'metadata';
    player.setAttribute('aria-label','试听 ' + label);
    players.push(player);
    player.addEventListener('play',() => players.forEach(other => { if (other !== player) other.pause(); }));
    const playerState = node('p','读取试听…','status');
    let mediaErrored = false;
    player.addEventListener('error',() => {
      mediaErrored = true;
      status(playerState,'浏览器无法播放这段试听。',true);
      controls.forEach(button=>{button.disabled = true;});
    });
    const media = library.audio(job,candidate).then(blob => {
      if (version !== renderVersion) return false;
      player.src = URL.createObjectURL(blob);
      assetUrls.push(player.src);
      status(playerState,'');
      return !mediaErrored;
    }).catch(error => {
      if (version === renderVersion) status(playerState,error.message,true);
      return false;
    });
    const scores = node('div',undefined,'scores');
    const fields = {};
    for (const [key,title] of Object.entries(dimensions)) {
      const field = node('label',title);
      const input = node('select');
      input.required = true;
      input.setAttribute('aria-label',label+' '+title);
      for (const number of [0,1,2,3,4,5]) {
        const option = node('option',number || '—');
        option.value = number || '';
        input.append(option);
      }
      input.value = initial?.scores[id]?.[key] || '';
      fields[key] = input;
      field.append(input);
      scores.append(field);
    }
    const favorite = choices('首选（可并列）',Boolean(initial?.favorites.includes(id)));
    const usable = choices('可作创作起点',Boolean((initial?.usable ?? initial?.favorites)?.includes(id)));
    favorite.input.addEventListener('change',() => {
      if (favorite.input.checked) { usable.input.checked = true; none.checked = false; }
    });
    usable.input.addEventListener('change',() => {
      if (usable.input.checked) none.checked = false;
      else favorite.input.checked = false;
    });
    const picks = node('div',undefined,'actions');
    picks.append(usable.field,favorite.field);
    card.append(node('strong',label),player,playerState,scores,picks);
    cards.append(card);
    selections.set(id,{fields,favorite:favorite.input,usable:usable.input,media,playable:()=>!mediaErrored});
  }
  none.addEventListener('change',() => {
    if (none.checked) for (const choice of selections.values()) choice.usable.checked = choice.favorite.checked = false;
  });

  const noteLabel = node('label','备注（可选）');
  const note = node('textarea');
  note.rows = 2;
  note.maxLength = 1000;
  note.value = initial?.note || '';
  noteLabel.append(note);
  const advance = node('button','保存并评下一张','primary');
  const save = node('button','保存评分');
  controls.push(advance,save);
  controls.forEach(button=>{button.disabled = true;});
  Promise.all([...selections.values()].map(item=>item.media)).then(results => {
    const ready = results.every(Boolean) && [...selections.values()].every(item=>item.playable());
    controls.forEach(button=>{button.disabled = !ready;});
  });
  const actions = node('div',undefined,'actions');
  const message = node('p',drafts.has(key) ? '已恢复未保存的评分。' : saved ? '已保存过评分，可修改。' : '','status');
  message.setAttribute('role','status');
  actions.append(advance,save,message);
  form.append(rubric,cards,node('p','勾出可继续创作的候选，再选首选。整组都用不上时选「都不合适」。','muted'),noneField,noteLabel,actions);

  function values() {
    const scores = {};
    const favorites = [];
    const usable = [];
    for (const [id, row] of selections) {
      scores[id] = Object.fromEntries(Object.entries(row.fields).map(([field,input]) => [field,Number(input.value)]));
      if (row.favorite.checked) favorites.push(id);
      if (row.usable.checked) usable.push(id);
    }
    return {scores,favorites,usable,none:none.checked,note:note.value};
  }
  form.addEventListener('change',() => drafts.set(key,values()));
  note.addEventListener('input',() => drafts.set(key,values()));
  form.addEventListener('submit',async event => {
    event.preventDefault();
    if (!reviewer || (!online && reviewer !== el('rater').value.trim())) {
      status(message,'请填写并确认评审名。',true);
      return;
    }
    if (save.disabled) return;
    const source = library;
    controls.forEach(button=>{button.disabled = true;});
    try {
      const record = online ? await shared.rate(job,values()) : makeRating(job,reviewer,values());
      if (source !== library) return;
      mergeRating(source.ratings,source.jobs,record);
      drafts.delete(key);
      let persisted = true;
      if (online) {
        const current = source.jobs.get(job.id);
        if (current) current.rated = true;
        jobRevision++;
      } else {
        const prior = readStorage(storageKey,[]);
        const records = prior.filter(item => item?.photoId !== record.photoId || item?.raterId !== reviewer);
        try { localStorage.setItem(storageKey,JSON.stringify([...records,record])); }
        catch { persisted = false; }
      }
      renderQueue();
      const next = event.submitter === advance && currentId === job.id && pendingJobs()[0];
      const feedback = persisted ? '评分已保存。' : '评分已记录在当前页面，请导出评分文件。';
      if (next) {
        status('saved-status',job.name + ' · ' + feedback,!persisted);
        select(next.id,true);
      } else status(message,feedback,!persisted);
    } catch (error) { status(message,error.message,true); }
    finally {
      const playable = [...selections.values()].every(item=>item.playable());
      controls.forEach(button=>{button.disabled = !playable;});
    }
  });
  return form;
}

async function renderDetail() {
  const job = library?.jobs.get(currentId);
  el('detail').hidden = !job;
  el('empty').hidden = Boolean(job);
  el('empty').textContent = library ? '当前没有待评照片。可切到「全部」查阅。' :
    online ? '登录后可查看共享照片和试听。' : '导入 ZIP 后，选一张照片开始听评。';
  const key = JSON.stringify([job?.id,job?.phase,rater]);
  if (detailKey === key) return;
  detailKey = key;
  const version = ++renderVersion;
  const review = el('review');
  review.querySelectorAll('audio').forEach(player=>player.pause());
  review.replaceChildren();
  const image = el('photo');
  image.removeAttribute('src');
  image.hidden = true;
  assetUrls.forEach(url=>URL.revokeObjectURL(url));
  assetUrls = [];
  if (!job) return;
  el('photo-name').textContent = job.name;
  const photoStatus = node('p',undefined,'status');
  review.append(photoStatus);
  void library.photo(job).then(blob => {
    if (version !== renderVersion) return;
    image.src = URL.createObjectURL(blob);
    assetUrls.push(image.src);
    image.hidden = false;
  }).catch(error => { if (version === renderVersion) status(photoStatus,error.message,true); });
  if (online && job.phase !== 'ready') {
    review.append(node('p',job.error || phases[job.phase],'status'));
    if (job.canRetry) {
      const retry = node('button','重试这张');
      retry.type = 'button';
      retry.addEventListener('click',async () => {
        retry.disabled = true;
        try { await shared.retry(job); await refresh(); }
        catch (error) { status(photoStatus,error.message,true); retry.disabled = false; }
      });
      review.append(retry);
    }
    return;
  }
  if (online) {
    try {
      const response = await shared.listening(job);
      if (version !== renderVersion) return;
      const current = library.jobs.get(job.id);
      current.candidates = response.candidates;
      job.candidates = response.candidates;
      for (const record of response.ratings) mergeRating(library.ratings,library.jobs,record);
    } catch (error) {
      if (version === renderVersion) { status(photoStatus,error.message,true); detailKey = undefined; }
      return;
    }
  }
  review.append(ratingForm(job,version));
}

el('library-file').addEventListener('change',async event => {
  const input = event.currentTarget;
  const file = input.files[0];
  if (!file) return;
  input.disabled = true;
  status('import-status','正在读取听评库…');
  try {
    const imported = await loadLibrary(file);
    for (const record of readStorage(storageKey,[])) mergeRating(imported.ratings,imported.jobs,record);
    library = imported;
    filter = 'pending';
    listKey = detailKey = undefined;
    el('library-controls').hidden = false;
    status('saved-status','');
    status('import-status',file.name + ' · ' + library.jobs.size + ' 张可听' +
      (library.skipped ? ' · ' + library.skipped + ' 张文件不完整' : ''));
    select(pendingJobs()[0]?.id);
  } catch (error) { status('import-status',error.message,true); }
  finally { input.value = ''; input.disabled = false; }
});

function downloadFile(file,name) {
  const url = URL.createObjectURL(file);
  const download = node('a');
  download.href = url;
  download.download = name;
  download.click();
  setTimeout(()=>URL.revokeObjectURL(url),3000);
}

el('export').addEventListener('click',async () => {
  if (online) {
    try { downloadFile(await shared.exportRatings(false),'ringo-my-ratings.jsonl'); }
    catch (error) { status('transfer-status',error.message,true); }
    return;
  }
  const ratings = currentRatings();
  if (!ratings.length) return;
  const file = new Blob(ratings.map(record=>JSON.stringify(record)+'\n'),{type:'application/x-ndjson'});
  downloadFile(file,'ringo-ratings-' + rater.replace(/[\\/:*?"<>|]/g,'-') + '.jsonl');
});

function signOut(message = '') {
  library = undefined;
  uploadAttempt = undefined;
  drafts.clear();
  el('upload').reset();
  el('login').hidden = false;
  el('online-session').hidden = el('library-controls').hidden = true;
  el('admin-tools').hidden = true;
  status('upload-status','');
  status('transfer-status','');
  status('saved-status','');
  status('import-status',message,Boolean(message));
  select(undefined);
}

function refresh() {
  if (!library || !online) return Promise.resolve();
  if (refreshRequest) return refreshRequest;
  const source = library;
  const revision = jobRevision;
  refreshRequest = shared.jobs().then(jobs => {
    if (source !== library || revision !== jobRevision) return;
    source.jobs = new Map(jobs.map(job => [job.id,{...job,candidates:source.jobs.get(job.id)?.candidates}]));
    if (!source.jobs.has(currentId)) currentId = visibleJobs()[0]?.id;
    status('import-status','');
    renderQueue();
    renderDetail();
  }).catch(error => { if (source === library) status('import-status',error.message,true); })
    .finally(() => { refreshRequest = undefined; });
  return refreshRequest;
}

el('login').addEventListener('submit',async event => {
  event.preventDefault();
  const button = event.submitter;
  button.disabled = true;
  status('import-status','登录中…');
  try {
    const member = await shared.login({email:el('email').value,code:el('invite-code').value});
    el('invite-code').value = '';
    library = {...shared,jobs:new Map(),ratings:new Map()};
    rater = member.raterId;
    filter = 'pending';
    listKey = detailKey = undefined;
    el('member').textContent = member.email;
    el('login').hidden = true;
    el('online-session').hidden = el('library-controls').hidden = false;
    el('admin-tools').hidden = !member.admin;
    await refresh();
  } catch (error) { status('import-status',error.message,true); }
  finally { button.disabled = false; }
});

el('logout').addEventListener('click',async () => {
  try { await shared.logout(); } catch { /* The local session is cleared below. */ }
  signOut();
});

el('upload').addEventListener('submit',async event => {
  event.preventDefault();
  const file = el('upload-photo').files[0];
  if (!file || file.size > 10 * 1024 * 1024 || !['image/jpeg','image/png'].includes(file.type)) {
    status('upload-status','请选择 10 MB 以内的 JPEG 或 PNG 照片。',true);
    return;
  }
  const count = Number(el('variants').value);
  if (uploadAttempt?.file !== file || uploadAttempt.count !== count) {
    uploadAttempt = {file,count,id:crypto.randomUUID().replaceAll('-','')};
  }
  const button = event.submitter;
  button.disabled = true;
  status('upload-status','正在上传…');
  try {
    const photo = await new Promise((resolve,reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result.split(',')[1]);
      reader.onerror = () => reject(new Error('无法读取照片。'));
      reader.readAsDataURL(file);
    });
    const job = await shared.submit({id:uploadAttempt.id,name:file.name,mimeType:file.type,count,photo});
    if (!library) return;
    jobRevision++;
    library.jobs.set(job.id,job);
    filter = 'all';
    el('upload-photo').value = '';
    uploadAttempt = undefined;
    select(job.id);
    status('upload-status','照片已进入生成队列。');
    void refresh();
  } catch (error) { status('upload-status',error.message,true); }
  finally { button.disabled = false; }
});

el('download-bundle').addEventListener('click',async event => {
  bundleBusy = true;
  event.currentTarget.disabled = true;
  status('transfer-status','正在打包原图、音频和编配 JSON…');
  try {
    const {id} = await shared.startBundle();
    let result = await shared.bundleStatus(id);
    while (result.status === 'packing') {
      await new Promise(resolve=>setTimeout(resolve,1200));
      result = await shared.bundleStatus(id);
    }
    if (result.status !== 'ready') throw new Error(result.error || '打包失败。');
    const link = node('a');
    link.href = shared.bundleURL(id);
    link.download = 'ringo-complete-review-library.zip';
    link.referrerPolicy = 'no-referrer';
    link.click();
    status('transfer-status','已开始下载完整听评库。');
  } catch (error) { status('transfer-status',error.message,true); }
  finally { bundleBusy = false; renderQueue(); }
});

el('export-all').addEventListener('click',async () => {
  try { downloadFile(await shared.exportRatings(true),'ringo-all-ratings.jsonl'); }
  catch (error) { status('transfer-status',error.message,true); }
});

el('import-ratings').addEventListener('change',async event => {
  const input = event.currentTarget;
  const files = [...input.files];
  input.disabled = true;
  let added=0, skipped=0;
  const errors = [];
  try {
    for (const file of files) {
      try {
        if (file.size > 2 * 1024 * 1024) throw new Error('单个 JSONL 最大 2 MB。');
        const result = await shared.importRatings(await file.text());
        added += result.added;
        skipped += result.skipped;
        errors.push(...result.errors.map(issue=>file.name+' 第 '+issue.line+' 行 · '+issue.error));
      } catch (error) { errors.push(file.name+' · '+error.message); }
    }
    status('transfer-status','已导入或更新 '+added+' 条 · 跳过 '+skipped+' 条'+
      (errors.length ? '\n'+errors.join('\n') : ''),Boolean(errors.length));
    void refresh();
  } finally { input.value = ''; input.disabled = false; }
});

if (online) setInterval(refresh,3000);
