// Transporte da versão web: o servidor do docker_gui.py em localhost, com o token da execução
import type {Closer, NdjsonResult, StreamHandlers, Term, TermHandlers, Transport} from './transport';

// token da execução: chega no #t=... do link que o servidor abre/imprime. Fica no localStorage desta origem
// (que inclui a porta, ao contrário de cookie) para novas abas funcionarem, e sai da URL no primeiro render.
const TOKEN = (() => {
  const t = new URLSearchParams(location.hash.slice(1)).get('t');
  try { if (t) localStorage.setItem('docker-gui-token', t); return t || localStorage.getItem('docker-gui-token') || ''; }
  catch { return t || ''; }
})();

const request = (method: 'GET' | 'POST', path: string, body?: unknown) =>
  fetch(path, {method, headers: {'X-Docker-GUI-Token': TOKEN, ...(body === undefined ? {} : {'Content-Type': 'application/json'})},
               body: body === undefined ? undefined : JSON.stringify(body)});

// EventSource não manda header: o token vai na query, só nestas rotas (GET, só leitura)
function stream(path: string, query: Record<string, string>, on: StreamHandlers): Closer {
  const es = new EventSource(`${path}?${new URLSearchParams({...query, t: TOKEN})}`);
  es.onopen = () => on.open?.();
  es.onmessage = e => on.data(e.data);
  es.addEventListener('end', () => on.end());
  // queda de rede: o EventSource reconecta sozinho; CLOSED é recusa do servidor (token, limite, erro)
  es.onerror = () => on.error(es.readyState === EventSource.CLOSED);
  return es;
}

// a saída do compose chega um JSON por linha: cada linha da saída é uma string, e o fim é {code}. Sem o fim (o
// servidor caiu no meio), -1
async function ndjson(path: string, body: unknown, onLine: (line: string) => void): Promise<NdjsonResult> {
  const r = await request('POST', path, body);
  if (!r.ok) return {status: r.status, code: -1, error: await r.json()};
  const reader = r.body!.pipeThrough(new TextDecoderStream()).getReader();
  let rest = '', code = -1;
  for (;;) {
    const {value, done} = await reader.read();
    if (done) return {status: r.status, code};
    const lines = (rest + value).split('\n');
    rest = lines.pop()!;
    for (const l of lines) {
      const v: string | {code: number} = JSON.parse(l);
      if (typeof v === 'string') onLine(v); else code = v.code;
    }
  }
}

// o WebSocket do navegador não manda header custom: o token vai na query. A primeira mensagem tem que ser o tamanho
// (o resize do open): o servidor só sobe o docker exec depois dela
function terminal(id: string, on: TermHandlers): Term {
  const ws = new WebSocket(`ws://${location.host}/api/exec/${id}?t=${encodeURIComponent(TOKEN)}`), enc = new TextEncoder();
  ws.binaryType = 'arraybuffer';
  ws.onopen = () => on.open();
  // binário é a saída do terminal; texto é um aviso do servidor (no Windows, imagem sem TTY)
  ws.onmessage = e => typeof e.data === 'string' ? on.notice(e.data) : on.data(new Uint8Array(e.data));
  ws.onclose = () => on.close();
  const open = () => ws.readyState === WebSocket.OPEN;
  return {
    send: d => { if (open()) ws.send(enc.encode(d)); },
    resize: (cols, rows) => { if (open()) ws.send(JSON.stringify({cols, rows})); },
    close: () => { ws.onclose = ws.onmessage = null; ws.close(); },  // a sessão já foi: nada de escrever num terminal descartado
  };
}

// favicon com a contagem da faixa de atenção
const icon = document.head.appendChild(Object.assign(document.createElement('link'), {rel: 'icon'}));

export const T: Transport = {
  desktop: false,
  request, stream, ndjson, terminal,
  attention(_badge, svg) {
    const href = 'data:image/svg+xml,' + encodeURIComponent(svg);
    if (icon.getAttribute('href') !== href) icon.href = href;  // trocar o href a cada poll faz a aba piscar
  },
  notify(title, body, onClick) {
    try {
      const n = new Notification(title, {body});
      n.onclick = () => { onClick(); n.close(); };
    } catch { /* Chrome no Android só notifica via service worker; o favicon continua avisando */ }
  },
};
