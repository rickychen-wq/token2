'use strict';

/* 小型交易測試資料庫：失敗不提交，並檢查 Firestore 的先讀後寫規則。 */
function testStore(initial) {
  const copy = (x) => x === undefined ? undefined : JSON.parse(JSON.stringify(x));
  const docs = new Map(Object.entries(copy(initial || {})));
  let seq = 0, tail = Promise.resolve(), writes = 0;
  const ref = (path) => ({
    path, id: path.split('/').pop(),
    collection: (name) => ref(path + '/' + name),
    doc: (id) => ref(path + '/' + (id || 'auto-' + (++seq)))
  });
  const db = {
    collection: (name) => ref(name),
    runTransaction(fn) {
      const run = tail.then(async () => {
        const pending = [], tx = {
          async get(r) {
            if (pending.length) throw new Error('Firestore 不允許寫入後再讀取');
            const data = copy(docs.get(r.path));
            return { exists: data !== undefined, data: () => copy(data) };
          },
          set: (r, data) => pending.push({ kind: 'set', path: r.path, data: copy(data) }),
          update: (r, data) => pending.push({ kind: 'update', path: r.path, data: copy(data) })
        };
        const result = await fn(tx);
        for (const op of pending) {
          if (op.kind === 'update' && !docs.has(op.path)) throw new Error('更新的文件不存在');
          docs.set(op.path, op.kind === 'update' ? Object.assign({}, docs.get(op.path), op.data) : op.data);
        }
        writes += pending.length;
        return result;
      });
      tail = run.catch(() => {});
      return run;
    }
  };
  return { db, read: (path) => copy(docs.get(path)), all: () => Object.fromEntries(docs), writes: () => writes };
}

module.exports = { testStore };
