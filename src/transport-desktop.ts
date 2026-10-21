// Transporte do app desktop: a IPC do Tauri com o núcleo em Rust (src-tauri/core), sem porta aberta. Os comandos têm
// o formato da API HTTP da versão web (método, caminho, corpo), então o app.ts é o mesmo nas duas.
import {Channel, invoke} from '@tauri-apps/api/core';
import type {ApiResponse, Closer, NdjsonResult, StreamHandlers, Term, TermHandlers, Transport} from './transport';

type Reply = {status: number; body: unknown};
type StreamMsg = {data?: string; line?: unknown; end?: true};

async function request(method: 'GET' | 'POST', path: string, body?: unknown): Promise<ApiResponse> {
  const r = await invoke<Reply>('api', {method, path, body: body ?? null});
  return {ok: r.status < 400, status: r.status, json: async () => r.body};
}

// a recusa do stream_open vem como {status, body}, igual à resposta de erro da versão web
const refusal = (e: unknown): Reply => (e && typeof e === 'object' && 'status' in e ? e as Reply : {status: 500, body: String(e)});

function stream(path: string, query: Record<string, string>, on: StreamHandlers): Closer {
  const ch = new Channel<StreamMsg>();
  let closed = false;
  ch.onmessage = m => { if (!closed) m.end ? on.end() : on.data(m.data ?? ''); };
  // o open antes de abrir: com o EventSource ele também vem antes da primeira mensagem
  const id = Promise.resolve().then(() => {
    if (!closed) on.open?.();
    return invoke<number>('stream_open', {method: 'GET', path, query: new URLSearchParams(query).toString(), body: null, channel: ch});
  });
  id.catch(() => { if (!closed) on.error(true); });
  return {close() { closed = true; void id.then(i => invoke('stream_close', {id: i}), () => {}); }};
}

function ndjson(path: string, body: unknown, onLine: (line: string) => void): Promise<NdjsonResult> {
  return new Promise(resolve => {
    const ch = new Channel<StreamMsg>();
    let code = -1;
    ch.onmessage = m => {
      if (typeof m.line === 'string') onLine(m.line);
      else if (m.line && typeof m.line === 'object') code = (m.line as {code: number}).code;
      else if (m.end) resolve({status: 200, code});
    };
    invoke('stream_open', {method: 'POST', path, query: '', body, channel: ch})
      .catch(e => { const r = refusal(e); resolve({status: r.status, code: -1, error: r.body}); });
  });
}

// a saída chega em bytes (ArrayBuffer); o fim, como {closed: true}. O exec só sobe com o tamanho: o primeiro resize
// (que o app faz no open) abre o terminal, os seguintes redimensionam
function terminal(cid: string, on: TermHandlers): Term {
  const ch = new Channel<ArrayBuffer | {closed: true}>();
  let id: Promise<number> | null = null, closed = false;
  ch.onmessage = m => { if (!closed) m instanceof ArrayBuffer ? on.data(new Uint8Array(m)) : on.close(); };
  queueMicrotask(() => { if (!closed) on.open(); });
  return {
    resize(cols, rows) {
      if (closed) return;
      if (!id) {
        id = invoke<number>('term_open', {id: cid, cols, rows, channel: ch});
        id.catch(e => { on.notice(String(e)); on.close(); });
      } else void id.then(term => invoke('term_resize', {term, cols, rows}), () => {});
    },
    // comando síncrono no Rust: as teclas chegam na ordem em que foram digitadas
    send(data) { void id?.then(term => invoke('term_input', {term, data}), () => {}); },
    close() { closed = true; void id?.then(term => invoke('term_close', {term}), () => {}); },
  };
}

export const T: Transport = {
  desktop: true,
  request, stream, ndjson, terminal,
  // a bandeja e a notificação do sistema entram com o segundo plano
  attention() {},
  notify() {},
};
