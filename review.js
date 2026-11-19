import {dimensions, getRating, loadLibrary, makeRating, mergeRating} from './library.js';

const el = id => document.getElementById(id);
const storageKey = 'ringo-offline-review-ratings-v1';
const raterKey = 'ringo-offline-review-rater';
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
const pendingJobs = () => allJobs().filter(job => !getRating(library.ratings,job.id,rater));
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
  status('count',count);
  el('pending').setAttribute('aria-pressed',String(filter === 'pending'));
  el('all').setAttribute('aria-pressed',String(filter === 'all'));
  el('export').disabled = !currentRatings().length;
  const photos = el('photos');
  const key = visible.map(job => job.id).join(',');
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
  form.addEventListener('submit',event => {
    event.preventDefault();
    if (!reviewer || reviewer !== el('rater').value.trim()) {
      status(message,'请填写并确认评审名。',true);
      return;
    }
    if (save.disabled) return;
    try {
      const record = makeRating(job,reviewer,values());
      mergeRating(library.ratings,library.jobs,record);
      drafts.delete(key);
      const prior = readStorage(storageKey,[]);
      const records = prior.filter(item => item?.photoId !== record.photoId || item?.raterId !== reviewer);
      let persisted = true;
      try { localStorage.setItem(storageKey,JSON.stringify([...records,record])); }
      catch { persisted = false; }
      renderQueue();
      const next = event.submitter === advance && pendingJobs()[0];
      const feedback = persisted ? '评分已保存。' : '评分已记录在当前页面，请导出评分文件。';
      if (next) {
        status('saved-status',job.name + ' · ' + feedback,!persisted);
        select(next.id,true);
      } else status(message,feedback,!persisted);
    } catch (error) { status(message,error.message,true); }
  });
  return form;
}

function renderDetail() {
  const job = library?.jobs.get(currentId);
  el('detail').hidden = !job;
  el('empty').hidden = Boolean(job);
  el('empty').textContent = library ? '当前没有待评照片。可切到「全部」查阅。' : '导入 ZIP 后，选一张照片开始听评。';
  const key = JSON.stringify([job?.id,rater]);
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
  review.append(photoStatus,ratingForm(job,version));
  void library.photo(job).then(blob => {
    if (version !== renderVersion) return;
    image.src = URL.createObjectURL(blob);
    assetUrls.push(image.src);
    image.hidden = false;
  }).catch(error => { if (version === renderVersion) status(photoStatus,error.message,true); });
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

el('export').addEventListener('click',() => {
  const ratings = currentRatings();
  if (!ratings.length) return;
  const file = new Blob(ratings.map(record=>JSON.stringify(record)+'\n'),{type:'application/x-ndjson'});
  const url = URL.createObjectURL(file);
  const download = node('a');
  download.href = url;
  download.download = 'ringo-ratings-' + rater.replace(/[\\/:*?"<>|]/g,'-') + '.jsonl';
  download.click();
  setTimeout(()=>URL.revokeObjectURL(url),3000);
});
