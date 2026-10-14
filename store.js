// 本地存储:所有数据都在这台设备的浏览器里(IndexedDB),不上传到任何地方
//   kv        零散的东西:设置、人设、他的名字,以后还有记忆
//   messages  聊天原文,一条气泡一条记录:{ id, role, content, t }

const DB_NAME = 'xiaoshouji';

let opening;

function db() {
  opening ||= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore('kv');
      req.result.createObjectStore('messages', { keyPath: 'id', autoIncrement: true });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return opening;
}

const done = (req) =>
  new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

const finished = (tx) =>
  new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });

const open = async (name, mode) => (await db()).transaction(name, mode).objectStore(name);

export const get = async (key) => done((await open('kv', 'readonly')).get(key));

export const set = async (key, value) => done((await open('kv', 'readwrite')).put(value, key));

export async function addMessage(msg) {
  const id = await done((await open('messages', 'readwrite')).add(msg));
  return { ...msg, id };
}

// 改一条已经存过的消息,比如给电话里那句话补上中文翻译
export const putMessage = async (msg) => done((await open('messages', 'readwrite')).put(msg));

export const allMessages = async () => done((await open('messages', 'readonly')).getAll());

export const clearMessages = async () => done((await open('messages', 'readwrite')).clear());

// 备份用:把两个仓库里的东西全部取出来
export async function exportAll() {
  const tx = (await db()).transaction(['kv', 'messages'], 'readonly');
  const [keys, values, messages] = await Promise.all([
    done(tx.objectStore('kv').getAllKeys()),
    done(tx.objectStore('kv').getAll()),
    done(tx.objectStore('messages').getAll()),
  ]);
  const kv = Object.fromEntries(keys.map((key, i) => [key, values[i]]));
  return { version: 1, exportedAt: Date.now(), kv, messages };
}

// 恢复备份:先清空再写入,要么全部成功要么全部不变
export async function importAll(data) {
  const tx = (await db()).transaction(['kv', 'messages'], 'readwrite');
  tx.objectStore('kv').clear();
  tx.objectStore('messages').clear();
  for (const [key, value] of Object.entries(data.kv)) tx.objectStore('kv').put(value, key);
  for (const msg of data.messages) tx.objectStore('messages').put(msg);
  await finished(tx);
}
