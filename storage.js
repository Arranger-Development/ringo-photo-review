let loading

function database() {
  loading ??= new Promise((resolve, reject) => {
    const request = indexedDB.open('ringo-photo-review', 2)
    request.onupgradeneeded = () => {
      for (const name of ['runs', 'decks', 'photos', 'audio', 'ratings', 'settings', 'diagnostics', 'audits']) {
        if (!request.result.objectStoreNames.contains(name)) request.result.createObjectStore(name)
      }
    }
    let blocked = false
    request.onsuccess = () => {
      if (blocked) { request.result.close(); return }
      request.result.onversionchange = () => { request.result.close(); loading = undefined }
      resolve(request.result)
    }
    request.onerror = () => reject(request.error)
    request.onblocked = () => {
      blocked = true
      reject(new Error('请关闭其他打开 Ringo 的旧标签页，再刷新以升级本地记录。'))
    }
  }).catch(error => { loading = undefined; throw error })
  return loading
}

async function access(name, mode, action) {
  const db = await database()
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(name, mode)
    const request = action(transaction.objectStore(name))
    transaction.oncomplete = () => resolve(request.result)
    transaction.onabort = () => reject(transaction.error ?? request.error)
  })
}

export const get = (store, key) => access(store, 'readonly', target => target.get(key))
export const all = store => access(store, 'readonly', target => target.getAll())
export const allKeys = store => access(store, 'readonly', target => target.getAllKeys())
export const put = (store, key, value) => access(store, 'readwrite', target => target.put(value, key))
export const photoKey = (deck, id) => deck + '/' + id
export const audioKey = (id, candidates) => id + '/' + candidates.map(candidate => candidate.id).join('-')
