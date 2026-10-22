// O transporte do desktop (src/transport-desktop.ts) com a IPC do Tauri falsa: o mesmo contrato que o app.ts usa
// com o transport-web. node --test tests/transport-desktop.test.js
import test from 'node:test';
import assert from 'node:assert/strict';

// o que o @tauri-apps/api/core usa: invoke e os callbacks dos Channel (cada mensagem vem com o índice da ordem)
const calls = [], callbacks = new Map();
let nextCb = 0, onInvoke = () => undefined;
globalThis.window = {
  __TAURI_INTERNALS__: {
    transformCallback(cb) { callbacks.set(++nextCb, cb); return nextCb; },
    unregisterCallback(id) { callbacks.delete(id); },
    async invoke(cmd, args) { calls.push([cmd, args]); return onInvoke(cmd, args); },
  },
};
const {T} = await import('../src/transport-desktop.ts');

// manda mensagens pelo canal que a página passou no invoke, na ordem
const feed = (channel, ...messages) => messages.forEach((message, index) => callbacks.get(channel.id)({message, index}));
const tick = () => new Promise(r => setTimeout(r, 0));

test('request vira o comando api com o formato da API HTTP', async () => {
  onInvoke = () => ({status: 404, body: 'not found'});
  const r = await T.request('POST', '/api/start/0123456789ab');
  assert.deepEqual(calls.at(-1), ['api', {method: 'POST', path: '/api/start/0123456789ab', body: null}]);
  assert.equal(r.ok, false);
  assert.equal(r.status, 404);
  assert.equal(await r.json(), 'not found');
});

test('stream: open antes das mensagens, data na ordem, end no fim e close solta o stream', async () => {
  onInvoke = cmd => (cmd === 'stream_open' ? 7 : undefined);
  const got = [];
  const s = T.stream('/api/logs/0123456789ab/stream', {tail: '500'}, {
    open: () => got.push('open'), data: d => got.push(d), end: () => got.push('end'), error: c => got.push(`error ${c}`),
  });
  await tick();
  const [cmd, args] = calls.at(-1);
  assert.equal(cmd, 'stream_open');
  assert.deepEqual({...args, channel: undefined}, {method: 'GET', path: '/api/logs/0123456789ab/stream', query: 'tail=500', body: null, channel: undefined});
  feed(args.channel, {data: '"a\\n"'}, {data: '"b\\n"'}, {end: true});
  assert.deepEqual(got, ['open', '"a\\n"', '"b\\n"', 'end']);
  s.close();
  await tick();
  assert.deepEqual(calls.at(-1), ['stream_close', {id: 7}]);
});

test('stream recusado vira error(closed)', async () => {
  onInvoke = () => { throw {status: 503, body: 'streams de eventos demais abertos'}; };
  const got = [];
  T.stream('/api/events/stream', {}, {data: () => {}, end: () => {}, error: c => got.push(c)});
  await tick(); await tick();
  assert.deepEqual(got, [true]);
});

test('ndjson: linhas, o código no fim e a recusa com o corpo de erro', async () => {
  onInvoke = () => 3;
  const lines = [];
  const p = T.ndjson('/api/compose/up', {project: 'loja', dir: '/srv/loja'}, l => lines.push(l));
  await tick();
  feed(calls.at(-1)[1].channel, {line: '#1 building'}, {line: 'failed to solve'}, {line: {code: 1}}, {end: true});
  assert.deepEqual(await p, {status: 200, code: 1});
  assert.deepEqual(lines, ['#1 building', 'failed to solve']);
  onInvoke = () => { throw {status: 404, body: 'projeto compose não encontrado'}; };
  assert.deepEqual(await T.ndjson('/api/compose/up', {project: 'x', dir: '/x'}, () => {}),
                   {status: 404, code: -1, error: 'projeto compose não encontrado'});
});

test('terminal: o primeiro resize abre, os outros redimensionam; bytes viram Uint8Array e o fim fecha', async () => {
  onInvoke = cmd => (cmd === 'term_open' ? 9 : undefined);
  const got = [];
  let term;
  term = T.terminal('0123456789ab', {
    open: () => term.resize(80, 24), data: b => got.push([...b]), notice: n => got.push(n), close: () => got.push('close'),
  });
  await tick();
  const open = calls.findLast(c => c[0] === 'term_open');
  assert.deepEqual({...open[1], channel: undefined}, {id: '0123456789ab', cols: 80, rows: 24, channel: undefined});
  term.send('ls\r');
  term.resize(100, 30);
  await tick();
  assert.deepEqual(calls.slice(-2), [['term_input', {term: 9, data: 'ls\r'}], ['term_resize', {term: 9, cols: 100, rows: 30}]]);
  feed(open[1].channel, new Uint8Array([104, 105]).buffer, {closed: true});
  assert.deepEqual(got, [[104, 105], 'close']);
  term.close();
  await tick();
  assert.deepEqual(calls.at(-1), ['term_close', {term: 9}]);
});

test('openDir chama o open_dir e devolve null, ou a mensagem de erro', async () => {
  onInvoke = () => undefined;
  assert.equal(await T.openDir('shop', '/srv/shop'), null);
  assert.deepEqual(calls.at(-1), ['open_dir', {project: 'shop', dir: '/srv/shop'}]);
  onInvoke = () => { throw 'A pasta não existe mais: /srv/shop'; };
  assert.equal(await T.openDir('shop', '/srv/shop'), 'A pasta não existe mais: /srv/shop');
});

test('prefs: set manda o autostart junto e devolve o erro como texto', async () => {
  onInvoke = () => undefined;
  const p = {cli: null, context: null, lang: null, notifications: true, autostart: true};
  assert.equal(await T.prefs.set(p), null);
  assert.deepEqual(calls.at(-1), ['prefs_set', {prefs: p}]);
  onInvoke = () => { throw 'O sistema recusou o início automático: permission denied'; };
  assert.equal(await T.prefs.set(p), 'O sistema recusou o início automático: permission denied');
});
