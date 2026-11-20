import {apiOrigin} from './online-config.js';

export const sharedConfigured = Boolean(apiOrigin);

export function connectShared(onExpired) {
  let token;
  async function request(path,{data,format='json'} = {}) {
    if (!sharedConfigured) throw new Error('在线主机地址待配置。');
    const headers = {};
    if (token) headers.Authorization = 'Bearer ' + token;
    if (data !== undefined) headers['Content-Type'] = 'application/json';
    let response;
    try {
      response = await fetch(apiOrigin + path,{
        method:data === undefined ? 'GET' : 'POST',
        credentials:'omit',headers,body:data === undefined ? undefined : JSON.stringify(data)
      });
    } catch {
      throw new Error('暂时无法连接常开主机。');
    }
    if (!response.ok) {
      const details = await response.json().catch(()=>({}));
      if (response.status === 401 && token) {
        token = undefined;
        onExpired();
      }
      throw new Error(details.error || '主机请求失败（' + response.status + '）。');
    }
    return format === 'blob' ? response.blob() : response.json();
  }

  const asset = (job,kind) => '/api/jobs/' + job.id + '/' + kind;
  return {
    async login(data) {
      const result = await request('/api/login',{data});
      token = result.token;
      return {email:result.email, raterId:result.raterId, admin:result.admin};
    },
    async logout() {
      try { if (token) await request('/api/logout',{data:{}}); }
      finally { token = undefined; }
    },
    jobs:() => request('/api/jobs'),
    submit:data => request('/api/jobs',{data}),
    retry:job => request(asset(job,'retry'),{data:{}}),
    listening:job => request(asset(job,'listen')),
    photo:job => request(asset(job,'photo'),{format:'blob'}),
    thumb:job => request(asset(job,'thumbnail'),{format:'blob'}),
    audio:(job,candidate) => request(asset(job,candidate.label + '.mp3'),{format:'blob'}),
    rate:(job,data) => request(asset(job,'rate'),{data}),
    exportRatings:all => request('/api/ratings/' + (all ? 'all' : 'mine'),{format:'blob'}),
    importRatings:jsonl => request('/api/ratings/import',{data:{jsonl}}),
    startBundle:() => request('/api/downloads',{data:{}}),
    bundleStatus:id => request('/api/downloads/' + id),
    bundleURL:id => apiOrigin + '/download/' + id
  };
}
