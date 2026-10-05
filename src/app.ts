import {
  type Bucket, type Container, type ContainerState, type DiskUsage, type Image, type Network, type Port, type RunErrors,
  type RunField, type Sample, type Stats, type Tone, type Volume, HISTORY, age, bucket, bulkSummary, bytes, esc, fmtBytes,
  hasHealth, io, isProblem, logFilter, newProblems, percent, ports, project, pushSample, rmHint, runSpec, service, shortImage,
  sparkPoints, status, tone, trend, usage, workingDir,
} from './format';
import {Terminal} from '@xterm/xterm';
import {FitAddon} from '@xterm/addon-fit';
import XTERM_CSS from '@xterm/xterm/css/xterm.css';  // string (build.py usa --loader:.css=text): nada de CDN

// a página é estática: todo seletor usado aqui existe no page.html
const $ = <T extends HTMLElement = HTMLElement>(s: string): T => document.querySelector(s) as T;

// token da execução: chega no #t=... do link que o servidor abre/imprime. Fica no localStorage desta origem
// (que inclui a porta, ao contrário de cookie) para novas abas funcionarem, e sai da URL no primeiro render.
const TOKEN = (() => {
  const t = new URLSearchParams(location.hash.slice(1)).get('t');
  try { if (t) localStorage.setItem('docker-gui-token', t); return t || localStorage.getItem('docker-gui-token') || ''; }
  catch { return t || ''; }
})();
const api = (path: string, opts: RequestInit = {}) =>
  fetch(path, {...opts, headers: {...opts.headers, 'X-Docker-GUI-Token': TOKEN}});

type Action = 'start' | 'stop' | 'restart' | 'pause' | 'unpause' | 'remove';
type RowAction = Action | 'logs';
type MenuAction = Action | 'exec' | 'shell' | 'srestart';
type ProblemKind = 'docker' | 'perm' | 'server' | 'auth';
// [título, dica (HTML confiável), detalhe técnico, tipo]
type Problem = [title: string, hint: string, detail: unknown, kind: ProblemKind];
type ToastAction = [label: string, fn: () => unknown];
type RowError = {msg: string; state: ContainerState; what: string};
// rebuild = up --build; restart é por serviço (o resto vale para o projeto inteiro)
type ComposeAction = 'up' | 'rebuild' | 'down' | 'pull' | 'restart';
// confirmação em 2 passos pendente: remover um container (ou os selecionados, id = "bulk"), derrubar um projeto
// (id = "stack-<projeto>"), limpar uma categoria do disco ou remover uma imagem, volume ou rede; a é o data-a do
// botão e note vai para o leitor de tela
type Arming = {id: string; name: string; a: 'remove' | 'down' | 'prune' | 'rm'; note: string; at: number; timer: number};
type Health = {Log?: {ExitCode: number; Output: string}[]} | null;
// resumo do /api/inspect; o valor do env vem null (mascarado) até o usuário pedir para revelar
type Inspect = {Restart: string; Networks: Record<string, string>; Env: [key: string, value: string | null][];
                Mounts: {Type: string; Name: string; Source: string; Destination: string; RW: boolean}[]};
// linha da tabela com o HTML que a gerou, para o patchRows saber se mudou
type Row = HTMLElement & {_html?: string};

const LABEL: Record<RowAction, string> = {start: 'Iniciar', stop: 'Parar', restart: 'Reiniciar', pause: 'Pausar', unpause: 'Retomar', logs: 'Logs', remove: 'Remover'};
const VERB: Record<Action, string> = {start: 'Iniciando…', stop: 'Parando…', restart: 'Reiniciando…', pause: 'Pausando…', unpause: 'Retomando…', remove: 'Removendo…'};
const DONE: Record<Action, string> = {start: 'iniciado', stop: 'parado', restart: 'reiniciado', pause: 'pausado', unpause: 'retomado', remove: 'removido'};
const COMPOSE_VERB: Record<ComposeAction, string> = {up: 'Subindo…', rebuild: 'Reconstruindo…', down: 'Derrubando…', pull: 'Baixando…', restart: 'Reiniciando…'};
const COMPOSE_CMD: Record<ComposeAction, string> = {up: 'compose up', rebuild: 'compose up --build', down: 'compose down', pull: 'compose pull', restart: 'compose restart'};
// cada estado tem posições fixas de botão, assim Logs fica sempre no mesmo lugar (dead não inicia, só remove)
const PRIMARY: Partial<Record<ContainerState, Action>> = {running: 'stop', restarting: 'stop', paused: 'unpause', exited: 'start', created: 'start'};
const SECONDARY: Partial<Record<ContainerState, Action>> = {running: 'restart', paused: 'stop'};
const STOPPABLE: ContainerState[] = ['running', 'paused', 'restarting'];
const removable = (c: Container) => !STOPPABLE.includes(c.State);
// pulso só para o que está mudando agora (ação em andamento, reinício); "verificando saúde" é estável
const TONE: Record<Tone, [dot: string, text: string]> = {ok: ['bg-ok', 'text-ok-fg'], check: ['bg-ok/40', 'text-ok-soft'],
              warn: ['bg-warn', 'text-warn-fg'], busy: ['bg-fg animate-pulse motion-reduce:animate-none', 'text-fg-strong'],
              bad: ['bg-bad', 'text-bad-fg'], pause: ['bg-pause', 'text-pause-fg'], off: ['bg-dim', 'text-muted']};
// ponytail: lista fixa de portas (do container) que não são HTTP; o resto vira link
const NOT_HTTP = new Set([21, 22, 25, 53, 110, 143, 465, 587, 993, 995, 1025, 1433, 1521, 2181, 3306, 4222,
                          5432, 5672, 6379, 9042, 9092, 11211, 27017]);
// [estado, rótulo no singular, no plural, cor]
const BUCKETS: [Bucket, string, string, string][] = [
  ['problema', 'com problema', 'com problema', 'text-bad-fg'], ['rodando', 'rodando bem', 'rodando bem', 'text-fg'],
  ['pausado', 'pausado', 'pausados', 'text-fg'], ['reiniciando', 'reiniciando', 'reiniciando', 'text-fg'],
  ['parado', 'parado', 'parados', 'text-fg']];
const TOUCH = matchMedia('(pointer: coarse)').matches;
const PROBLEM_TXT: Record<ProblemKind, string> = {docker: 'Docker fora do ar', perm: 'sem acesso ao Docker', server: 'sem conexão', auth: 'sem token'};
const BTN = 'px-2.5 py-1 max-lg:min-h-11 max-lg:px-4 max-lg:text-sm rounded-md text-xs font-medium ring-1 ring-line-strong/80 transition motion-reduce:transition-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent aria-disabled:opacity-40 aria-disabled:cursor-wait';
let data: Container[] = [], busy = new Map<string, Action>(), composing = new Map<string, ComposeAction>(), errors = new Map<string, RowError>(), lastOk: Date | null = null,
    problem = '', problemKind: ProblemKind | '' = '', only: Bucket | '' = '',
    toastTimer: number | undefined, logId: string | null = null, stream: EventSource | null = null, pending: string[] = [],
    arming: Arming | null = null, lastSay = '', dirty = false, seen: Set<string> | null = null,
    // modal de logs com o projeto compose inteiro (logId fica null); a pasta vai junto para o servidor conferir
    logProject: {project: string; dir: string} | null = null;
// seleção para as ações em lote: IDs, não nós do DOM, então sobrevive ao redesenho; visible = IDs na tela agora
// (filtros e busca aplicados); armedIds = o que o Remover em lote armou, para o Confirmar não apagar nada além disso
let sel = new Set<string>(), visible: string[] = [], bulkBusy: Action | '' = '', bulkHtml = '', armedIds: string[] = [],
    lastSel = 'Nenhum container selecionado';
const CHECK = 'size-4 max-lg:size-6 shrink-0 accent-accent cursor-pointer focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent';

let toastFn: (() => unknown) | null = null;
function toast(msg: string, ok = false, action: ToastAction | null = null) {
  toastFn = action?.[1] || null;
  const html = `<div class="flex items-center gap-3 rounded-lg ring-1 text-sm px-4 py-3 ${ok
    ? 'bg-ok/10 ring-ok/40 text-ok-soft'
    : 'bg-bad/10 ring-bad/40 text-bad-soft'}"><span>${esc(msg)}</span>${action ? `<button onclick="runToastAction()"
      class="shrink-0 font-medium underline underline-offset-4 hover:text-fg-strong focus-visible:outline-2 focus-visible:outline-accent rounded">${esc(action[0])}</button>
      <kbd class="shrink-0 font-mono text-xs px-1 rounded ring-1 ring-current opacity-70" title="Atalho">Z</kbd>` : ''}</div>`;
  // com o modal aberto o toast ficaria atrás do backdrop; mostra dentro dele
  ($<HTMLDialogElement>('#dlg').open ? $('#dlg-msg') : $('#toast')).innerHTML = html;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { $('#toast').innerHTML = $('#dlg-msg').innerHTML = ''; toastFn = null; }, action ? 10000 : ok ? 4000 : 8000);
}

// botão do aviso e atalho Z: roda o desfazer uma vez só
function runToastAction() {
  const f = toastFn;
  toastFn = null;
  $('#toast').innerHTML = '';
  f?.();
}

function showProblem(p: Problem | null) {
  if ((p?.[0] || '') === problem) return;  // não repete o aviso a cada poll
  problem = p?.[0] || ''; problemKind = p?.[3] || '';
  $('#banner').classList.toggle('hidden', !p);
  $('#table').classList.toggle('opacity-40', !!p);
  $('#table').inert = $('#bulk').inert = !!p;  // dados velhos não aceitam clique
  if (p) $('#banner').innerHTML = `<p class="font-medium text-warn-strong">${p[0]}</p>
    <p class="mt-0.5 text-warn-soft">${p[1]}</p>
    <details class="mt-2 text-xs text-warn-soft"><summary class="cursor-pointer w-fit py-1 max-lg:py-3.5 rounded focus-visible:outline-2 focus-visible:outline-accent">Detalhes técnicos</summary>
    <pre class="mt-1 whitespace-pre-wrap [overflow-wrap:anywhere] font-mono">${esc(p[2])}</pre></details>`;
  renderCount();
  if (!lastOk) render();
}

async function load() {
  lastLoad = Date.now();
  try {
    const r = await api('/api/containers'), j: unknown = await r.json();
    if (r.status === 401) return showProblem(['Esta aba não tem o token do Docker GUI.',
      'Abra o link com <code class="font-mono">#t=…</code> que aparece no terminal onde você rodou <code class="font-mono">python3 docker_gui.py</code>. O token muda a cada execução.', j, 'auth']);
    if (!r.ok) return showProblem(/permission denied/i.test(String(j))
      ? ['Seu usuário não tem acesso ao Docker.', 'Rode <code class="font-mono">sudo usermod -aG docker $USER</code> e entre de novo na sessão.', j, 'perm']
      : ['Não consegui falar com o Docker.', 'O daemon está rodando? Verifique com <code class="font-mono">systemctl status docker</code>.', j, 'docker']);
    const first = !lastOk;
    lastOk = new Date();
    // só redesenha se mudou (ou na 1ª carga, senão a lista vazia nunca aparece)
    if (first || JSON.stringify(j) !== JSON.stringify(data)) {
      data = j as Container[];
      // container que sumiu (removido, recriado pelo compose com outro ID) sai da seleção
      for (const id of sel) if (!data.some(c => c.ID === id)) sel.delete(id);
      if (selectingRows()) dirty = true; else render();
    }
    notify(newProblems(seen, data));
    seen = new Set(data.filter(isProblem).map(c => c.ID));
    showProblem(null);
  } catch (e) {
    showProblem([lastOk ? 'O servidor do Docker GUI parou de responder.' : 'Não consegui conectar ao servidor do Docker GUI.',
      'Rode <code class="font-mono">python3 docker_gui.py</code> de novo; a página volta sozinha.', (e as Error).message, 'server']);
  }
}

// lista ao vivo: com o stream de eventos do docker conectado, cada leva de eventos refaz a consulta e o poll vira
// rede de segurança (o docker não avisa a passagem do tempo: "Up 5 minutes" -> "Up 6 minutes"). Sem o stream
// (recusado, caiu, podman sem events), poll de 2 s
const POLL = 2000, POLL_LIVE = 30000, COALESCE = 200;
let events: EventSource | null = null, live = false, lastLoad = 0, evTimer: number | undefined, evRetry: number | undefined,
    loading: Promise<void> | null = null, again = false;
// aba escondida não consulta o docker (a não ser com as notificações ligadas: é para elas que serve)
const watching = () => !document.hidden || notifying();

// no máximo uma consulta em voo: o que chega no meio dela vira mais uma depois, não várias em paralelo
function refresh() {
  if (loading) { again = true; return; }
  loading = load().finally(() => { loading = null; if (again) { again = false; refresh(); } });
}

function connectEvents() {
  clearTimeout(evRetry); evRetry = undefined;
  if (events || !watching()) return;
  // EventSource não manda header: o token vai na query, como no ao vivo dos logs
  const es = events = new EventSource(`/api/events/stream?t=${encodeURIComponent(TOKEN)}`);
  es.onopen = () => { live = true; refresh(); };  // o que mudou antes de o docker events começar a ouvir
  // uma rajada (compose up: create, start... de cada serviço) vira uma consulta só, no máximo COALESCE ms depois
  es.onmessage = () => {
    if (watching() && evTimer === undefined) evTimer = setTimeout(() => { evTimer = undefined; refresh(); }, COALESCE);
  };
  // desiste por um tempo e volta ao poll de 2 s (que mostra o erro, se houver); "end" é o docker events que
  // terminou (daemon fora do ar, podman sem events...)
  const drop = () => { closeEvents(); evRetry = setTimeout(connectEvents, POLL_LIVE); };
  es.addEventListener('end', drop);
  // queda: o EventSource reconecta sozinho, com o poll de 2 s enquanto isso; CLOSED é recusa (token, limite, erro)
  es.onerror = () => { live = false; if (es.readyState === EventSource.CLOSED) drop(); };
}
function closeEvents() { events?.close(); events = null; live = false; }

// notificação do sistema só por pedido explícito (botão no cabeçalho) e só para quem acabou de entrar na faixa
// de atenção; com a página em foco ela não aparece, a lista e o favicon já mostram
const canAsk = () => isSecureContext && 'Notification' in window && Notification.permission === 'default';
const notifying = () => 'Notification' in window && Notification.permission === 'granted';
async function askNotify() {
  const ok = await Notification.requestPermission() === 'granted';
  $('#notify').hidden = !canAsk();
  toast(ok ? 'Pronto: aviso quando um container entrar na faixa de atenção, mesmo com a aba em segundo plano.'
           : 'Sem permissão para notificar. Dá para liberar nas configurações do site, no navegador.', ok);
}
function notify(cs: Container[]) {
  if (!cs.length || !notifying() || (!document.hidden && document.hasFocus())) return;
  try {
    const n = new Notification(cs.length === 1 ? `${cs[0].Names} precisa de atenção` : `${cs.length} containers precisam de atenção`,
      {body: cs.length === 1 ? status(cs[0])[0] : cs.map(c => c.Names).join(', ')});
    n.onclick = () => { focus(); n.close(); };
  } catch { /* Chrome no Android só notifica via service worker; o favicon continua avisando */ }
}

// favicon: o cubo do cabeçalho com a contagem da faixa de atenção por cima ("!" quando os dados estão velhos)
const icon = document.head.appendChild(Object.assign(document.createElement('link'), {rel: 'icon'}));
function setIcon(badge: string) {
  const href = 'data:image/svg+xml,' + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#38bdf8" stroke-width="1.8" stroke-linejoin="round"><path d="M12 2.5 3.5 7v10l8.5 4.5 8.5-4.5V7z"/><path d="M3.5 7 12 11.5 20.5 7M12 11.5v10"/>${badge
    ? `<circle cx="16.5" cy="16.5" r="7.5" fill="#dc2626" stroke="none"/><text x="16.5" y="20" text-anchor="middle" font-family="sans-serif" font-size="10" font-weight="700" fill="#fff" stroke="none">${badge}</text>` : ''}</svg>`);
  if (icon.getAttribute('href') !== href) icon.href = href;  // trocar o href a cada poll faz a aba piscar
}

// CPU e memória vêm à parte e mais devagar que a lista: o docker stats leva ~2 s para medir. Tudo indexado
// pelos 12 primeiros caracteres do ID: o podman manda o ID inteiro no ps e o curto no stats
let stats: Record<string, Stats> = {};
const series = new Map<string, Sample[]>();  // últimas leituras de cada container, para o sparkline
const sid = (id: string) => id.slice(0, 12);
async function loadStats() {
  let next: Record<string, Stats> = {};
  try {
    const r = await api('/api/stats');
    if (r.ok) next = Object.fromEntries((await r.json() as Stats[]).map(s => [sid(s.ID), s]));
  } catch { /* sem conexão: o banner do load() já avisa */ }
  const t = Date.now();
  for (const k of series.keys()) if (!next[k]) series.delete(k);  // parou (ou o stats falhou): a série recomeça do zero
  for (const [k, s] of Object.entries(next)) {
    const cpu = percent(s.CPUPerc), mem = bytes(s.MemUsage.split(' / ')[0]);
    if (cpu !== null && mem !== null) series.set(k, pushSample(series.get(k) ?? [], {t, cpu, mem}));
  }
  // sempre redesenha: mesmo com os números iguais, o sparkline andou uma amostra
  stats = next;
  if (selectingRows()) dirty = true; else render();
}

// setTimeout encadeado em vez de setInterval: um docker lento não empilha consultas
async function statsLoop() { if (!document.hidden) await loadStats(); setTimeout(statsLoop, 5000); }

// sparkline em SVG inline, sem animação. A janela tem largura fixa (HISTORY leituras) com a linha de base
// inteira: a série cresce da direita até preencher. Para leitor de tela e no hover, um texto com mín, máx e o
// valor atual. O CPU tem piso de 1% na escala, para ruído de 0,01% não parecer pico
const CPU_FMT = (n: number) => `${n.toFixed(2)}%`;
function spark(h: Sample[], k: 'cpu' | 'mem', w = 48, ht = 14) {
  if (h.length < 2) return '';
  const vs = h.map(s => s[k]), label = esc(trend(k === 'cpu' ? 'CPU' : 'Memória', vs, h.at(-1)!.t - h[0].t, k === 'cpu' ? CPU_FMT : fmtBytes));
  return `<span role="img" data-spark="${k}" aria-label="${label}" title="${label}" class="inline-block align-middle -mt-0.5 mr-0.5"><svg aria-hidden="true"
    viewBox="0 0 ${w} ${ht}" width="${w}" height="${ht}" fill="none" stroke-linecap="round" stroke-linejoin="round">
    <path d="M0 ${ht - 0.5}H${w}" class="stroke-line-strong"/><polyline points="${sparkPoints(vs, w, ht, HISTORY, k === 'cpu' ? 1 : 0)}" stroke-width="1.5" class="stroke-accent"/></svg></span>`;
}

function renderCount() {
  const n = (k: Bucket) => data.filter(c => bucket(c) === k).length, running = data.filter(c => c.State === 'running').length;
  const problemTxt = problemKind ? PROBLEM_TXT[problemKind] : '';
  setIcon(problem ? '!' : n('problema') > 9 ? '9+' : String(n('problema') || ''));
  document.title = !lastOk && !problem ? 'Docker GUI' : !problem ? `Docker GUI · ${running} rodando${n('problema') ? ` · ${n('problema')} com problema` : ''}`
    : `Docker GUI · ${problemTxt}`;
  if (problem) {
    const t = lastOk?.toLocaleTimeString('pt-BR', {hour: '2-digit', minute: '2-digit'});
    $('#count').textContent = lastOk ? `Desatualizado · dados de ${t}` : problemTxt[0].toUpperCase() + problemTxt.slice(1);
    return;
  }
  const pill = 'rounded-md px-2 py-0.5 max-lg:py-3 focus-visible:outline-2 focus-visible:outline-accent';
  $('#count').innerHTML = (BUCKETS.filter(([k]) => n(k) || only === k).map(([k, one, many, color]) =>
    `<button data-id="count-${k}" data-a="filter" aria-pressed="${only === k}" onclick="filterBy('${k}')"
      class="${pill} ring-1 ring-line hover:bg-hover aria-pressed:bg-fg-strong aria-pressed:text-canvas aria-pressed:ring-fg-strong ${color}">${n(k)} ${n(k) === 1 ? one : many}</button>`
  ).join('') || '<span>0 containers</span>') + (only || $<HTMLInputElement>('#q').value.trim()
    ? `<button data-id="count-clear" data-a="filter" onclick="clearFilters()" class="${pill} text-accent-fg underline underline-offset-4 hover:text-accent-soft">Limpar filtros</button>` : '');
}

function filterBy(k: Bucket) { only = only === k ? '' : k; render(); }
function clearFilters() { only = ''; $<HTMLInputElement>('#q').value = ''; render(); $('#q').focus(); }

// filtros vivem na URL (#estado=problema&q=redis): sobrevivem ao recarregar e dá para salvar o link
function saveHash() {
  const h = new URLSearchParams(), q = $<HTMLInputElement>('#q').value.trim();
  if (only) h.set('estado', only);
  if (q) h.set('q', q);
  history.replaceState(null, '', h.size ? '#' + h : location.pathname);
}
function readHash() {
  const h = new URLSearchParams(location.hash.slice(1));
  only = BUCKETS.find(([k]) => k === h.get('estado'))?.[0] || '';
  $<HTMLInputElement>('#q').value = h.get('q') || '';
}

function copyAddr(h: string) {
  navigator.clipboard.writeText(`localhost:${h}`).then(() => toast(`Copiado: localhost:${h}`, true), () => toast('Não consegui copiar.'));
}

function portChip(c: Container, [h, p, proto]: Port) {
  const label = `${h}→${p}${proto === 'tcp' ? '' : '/' + proto}`, svg = 'aria-hidden="true" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" class="inline size-3 ml-1 -mt-0.5"';
  const base = 'whitespace-nowrap font-mono text-xs px-1.5 py-0.5 max-lg:text-xs max-lg:px-3 max-lg:py-3.5 rounded ring-1 focus-visible:outline-2 focus-visible:outline-accent';
  // faixa longa: não há um endereço para abrir ou copiar, então o chip só informa
  if (h.includes('-')) return `<span title="Faixa de portas: ${h} do host → ${p} do container"
    class="${base} bg-hover/60 text-fg-soft ring-line-strong">${label}</span>`;
  return c.State === 'running' && proto === 'tcp' && !NOT_HTTP.has(+p)
    ? `<a href="http://localhost:${h}" target="_blank" rel="noopener" aria-label="Abrir localhost:${h} em nova aba (porta ${p} do container)"
        title="Abrir no navegador" class="${base} bg-accent/10 text-accent-fg ring-accent/20 hover:bg-accent/20">${label}<svg ${svg}><path d="M6 3h7v7M13 3 4 12"/></svg></a>`
    : `<button onclick="copyAddr('${h}')" aria-label="Copiar localhost:${h} (porta ${p}/${proto} do container)" title="Copiar localhost:${h}"
        class="${base} bg-hover/60 text-fg-soft ring-line-strong hover:bg-hover">${label}<svg ${svg}><rect x="5.5" y="5.5" width="7.5" height="7.5" rx="1.5"/><path d="M3 10.5V4a1 1 0 0 1 1-1h6.5"/></svg></button>`;
}

// erro da última ação fica na linha até a próxima ação ou até o estado do container mudar
function errHtml(c: Container) {
  const e = errors.get(c.ID);
  if (!e) return '';
  if (e.state !== c.State) { errors.delete(c.ID); return ''; }
  return `<details data-keep="err" class="mt-1 text-xs text-bad-fg"><summary class="cursor-pointer w-fit py-1 max-lg:py-3.5 rounded focus-visible:outline-2 focus-visible:outline-accent">Falhou ao ${e.what.toLowerCase()} · ver erro</summary>
    <pre class="mt-1 whitespace-pre-wrap [overflow-wrap:anywhere] font-mono text-bad-soft">${esc(e.msg)}</pre></details>`;
}

const health: Record<string, string> = {};  // ID+Status -> texto do último probe (o cache vence quando o Status muda)

async function loadHealth(id: string) {
  const c = data.find(c => c.ID === id);
  if (!c || health[id + c.Status]) return;
  let txt: string;
  try {
    const r = await api('/api/health/' + id), h: unknown = await r.json(), last = r.ok ? (h as Health)?.Log?.at(-1) : undefined;
    txt = !r.ok ? `Não consegui ler o healthcheck: ${h}`
        : last ? `código ${last.ExitCode} · ${last.Output.trim() || '(sem saída)'}` : 'Nenhum probe rodou ainda.';
  } catch { txt = 'Não consegui ler o healthcheck.'; }
  health[id + c.Status] = txt;
  render();
}

const rowCache = new Map<string, {sig: string; html: string}>();
function row(c: Container, withProject = false) {
  const sig = JSON.stringify([c, withProject, busy.get(c.ID), arming?.id === c.ID, errors.get(c.ID), health[c.ID + c.Status], stats[sid(c.ID)],
                              series.get(sid(c.ID))?.at(-1)?.t, composing.has(project(c)), TOUCH, sel.has(c.ID)]);
  const hit = rowCache.get(c.ID);
  if (hit?.sig === sig) return hit.html;
  const html = rowHtml(c, withProject);
  rowCache.set(c.ID, {sig, html});
  return html;
}

function rowHtml(c: Container, withProject: boolean) {
  const b = busy.get(c.ID), t = TONE[b ? 'busy' : tone(c)], st = status(c), pp = ports(c.Ports), p = project(c);
  const armed = arming?.id === c.ID, prim = PRIMARY[c.State], sec = SECONDARY[c.State];
  const u = c.State === 'running' && !b && stats[sid(c.ID)] ? usage(stats[sid(c.ID)]) : null, h = series.get(sid(c.ID)) ?? [];
  const slot = (w = 'lg:w-20') => `<span aria-hidden="true" class="${w} shrink-0 max-lg:hidden"></span>`;
  const btn = (a: RowAction, cls = 'text-fg hover:bg-hover', text = LABEL[a], aria = `${LABEL[a]} ${esc(c.Names)}`) =>
    `<button data-id="${c.ID}" data-a="${a}" ${b && a !== 'logs' ? 'aria-disabled="true"' : ''}
      aria-label="${aria}" aria-describedby="st-${c.ID}" onclick="act('${a}','${c.ID}')" class="lg:w-20 shrink-0 ${BTN} ${cls}">${text}</button>`;
  // ações raras (reiniciar, pausar, remover, exec) ficam no "⋯": a linha mostra só a ação principal e Logs
  const svc = p && workingDir(c) && service(c);  // compose restart só com a pasta no label, como o compose up
  const more = [sec && [sec, LABEL[sec]], svc && ['srestart', `Reiniciar serviço ${esc(svc)}`], c.State === 'running' && ['pause', 'Pausar'],
                c.State === 'running' && ['shell', 'Abrir terminal'], c.State === 'running' && ['exec', 'Copiar docker exec'],
                removable(c) && ['remove', 'Remover…']].filter((x): x is [MenuAction, string] => !!x);
  const item = 'block w-full text-left px-3 py-2 max-lg:py-3 rounded-md text-sm hover:bg-hover focus-visible:outline-2 focus-visible:outline-accent';
  const menu = !more.length ? slot('lg:w-9') : `<details data-keep="menu" class="shrink-0" ontoggle="placeMenu(this)">
      <summary data-id="${c.ID}" data-a="menu" aria-label="Mais ações para ${esc(c.Names)}" ${b ? 'aria-disabled="true"' : ''}
        class="list-none [&::-webkit-details-marker]:hidden cursor-pointer grid place-items-center lg:w-9 max-lg:w-11 ${BTN} text-fg hover:bg-hover">
        <svg aria-hidden="true" viewBox="0 0 16 16" fill="currentColor" class="size-4"><circle cx="3.5" cy="8" r="1.3"/><circle cx="8" cy="8" r="1.3"/><circle cx="12.5" cy="8" r="1.3"/></svg></summary>
      <div class="fixed z-30 min-w-48 rounded-lg bg-raised ring-1 ring-line-strong p-1 shadow-lg shadow-black/40">
        ${more.map(([a, text]) => `<button data-id="${c.ID}" data-a="m-${a}" ${b || (a === 'srestart' && composing.has(p)) ? 'aria-disabled="true"' : ''} onclick="menuPick(this); ${a === 'exec' ? `copyExec('${c.ID}')` : a === 'shell' ? `openShell('${c.ID}')`
          : a === 'srestart' ? `restartService('${c.ID}')` : `act('${a}','${c.ID}')`}"
          class="${item} ${a === 'remove' ? 'text-bad-fg' : 'text-fg'}">${text}</button>`).join('')}
      </div></details>`;
  const healthBox = hasHealth(c) && !b ? `<details data-keep="health" class="mt-1 text-xs" ontoggle="this.open && loadHealth('${c.ID}')">
      <summary class="cursor-pointer w-fit py-1 max-lg:py-3.5 rounded focus-visible:outline-2 focus-visible:outline-accent text-muted hover:text-fg">Ver último healthcheck</summary>
      <pre class="mt-1 whitespace-pre-wrap [overflow-wrap:anywhere] font-mono text-fg-soft">${esc(health[c.ID + c.Status] || 'Carregando…')}</pre></details>` : '';
  // no card do celular, imagem, status e portas recuam até o nome (pl-14 = checkbox + bolinha + os gaps)
  const on = sel.has(c.ID);
  return `<tr data-row data-key="c:${c.ID}" role="row" class="border-t border-line/70 ${on ? 'bg-accent/10' : 'hover:bg-raised/70'} transition motion-reduce:transition-none max-lg:block max-lg:px-4 max-lg:py-4 max-lg:space-y-1.5">
    <th role="rowheader" scope="row" class="py-3 pl-4 pr-6 max-lg:block max-lg:p-0 text-left font-normal"><div class="flex items-center gap-3">
      <input type="checkbox" data-id="${c.ID}" data-a="sel" ${on ? 'checked' : ''} aria-label="Selecionar ${esc(c.Names)}" onchange="toggleSel('${c.ID}')" class="${CHECK}">
      <span aria-hidden="true" class="size-2 shrink-0 rounded-full ${t[0]}"></span>
      <div class="min-w-0"><div class="font-medium text-fg-strong lg:truncate lg:max-w-[24ch]" title="${esc(c.Names)}">${esc(c.Names)}</div>
           <div class="text-xs font-mono text-muted">${c.ID.slice(0, 12)}${withProject && p ? `<span class="font-sans"> · ${esc(p)}</span>` : ''}</div></div></div></th>
    <td role="cell" class="font-mono text-xs text-muted pr-4 max-lg:block max-lg:p-0 max-lg:pl-14 [overflow-wrap:anywhere]">
      <span class="sr-only lg:hidden">Imagem: </span><div class="lg:truncate lg:max-w-[24ch] lg:[direction:rtl] lg:text-left" title="${esc(c.Image)}"><bdi dir="ltr">${esc(shortImage(c.Image))}</bdi></div></td>
    <td role="cell" class="text-sm pr-4 lg:min-w-[24ch] max-lg:block max-lg:p-0 max-lg:pl-14" title="${esc(c.Status)}">
      <span id="st-${c.ID}" class="${t[1]}">${b ? VERB[b] : esc(st[0])}${st[1] && !b ? `<span class="block text-xs text-muted">${st[1]}</span>` : ''}</span>${
      u ? `<span id="us-${c.ID}" class="block text-xs font-mono text-muted" title="${esc(u[2])}">${esc(u[0])} ${spark(h, 'cpu')} · ${esc(u[1])} ${spark(h, 'mem')}</span>` : ''}${b ? '' : errHtml(c) + healthBox}</td>
    <td role="cell" class="pr-4 max-lg:hidden max-lg:has-[div]:block max-lg:p-0 max-lg:pl-14 max-lg:pt-1">${pp.length
      ? `<div class="flex flex-wrap gap-1 max-lg:gap-2">${pp.map(x => portChip(c, x)).join('')}</div>` : ''}</td>
    <td role="cell" class="pr-4 max-lg:block max-lg:p-0 max-lg:pt-2"><div class="flex justify-end max-lg:justify-start items-center gap-1.5 max-lg:gap-2">
      ${prim ? btn(prim, prim === 'start' ? 'text-ok-fg hover:bg-ok/10' : undefined) : slot()}${btn('logs')}
      ${armed ? btn('remove', 'bg-danger text-white ring-danger hover:bg-danger-hover', 'Confirmar', `Confirmar remoção de ${esc(c.Names)}`) : menu}
    </div>${armed ? `<p aria-hidden="true" class="mt-1.5 text-xs text-bad-soft lg:text-right">Apagar de vez? Os volumes ficam. ${TOUCH ? 'Cancela sozinho em 8 s.' : 'Esc cancela.'}</p>` : ''}</td></tr>`;
}

// fecha o menu sem perder o foco: ele volta para o "⋯" antes da ação redesenhar a linha
function menuPick(el: HTMLElement) {
  const sum = el.closest('details')!.querySelector('summary')!;
  closeMenus(); sum.focus();
}

// o menu é fixed (a tabela tem overflow e cortaria um absolute): posiciona junto ao "⋯", virando para cima se faltar espaço
function placeMenu(d: HTMLDetailsElement) {
  if (!d.open) return;
  const r = d.querySelector('summary')!.getBoundingClientRect(), m = d.querySelector('div')!;
  const left = Math.min(Math.max(8, r.right - m.offsetWidth), innerWidth - m.offsetWidth - 8);
  const top = r.bottom + 4 + m.offsetHeight > innerHeight ? r.top - 4 - m.offsetHeight : r.bottom + 4;
  Object.assign(m.style, {left: left + 'px', top: top + 'px'});
}
addEventListener('resize', () => closeMenus());
addEventListener('scroll', () => closeMenus(), true);

function closeMenus(except?: Element | null) {
  document.querySelectorAll('details[data-keep="menu"][open]').forEach(d => d !== except && d.removeAttribute('open'));
}
// clique fora ou Esc fecha o "⋯"
document.addEventListener('click', e => closeMenus(e.target instanceof Element ? e.target.closest('details[data-keep="menu"]') : null));

const bandHead = (text: string, cls: string) => `<tr data-key="h:attn" role="row" class="max-lg:block"><th role="columnheader" colspan="5" scope="colgroup"
  class="max-lg:block px-4 pt-4 pb-2 text-left text-xs font-medium uppercase tracking-wider border-t border-line/70 ${cls}">${text}</th></tr>`;

// cabeçalho do projeto compose: contagem e ações para o stack inteiro (sempre sobre todos os containers do projeto)
function groupHead(k: string, label: string) {
  const all = data.filter(c => project(c) === k), on = all.filter(c => c.State === 'running').length;
  const anyBusy = composing.has(k) || all.some(c => busy.has(c.ID)), dir = k && workingDir(all[0]), armed = arming?.id === `stack-${k}`;
  const inBand = all.filter(isProblem).length;
  const sbtn = (a: Action, n: number, text: string) => k && n ? `<button data-id="stack-${esc(k)}" data-a="${a}" data-p="${esc(k)}" ${anyBusy ? 'aria-disabled="true"' : ''}
      aria-label="${text} do projeto ${esc(k)} (${n})" title="${esc(stackList(a, k).map(c => c.Names).join(', '))}" onclick="stackAct('${a}', this.dataset.p)" class="${BTN} text-fg hover:bg-hover normal-case tracking-normal">${text} (${n})</button>` : '';
  // compose up/pull/down e logs do projeto: só com o working_dir no label (o servidor precisa dele para achar o projeto)
  const cbtn = (a: ComposeAction, text: string, cls = 'text-fg hover:bg-hover', aria = `${text.replace('…', '')} do projeto ${esc(k)}`) =>
    `<button data-id="stack-${esc(k)}" data-a="${a}" data-p="${esc(k)}" ${anyBusy ? 'aria-disabled="true"' : ''} aria-label="${aria}"
      onclick="composeAct('${a}', this.dataset.p)" class="${BTN} ${cls} normal-case tracking-normal">${composing.get(k) === a ? COMPOSE_VERB[a] : text}</button>`;
  return `<tr data-key="g:${esc(k)}" role="row" class="max-lg:block"><th role="columnheader" colspan="5" scope="colgroup" class="max-lg:block px-4 pt-5 pb-2 text-left font-normal border-t border-line/70">
    <div class="flex flex-wrap items-center gap-x-3 gap-y-2">
      <span class="text-xs font-medium uppercase tracking-wider text-fg">${label}</span>
      ${k ? `<span class="text-xs text-muted">compose · ${on} de ${all.length} rodando</span>` : ''}
      ${k && inBand ? `<span class="text-xs text-bad-fg">${inBand} na faixa de atenção ↑</span>` : ''}
      <span class="ml-auto flex flex-wrap gap-1.5">${STACK.map(([a, text]) => sbtn(a, stackList(a, k).length, text)).join('')}${dir
        ? `<button data-id="stack-${esc(k)}" data-a="plogs" data-p="${esc(k)}" aria-label="Logs do projeto ${esc(k)}" onclick="projectLogs(this.dataset.p)"
            class="${BTN} text-fg hover:bg-hover normal-case tracking-normal">Logs</button>`
          + cbtn('up', 'compose up') + cbtn('rebuild', 'compose up --build') + cbtn('pull', 'compose pull') + (armed
          ? cbtn('down', 'Confirmar down', 'bg-danger text-white ring-danger hover:bg-danger-hover', `Confirmar compose down do projeto ${esc(k)}`)
          : cbtn('down', 'compose down…')) : ''}</span>
      ${armed ? `<p aria-hidden="true" class="w-full text-xs text-bad-soft lg:text-right">Derrubar o projeto? Os volumes ficam; o projeto some da lista e só volta com up. ${TOUCH ? 'Cancela sozinho em 8 s.' : 'Esc cancela.'}</p>` : ''}
    </div></th></tr>`;
}

function render() {
  const q = $<HTMLInputElement>('#q').value.trim().toLowerCase();
  // ordem alfabética estável: a linha não sai de baixo do cursor depois de uma ação;
  // a triagem fica na faixa "Precisa de atenção", o resto agrupado por projeto compose
  const rows = data.filter(c => (!only || bucket(c) === only) && [c.Names, c.Image, project(c)].join(' ').toLowerCase().includes(q))
                   .sort((a, b) => a.Names.localeCompare(b.Names));
  visible = rows.map(c => c.ID);
  const attn = rows.filter(isProblem), groups = new Map<string, Container[]>();
  for (const c of rows) if (!isProblem(c)) groups.set(project(c), [...(groups.get(project(c)) || []), c]);
  // projeto com todos os containers na faixa ainda precisa do cabeçalho (e das ações do stack)
  for (const c of attn) if (project(c) && !groups.has(project(c))) groups.set(project(c), []);
  const keys = [...groups.keys()].sort((a, b) => Number(a === '') - Number(b === '') || a.localeCompare(b));  // soltos por último
  const heads = attn.length || keys.length > 1 || keys[0];  // uma lista só de containers soltos dispensa cabeçalho
  const label = only ? BUCKETS.find(([k]) => k === only)![1] + ' ' : '';
  const f = (document.activeElement as HTMLElement | null)?.dataset;  // re-render não pode roubar o foco do teclado
  patchRows(rows.length
    ? [...(attn.length ? [bandHead(`Precisa de atenção · ${attn.length}`, 'text-bad-fg bg-bad/5'), ...attn.map(c => row(c, true))] : []),
       ...keys.flatMap(k => [...(heads ? [groupHead(k, k ? esc(k) : keys.length > 1 ? 'Sem projeto compose' : 'Demais containers')] : []),
                             ...groups.get(k)!.map(c => row(c))])]
    : [`<tr data-key="empty" role="row" class="max-lg:block"><td role="cell" colspan="5" class="max-lg:block py-16 px-4 text-center text-muted">${
      !lastOk ? (problem ? 'Sem dados ainda.' : 'Carregando…')  // nunca recebeu dados: não afirma que a lista está vazia
      : !data.length ? 'Nenhum container ainda. Crie um em “Novo container” ou com <code class="font-mono">docker run</code>.'
      : `Nenhum container ${label}${q ? `corresponde a “${esc(q)}”` : 'agora'}.`}</td></tr>`]);
  dirty = false;
  renderCount();
  renderBulk();
  renderDlg();
  renderDisk();
  renderObjects();
  if (f?.id) refocus(f.id, f.a);
  saveHash();
  // só escreve na região viva quando a mensagem muda, para não apagar o anúncio de uma ação em andamento
  const say = arming ? `${arming.a === 'down' ? `Clique em Confirmar down para derrubar o projeto ${arming.name}.`
    : `Clique em Confirmar para apagar ${arming.name} de vez.`} ${arming.note} ${TOUCH ? 'Cancela sozinho em 8 segundos.' : 'Esc cancela.'}`
            : q || only ? `${rows.length} de ${data.length} containers` : '';
  if (say !== lastSay) $('#shown').textContent = lastSay = say;
}

// devolve o foco depois de um redesenho; se o botão sumiu, cai num lugar seguro (Logs), nunca na ação oposta
function refocus(id: string, a?: string) {
  const q = (sel: string) => document.querySelector<HTMLElement>(sel);
  const groupLogs = () => {  // primeiro Logs do grupo do stack
    for (let tr = q(`[data-key="g:${id.slice(6)}"]`)?.nextElementSibling as HTMLElement | null | undefined;
         tr?.dataset.row !== undefined; tr = tr.nextElementSibling as HTMLElement | null) {
      const l = tr.querySelector<HTMLElement>('[data-a="logs"]'); if (l) return l;
    }
  };
  (q(`[data-id="${id}"][data-a="${a}"]`)
   ?? (['m-remove', 'menu'].includes(a ?? '') ? q(`[data-id="${id}"][data-a="remove"]`) : null)
   ?? q(`[data-id="${id}"][data-a="logs"]`)
   ?? (id === 'dlg' ? $('#lb') : null)
   ?? (id.startsWith('stack-') ? groupLogs() : null)
   ?? q(`[data-id="${id}"]`))?.focus();
}

// troca só as linhas cujo HTML mudou: seleção de texto, hover e cursor do leitor de tela sobrevivem ao poll
function patchRows(htmls: string[]) {
  const tb = $('#rows'), old = new Map(([...tb.children] as Row[]).map(tr => [tr.dataset.key, tr]));
  let prev: Row | null = null;
  for (const html of htmls) {
    const key = html.match(/data-key="([^"]*)"/)![1];
    let tr = old.get(key);
    old.delete(key);
    if (tr?._html !== html) {
      const tpl = document.createElement('template');
      tpl.innerHTML = html.trim();
      const fresh = tpl.content.firstElementChild as Row;
      fresh._html = html;
      if (tr) {
        const open = [...tr.querySelectorAll<HTMLElement>('details[open]')].map(d => d.dataset.keep);
        fresh.querySelectorAll<HTMLElement>('details[data-keep]').forEach(d => open.includes(d.dataset.keep) && d.setAttribute('open', ''));
        tr.replaceWith(fresh);
      }
      tr = fresh;
    }
    const want: Element | null = prev ? prev.nextElementSibling : tb.firstElementChild;
    if (want !== tr) tb.insertBefore(tr, want);
    prev = tr;
  }
  old.forEach(tr => tr.remove());
}

// seleção de texto dentro da tabela segura o redesenho; quando ela some, redesenha o que ficou pendente
const selectingRows = () => { const s = getSelection(); return !!s?.toString() && $('#rows').contains(s.anchorNode); };
document.addEventListener('selectionchange', () => { if (dirty && !selectingRows()) render(); });

// executa uma ação num container; devolve true/false e deixa o erro registrado na linha
async function run(a: Action, c: Container): Promise<boolean> {
  errors.delete(c.ID); busy.set(c.ID, a); render();
  try {
    const r = await api(`/api/${a}/${c.ID}`, {method: 'POST'});
    const msg: string = await r.json();
    if (!r.ok) errors.set(c.ID, {msg: msg || 'erro sem mensagem', state: c.State, what: LABEL[a]});
    return r.ok;
  } catch {
    errors.set(c.ID, {msg: 'Sem resposta do servidor do Docker GUI.', state: c.State, what: LABEL[a]});
    return false;
  } finally { busy.delete(c.ID); render(); }
}

async function act(a: RowAction, id: string) {
  if (a === 'logs') return logs(id);
  const c = data.find(c => c.ID === id);
  if (!c || busy.has(id)) return;
  if (a === 'remove' && !confirmed(id, c.Names, 'remove', 'Os volumes não são afetados.')) return;
  const trs = [...document.querySelectorAll<HTMLElement>('#rows tr[data-row]')], i = trs.findIndex(tr => tr.dataset.key === 'c:' + id);
  const near = (trs[i + 1] || trs[i - 1])?.dataset.key?.slice(2);
  const done = run(a, c);
  $('#shown').textContent = `${VERB[a]} ${c.Names}`;
  if (!(await done)) { toast(`Não deu para ${LABEL[a].toLowerCase()} ${c.Names}. O erro ficou na linha.`); return load(); }
  if (!UP.includes(a)) {
    // pausado parece "ligado" na lista; o desfazer evita esquecer o container congelado
    toast(`${c.Names} ${DONE[a]}.`, true, a === 'pause' ? ['Retomar', () => act('unpause', id)] : null);
    await load();
    if (a === 'remove') (document.querySelector<HTMLElement>(`[data-id="${near}"][data-a="logs"]`) || $('#q')).focus();
    return;
  }
  toast(`${c.Names} ${DONE[a]}, conferindo se ficou de pé…`, true);
  confirmUp([c.ID]);
}

// o docker devolve sucesso assim que o processo sobe; só depois de uns segundos dá para saber se ficou de pé
const UP: Action[] = ['start', 'restart', 'unpause'];
async function confirmUp(ids: string[]) {
  await new Promise(r => setTimeout(r, 3000));
  await load();
  const cs = ids.map(id => data.find(c => c.ID === id)).filter((c): c is Container => !!c);
  const fell = cs.filter(c => c.State !== 'running' || isProblem(c));
  if (!fell.length) return toast(cs.length === 1 ? `${cs[0].Names} está de pé.` : `Os ${cs.length} containers estão de pé.`, true);
  if (fell.length === 1) toast(`${fell[0].Names} subiu mas não ficou bem: ${status(fell[0])[0]}.`, false, ['Ver logs', () => logs(fell[0].ID)]);
  else toast(`${fell.length} containers subiram mas não ficaram bem. Veja a faixa de atenção.`);
}

const STACK: [Action, string][] = [['start', 'Iniciar tudo'], ['restart', 'Reiniciar tudo'], ['stop', 'Parar tudo']];
// em quem a ação de lote faz sentido: Iniciar só nos parados, Reiniciar nos rodando, Remover só no que não está de pé
const fits = (a: Action, c: Container) => a === 'start' ? PRIMARY[c.State] === 'start' : a === 'restart' ? c.State === 'running'
  : a === 'remove' ? removable(c) : STOPPABLE.includes(c.State);
const stackList = (a: Action, p: string, ids?: string[]) => data.filter(c => project(c) === p && (ids ? ids.includes(c.ID) : fits(a, c)));

function copyExec(id: string) {
  // data-cli: binário e --context com que o servidor foi iniciado (ex.: "podman", "docker --context prod")
  const cmd = `${document.documentElement.dataset.cli} exec -it ${data.find(c => c.ID === id)!.Names} sh`;
  navigator.clipboard.writeText(cmd).then(() => toast(`Copiado: ${cmd}`, true), () => toast(`Não consegui copiar. O comando é: ${cmd}`));
}

// ids: limita a ação a containers específicos (usado pelo "Iniciar de novo" depois de um Parar tudo)
async function stackAct(a: Action, p: string, ids?: string[]) {
  const list = stackList(a, p, ids);
  if (!list.length || composing.has(p) || list.some(c => busy.has(c.ID))) return;
  const all = Promise.all(list.map(c => run(a, c)));
  $('#shown').textContent = `${VERB[a]} ${list.length} containers de ${p}`;
  const res = await all, fails = res.filter(ok => !ok).length, okIds = list.filter((c, i) => res[i] && c.State !== 'paused').map(c => c.ID);
  if (fails) toast(`${p}: ${fails} de ${list.length} ${fails === 1 ? 'falhou' : 'falharam'}. ${fails === 1 ? 'O erro ficou na linha' : 'Os erros ficaram nas linhas'}.`);
  else if (a === 'stop') toast(`${p}: ${list.length} parados.`, true, okIds.length ? ['Iniciar de novo', () => stackAct('start', p, okIds)] : null);
  else toast(`${p}: ${list.length} ${a === 'start' ? 'iniciados' : 'reiniciados'}, conferindo se ficaram de pé…`, true);
  if (!fails && UP.includes(a)) return confirmUp(okIds);
  load();
}

// ---- seleção e ações em lote ----
const BULK: [Action, string][] = [['start', 'Iniciar'], ['stop', 'Parar'], ['restart', 'Reiniciar'], ['remove', 'Remover…']];
const bulkList = (a: Action, ids: string[] = [...sel]) => data.filter(c => ids.includes(c.ID) && fits(a, c));
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

// mudar a seleção desarma o Remover em lote: o número no Confirmar tem que ser o que vai ser apagado
function changeSel(fn: () => void) {
  fn();
  if (arming?.id === 'bulk') disarm(false);
  render();
}
const toggleSel = (id: string) => changeSel(() => sel.has(id) ? sel.delete(id) : sel.add(id));
// "selecionar todos" vale só para o que está na tela (filtros e busca); desmarcar tira só esses também
const selectAll = (on: boolean) => changeSel(() => visible.forEach(id => on ? sel.add(id) : sel.delete(id)));
function clearSel() { changeSel(() => sel.clear()); $('#all').focus(); }

function renderBulk() {
  const all = $<HTMLInputElement>('#all'), mine = visible.filter(id => sel.has(id)).length;
  all.checked = !!visible.length && mine === visible.length;
  all.indeterminate = mine > 0 && mine < visible.length;
  all.disabled = !visible.length;
  const n = sel.size, hidden = n - mine, armed = arming?.id === 'bulk';
  const say = n ? `${plural(n, 'container selecionado', 'containers selecionados')}${hidden ? `, ${hidden} fora do filtro` : ''}`
                : 'Nenhum container selecionado';
  if (say !== lastSel) $('#sel-live').textContent = lastSel = say;  // só anuncia quando a contagem muda
  const btn = ([a, text]: [Action, string]) => {
    const k = armed && a === 'remove' ? armedIds.length : bulkList(a).length;
    if (!k) return '';  // como no Parar tudo: só aparece o que faz sentido para a seleção
    const cls = armed && a === 'remove' ? 'bg-danger text-white ring-danger hover:bg-danger-hover'
              : a === 'start' ? 'text-ok-fg hover:bg-ok/10' : a === 'remove' ? 'text-bad-fg hover:bg-bad/10' : 'text-fg hover:bg-hover';
    const aria = armed && a === 'remove' ? `Confirmar remoção de ${plural(k, 'container', 'containers')}` : `${text.replace('…', '')} ${plural(k, 'selecionado', 'selecionados')}`;
    return `<button data-id="bulk" data-a="${a}" ${bulkBusy ? 'aria-disabled="true"' : ''} aria-label="${aria}" title="${esc(bulkList(a, armed && a === 'remove' ? armedIds : undefined).map(c => c.Names).join(', '))}"
      onclick="bulkAct('${a}')" class="${BTN} ${cls}">${bulkBusy === a ? VERB[a] : armed && a === 'remove' ? 'Confirmar remoção' : text} (${k})</button>`;
  };
  const html = !n ? '' : `<p class="mr-auto text-sm font-medium text-fg-strong">${plural(n, 'selecionado', 'selecionados')}${
      hidden ? `<span class="font-normal text-muted"> · ${hidden} fora do filtro</span>` : ''}</p>
    <div class="flex flex-wrap gap-1.5">${BULK.map(btn).join('')}
      <button data-id="bulk" data-a="clear" onclick="clearSel()" class="${BTN} text-muted hover:bg-hover">Limpar seleção</button></div>
    ${armed ? `<p aria-hidden="true" class="w-full text-xs text-bad-soft lg:text-right">Apagar ${plural(armedIds.length, 'container', 'containers')} de vez? Os volumes ficam. ${TOUCH ? 'Cancela sozinho em 8 s.' : 'Esc cancela.'}</p>` : ''}`;
  $('#bulk').classList.toggle('hidden', !n);
  if (html !== bulkHtml) $('#bulk').innerHTML = bulkHtml = html;  // o render roda a cada poll: só troca se mudou
}

// no máximo n chamadas por vez: o servidor atende em paralelo, mas 30 `docker stop` juntos sobrecarregam o daemon
async function pool<T>(xs: T[], n: number, fn: (x: T) => Promise<boolean>): Promise<boolean[]> {
  const out: boolean[] = [];
  let next = 0;
  await Promise.all(Array.from({length: Math.min(n, xs.length)}, async () => {
    while (next < xs.length) { const i = next++; out[i] = await fn(xs[i]); }
  }));
  return out;
}

// ação nos selecionados (ou em ids, usado pelo "Iniciar de novo"), pela mesma rota POST /api/<ação>/<id> da linha
async function bulkAct(a: Action, ids?: string[]) {
  if (bulkBusy) return;
  if (a === 'remove' && !ids) {
    if (arming?.id !== 'bulk') armedIds = bulkList('remove').map(c => c.ID);
    const k = armedIds.length, name = k === 1 ? data.find(c => c.ID === armedIds[0])?.Names ?? '1 container' : `${k} containers`;
    if (!k || !confirmed('bulk', name, 'remove', 'Os volumes não são afetados.')) return;
    ids = armedIds;
  }
  const list = bulkList(a, ids).filter(c => !busy.has(c.ID));
  if (!list.length) return;
  // a fila inteira já aparece ocupada: ninguém dispara a mesma ação na linha enquanto espera a vez
  bulkBusy = a; list.forEach(c => busy.set(c.ID, a)); render();
  $('#shown').textContent = `${VERB[a]} ${plural(list.length, 'container', 'containers')}`;
  const res = await pool(list, 4, c => run(a, c));
  bulkBusy = '';
  const okIds = list.filter((c, i) => res[i] && c.State !== 'paused').map(c => c.ID);
  const fails = list.filter((_, i) => !res[i]).map((c): [string, string] => [c.Names, errors.get(c.ID)?.msg || '']);
  const msg = bulkSummary(DONE[a], res.filter(Boolean).length, fails);
  if (!fails.length && UP.includes(a)) {
    toast(`${msg.slice(0, -1)}, conferindo se ficaram de pé…`, true);
    return confirmUp(okIds);
  }
  // o aviso só depois de reler a lista: o desfazer filtra pelo estado atual e, com os dados de antes, não acharia nada
  await load();
  // pausado que parou fica de fora do desfazer, como no Parar tudo: iniciar não devolveria a pausa
  toast(msg, !fails.length, a === 'stop' && okIds.length ? ['Iniciar de novo', () => bulkAct('start', okIds)] : null);
  if (a === 'remove' && (!document.activeElement || document.activeElement === document.body)) $('#q').focus();
}

// 1º clique só arma (e desarma o que estiver armado); o 2º confirma. Devolve true quando é para executar
function confirmed(id: string, name: string, a: Arming['a'], note: string): boolean {
  if (arming?.id !== id || arming.a !== a) {
    disarm(false);
    arming = {id, name, a, note, at: Date.now(), timer: setTimeout(armTick, 8000)}; render();
    return false;
  }
  if (Date.now() - arming.at < 600) return false;  // duplo clique não pode virar confirmação
  disarm(false);
  return true;
}

// docker compose up/up --build/pull/down no projeto inteiro (down pede confirmação: o projeto some da lista),
// ou restart de um serviço (svc)
async function composeAct(a: ComposeAction, p: string, svc = '') {
  const c = data.find(c => project(c) === p);
  if (!c || composing.has(p) || data.some(c => project(c) === p && busy.has(c.ID))) return;
  if (a === 'down' && !confirmed(`stack-${p}`, p, 'down', 'Os volumes ficam; o projeto some da lista e só volta com up.')) return;
  // no restart, as linhas do serviço (todas as réplicas) ficam "Reiniciando…" e depois passam pelo confirmUp
  const ids = svc ? data.filter(c => project(c) === p && service(c) === svc).map(c => c.ID) : [];
  const what = `${COMPOSE_CMD[a]}${svc ? ` ${svc}` : ''}`;
  let ok = false;
  composing.set(p, a); ids.forEach(id => busy.set(id, 'restart')); render();
  $('#shown').textContent = `${COMPOSE_VERB[a]} ${svc || p}`;
  try {
    const r = await api(`/api/compose/${a}`, {method: 'POST', headers: {'Content-Type': 'application/json'},
                                              body: JSON.stringify({project: p, dir: workingDir(c), ...(svc ? {service: svc} : {})})});
    const msg: string = await r.json();
    ok = r.ok;
    // o compose escreve o progresso no stderr: no erro, a última linha é a que explica
    toast(r.ok ? `${p}: ${what} concluído${ids.length ? ', conferindo se ficou de pé…' : '.'}`
               : `${p}: ${what} falhou. ${msg.trim().split('\n').at(-1) || 'Erro sem mensagem.'}`, r.ok);
  } catch { toast(`${p}: sem resposta do servidor do Docker GUI.`); }
  composing.delete(p); ids.forEach(id => busy.delete(id)); render();
  if (ok && ids.length) return confirmUp(ids);
  await load();
  if (a === 'down') $('#q').focus();
}

// "Reiniciar serviço" do menu "⋯": compose restart do serviço do container (o servidor confere o nome nos labels)
function restartService(id: string) {
  const c = data.find(c => c.ID === id);
  if (c) composeAct('restart', project(c), service(c));
}

// desarma sozinho depois de 8s, mas nunca enquanto o mouse ou o foco estão no botão (WCAG 2.2.1)
function armTick() {
  if (!arming) return;
  const el = document.querySelector(`[data-id="${arming.id}"][data-a="${arming.a}"]`);
  if (el && (el.matches(':hover') || el === document.activeElement)) arming.timer = setTimeout(armTick, 1000);
  else disarm();
}

function disarm(redraw = true) {
  if (!arming) return;
  clearTimeout(arming.timer); arming = null;
  if (redraw) render();
}

document.addEventListener('keydown', e => {
  if (e.key === 'Escape') closeMenus();
  if (e.key === 'Escape' && arming) return disarm();
  // qualquer modal aberto (terminal, novo container) fica com o teclado; o de logs tem o próprio atalho, logo abaixo
  if ([...document.querySelectorAll('dialog')].some(d => d.open && d.id !== 'dlg') || e.ctrlKey || e.metaKey || e.altKey) return;
  // checkbox da seleção não é digitação: com o foco nela os atalhos continuam valendo
  const el = document.activeElement as HTMLElement, typing = /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) && (el as HTMLInputElement).type !== 'checkbox';
  // nos logs, / vai para o filtro das linhas (o mesmo atalho da busca da lista). Ctrl+F fica com o navegador:
  // a busca dele já acha texto na caixa, e quem aperta Ctrl+F espera ela
  if ($<HTMLDialogElement>('#dlg').open) {
    if (e.key === '/' && !typing) { e.preventDefault(); $('#lf').focus(); }
    return;
  }
  if (e.key === '/' && !typing) { e.preventDefault(); return $('#q').focus(); }
  if ((e.key === 'z' || e.key === 'Z') && !typing && toastFn) return runToastAction();
  // x marca a linha em foco (junto com ↑↓ dá para selecionar sem mouse); a marca ou desmarca todos os visíveis
  const curId = el.closest?.<HTMLElement>('tr[data-row]')?.dataset.key?.slice(2);
  if ((e.key === 'x' || e.key === 'X') && !typing && curId) return toggleSel(curId);
  if ((e.key === 'a' || e.key === 'A') && !typing && visible.length) return selectAll(!visible.every(id => sel.has(id)));
  // ↑↓ movem o foco para o Logs da linha de cima/baixo: é seguro (Enter não muda estado) e existe em toda linha
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
  if (typing && !(el === $('#q') && e.key === 'ArrowDown')) return;
  const trs = [...document.querySelectorAll<HTMLElement>('#rows tr[data-row]')], cur = el.closest?.<HTMLElement>('tr[data-row]');
  if (!trs.length) return;
  e.preventDefault();
  const next = trs[Math.max(0, Math.min(trs.length - 1, cur ? trs.indexOf(cur) + (e.key === 'ArrowDown' ? 1 : -1) : 0))];
  next.querySelector<HTMLElement>('[data-a="logs"]')?.focus();
});

// status e ações do container dentro do modal: diagnosticar e agir sem sair dos logs
function renderDlg() {
  if (!$<HTMLDialogElement>('#dlg').open) return;
  if (logProject) {  // projeto inteiro: só a contagem; as ações ficam no cabeçalho do projeto
    const p = logProject.project, all = data.filter(c => project(c) === p), on = all.filter(c => c.State === 'running').length;
    $('#dlg-status').innerHTML = `<span class="text-muted">${all.length
      ? `Projeto compose · ${on} de ${all.length} rodando · todos os serviços` : 'Este projeto não tem mais containers.'}</span>`;
    $('#dlg-acts').innerHTML = '';
    return;
  }
  const c = data.find(c => c.ID === logId);
  if (!c) {
    $('#dlg-status').innerHTML = '<span class="text-muted">Este container não existe mais.</span>';
    $('#dlg-acts').innerHTML = '';
    return;
  }
  const b = busy.get(c.ID), t = TONE[b ? 'busy' : tone(c)], st = status(c);
  const h = hasHealth(c) && health[c.ID + c.Status];
  if (hasHealth(c) && !h) loadHealth(c.ID);
  // uso de recursos com sparkline maior, e rede e disco, que não cabem na tabela
  const s = c.State === 'running' && !b ? stats[sid(c.ID)] : undefined, u = s && usage(s), hs = series.get(sid(c.ID)) ?? [];
  $('#dlg-status').innerHTML = `<span class="${t[1]}">${b ? VERB[b] : esc(st[0])}</span>${st[1] && !b ? `<span class="text-muted"> · ${st[1]}</span>` : ''}${b ? '' : errHtml(c)}${
    h ? `<div class="mt-1 text-xs text-muted">Último healthcheck: <span class="font-mono text-fg-soft">${esc(h)}</span></div>` : ''}${
    s && u ? `<div id="dlg-usage" class="mt-1 text-xs text-muted"><span class="font-mono text-fg-soft">${esc(u[0])}</span> ${spark(hs, 'cpu', 96, 20)} · <span class="font-mono text-fg-soft">${esc(u[1])}</span> ${spark(hs, 'mem', 96, 20)}${
      io(s).length ? `<div class="mt-0.5">${io(s).map(esc).join(' · ')} <span class="whitespace-nowrap">(totais desde que o container subiu)</span></div>` : ''}</div>` : ''}`;
  $('#dlg-acts').innerHTML = [PRIMARY[c.State], SECONDARY[c.State]].filter((a): a is Action => !!a).map(a =>
    `<button data-id="dlg" data-a="${a}" ${b ? 'aria-disabled="true"' : ''} aria-label="${LABEL[a]} ${esc(c.Names)}" onclick="act('${a}', '${c.ID}')"
      class="${BTN} ${a === 'start' ? 'text-ok-fg hover:bg-ok/10' : 'text-fg hover:bg-hover'}">${LABEL[a]}</button>`).join('')
    + (c.State === 'running' ? `<button data-id="dlg" data-a="exec" onclick="copyExec('${c.ID}')" class="${BTN} text-fg hover:bg-hover">Copiar docker exec</button>` : '');
}

// histórico que o "Carregar mais" vai pedindo; o servidor só aceita estes (LOG_TAIL no docker_gui.py)
const TAILS = ['500', '2000', '10000', 'all'] as const;
// o ao vivo vai até 10000: o teto de linhas na tela tem que caber o histórico, e "tudo" ao vivo não teria teto
const LIVE_TAILS = 3;
// trecho que casou com o filtro
const MARK = 'rounded-sm bg-warn/30 text-fg-strong';
// linhas carregadas (cada uma com o \n), que o filtro relê; ocorrências e linhas que casaram; tudo veio (log curto)
let tailAt = 0, buf: string[] = [], hits = 0, hitLines = 0, complete = false;

const fmt = (n: number) => n.toLocaleString('pt-BR');
// o compose aplica o --tail em cada container do projeto
const hist = () => TAILS[tailAt] === 'all' ? 'todas as linhas'
  : `últimas ${fmt(+TAILS[tailAt])} linhas${logProject ? ' de cada container' : ''}`;
const filterRe = () => logFilter($<HTMLInputElement>('#lf').value);

// a linha com os trechos marcados, ou null se não casou (aí ela nem entra na caixa)
function hitNode(line: string, re: RegExp) {
  const parts = line.split(re);
  if (parts.length < 2) return null;
  hits += (parts.length - 1) / 2; hitLines++;
  const span = document.createElement('span');
  parts.forEach((p, i) => {
    if (i % 2 === 0) return p && span.append(p);
    const m = document.createElement('mark');
    m.className = MARK; m.textContent = p; span.append(m);
  });
  return span;
}

function renderHits() {
  const txt = !filterRe() ? '' : hits
    ? `${fmt(hits)} ${hits === 1 ? 'ocorrência' : 'ocorrências'} em ${fmt(hitLines)} ${hitLines === 1 ? 'linha' : 'linhas'}`
    : 'Nenhuma ocorrência';
  if ($('#lcount').textContent !== txt) $('#lcount').textContent = txt;  // é aria-live: só fala quando muda
}

// redesenha a caixa a partir de buf: sem filtro, o texto como veio; com filtro, só as linhas que casam.
// Ao vivo, um nó por linha (o teto tira do começo); parado, um texto só, que pesa menos com o log inteiro
function paint() {
  const lb = $('#lb'), re = filterRe(), atEnd = lb.scrollHeight - lb.scrollTop - lb.clientHeight < 40;
  hits = hitLines = 0;
  if (buf.length && (re || stream)) {  // sem linhas, a caixa tem um aviso ("(sem logs)", erro): fica
    // num fragment, um a um: espalhar o log inteiro em argumentos (replaceChildren(...)) estoura a pilha
    const frag = document.createDocumentFragment();
    for (const l of buf) { const n = re ? hitNode(l, re) : l; if (n) frag.append(n); }
    lb.replaceChildren(frag);
  } else if (buf.length) lb.textContent = buf.join('');
  renderHits();
  if (atEnd) lb.scrollTop = lb.scrollHeight;
}

// "Carregar mais": diz quanto vem. Sem mais o que pedir, aria-disabled (continua no Tab, como o Atualizar)
function renderMore() {
  const next = TAILS[tailAt + 1], b = $('#more');
  b.textContent = !next || complete ? 'Tudo carregado' : next === 'all' ? 'Carregar tudo' : `Carregar ${fmt(+next)} linhas`;
  b.setAttribute('aria-disabled', String(!next || complete || (!!stream && tailAt + 1 >= LIVE_TAILS)));
}

// more: veio do "Carregar mais", com as linhas antigas entrando em cima; a tela fica parada nas mesmas linhas
async function fetchLogs(more = false) {
  const lb = $('#lb'), atEnd = lb.scrollHeight - lb.scrollTop - lb.clientHeight < 40;  // só gruda no fim se já estava lá
  const fromEnd = lb.scrollHeight - lb.scrollTop, tail = TAILS[tailAt], who = logProject ?? logId;
  try {
    const r = await api(logProject ? `/api/compose/logs?${new URLSearchParams({...logProject, tail})}` : `/api/logs/${logId}?tail=${tail}`);
    const j: string = await r.json();
    if (stream) return;  // o ao vivo ligou enquanto esta resposta vinha: ele é quem preenche a caixa
    // já pediram outro container (ou projeto) ou mais histórico: vale a resposta nova
    if (who !== (logProject ?? logId) || tail !== TAILS[tailAt]) return;
    buf = r.ok && j ? j.match(/[^\n]*\n|[^\n]+$/g)! : [];
    // menos linhas que o pedido: o log inteiro já está aqui (no projeto, o total abaixo do pedido também garante isso)
    complete = r.ok && (tail === 'all' || buf.length < +tail);
    if (buf.length) paint();
    else { lb.textContent = r.ok ? '(sem logs)' : `Não consegui ler os logs: ${j}`; renderHits(); }
    $('#lmeta').textContent = `${hist().replace(/^./, c => c.toUpperCase())} · atualizado às ${new Date().toLocaleTimeString('pt-BR')}`;
  } catch { buf = []; lb.textContent = 'Não consegui carregar os logs. O servidor do Docker GUI está rodando?'; }
  renderMore();
  if (more) lb.scrollTop = lb.scrollHeight - fromEnd;
  else if (atEnd) lb.scrollTop = lb.scrollHeight;
}

function openLogs(title: string) {
  tailAt = 0; buf = []; complete = false;
  $('#lt').textContent = title;
  $<HTMLInputElement>('#lf').value = '';  // cada container (ou projeto) começa sem filtro
  $('#lb').textContent = 'Carregando…'; $('#lmeta').textContent = hist().replace(/^./, c => c.toUpperCase()); $('#dlg-msg').innerHTML = '';
  $('#insp').hidden = !!logProject;  // a configuração (inspect) é de um container só
  renderHits(); renderMore();
  $<HTMLDialogElement>('#dlg').showModal(); renderDlg(); fetchLogs();
}

function logs(id: string) {
  logId = id; logProject = null;
  openLogs(data.find(c => c.ID === id)!.Names);
}

// logs de todos os serviços do projeto no mesmo modal, com o prefixo do compose ("api-1  | ") em cada linha
function projectLogs(p: string) {
  const c = data.find(c => project(c) === p);
  if (!c) return;
  logId = null; logProject = {project: p, dir: workingDir(c)};
  openLogs(p);
}

// mais histórico: 500 -> 2000 -> 10000 -> tudo. Ao vivo, reconecta pedindo mais (até 10000)
function loadMore() {
  if ($('#more').getAttribute('aria-disabled') === 'true') {
    if (stream && TAILS[tailAt + 1]) toast(`Ao vivo, o histórico vai até ${fmt(+TAILS[LIVE_TAILS - 1])} linhas. Para carregar tudo, desligue o ao vivo.`);
    return;
  }
  tailAt++;
  if (stream) toggleFollow(true); else fetchLogs(true);
  renderMore();
}

// ponytail: teto fixo; um container falante por horas não pode crescer o DOM sem limite.
// Com mais histórico pedido, o teto sobe junto (no máximo 10000, ver LIVE_TAILS)
const MAX_LINES = 5000;

// as linhas do ao vivo chegam em rajada (500 de uma vez ao conectar): entram no DOM juntas, não uma a uma
function flushLogs() {
  const lb = $('#lb'), atEnd = lb.scrollHeight - lb.scrollTop - lb.clientHeight < 40, re = filterRe();
  const add = pending.splice(0);
  buf.push(...add);
  // anexar (em vez de trocar o texto) não apaga a seleção de quem está copiando
  lb.append(...(re ? add.map(l => hitNode(l, re)).filter(n => !!n) : add));
  // o teto vale para as linhas carregadas; na tela, com filtro, só as que casaram têm nó
  for (const l of buf.splice(0, Math.max(0, buf.length - Math.max(MAX_LINES, +TAILS[tailAt])))) {
    const n = re ? (l.split(re).length - 1) / 2 : 1;
    if (!n) continue;
    lb.firstChild!.remove();
    if (re) { hits -= n; hitLines--; }
  }
  if (re) renderHits();
  if (atEnd) lb.scrollTop = lb.scrollHeight;
}

// ao vivo: Server-Sent Events com o docker logs -f. Fechar o EventSource derruba a conexão e o servidor mata o processo
function toggleFollow(on = !stream, why = '') {
  const was = !!stream;
  stream?.close(); stream = null;
  if (was) flushLogs();  // o que já chegou entra antes de parar
  if (on) {
    tailAt = Math.min(tailAt, LIVE_TAILS - 1); complete = false;
    // EventSource não manda header: o token vai na query, só nestas rotas
    const q = new URLSearchParams({...logProject, t: TOKEN, tail: TAILS[tailAt]});
    const es = stream = new EventSource(logProject ? `/api/compose/logs/stream?${q}` : `/api/logs/${logId}/stream?${q}`);
    // cada conexão (inclusive a reconexão automática) recomeça do histórico pedido: limpa para não duplicar
    es.onopen = () => {
      pending = []; buf = []; hits = hitLines = 0; $('#lb').textContent = ''; renderHits();
      $('#lmeta').textContent = `Ao vivo · ${hist()} e as novas`;
    };
    es.onmessage = e => { if (pending.push(JSON.parse(e.data)) === 1) setTimeout(flushLogs, 50); };
    es.addEventListener('end', () => toggleFollow(false, logProject ? 'os containers pararam' : 'o container parou'));
    // queda de rede: o EventSource reconecta sozinho; CLOSED é recusa do servidor (token, erro)
    es.onerror = () => { if (es.readyState === EventSource.CLOSED) toggleFollow(false, 'falhou'); else $('#lmeta').textContent = 'Ao vivo · reconectando…'; };
  } else if (was) $('#lmeta').textContent = `Ao vivo parado às ${new Date().toLocaleTimeString('pt-BR')}${why ? ` · ${why}` : ''}`;
  $('#follow').setAttribute('aria-pressed', String(on));
  $('#refresh').setAttribute('aria-disabled', String(on));  // com o ao vivo ligado, Atualizar é redundante (mas continua no Tab)
  renderMore();
}

// botão Atualizar: com o ao vivo ligado não faz nada (já atualiza sozinho)
function refreshLogs() {
  if (!stream) fetchLogs();
}

function copyLogs() {
  navigator.clipboard.writeText($('#lb').textContent ?? '').then(() => toast('Logs copiados.', true), () => toast('Não consegui copiar.'));
}

function inspectHtml(d: Inspect, reveal: boolean) {
  const list = (xs: string[]) => xs.length ? xs.map(x => `<div>${x}</div>`).join('') : '<span class="font-sans text-muted">nenhum</span>';
  const nets = Object.entries(d.Networks).map(([n, ip]) => esc(ip ? `${n} · ${ip}` : n));
  const mounts = d.Mounts.map(m => esc(`${[m.Type, m.Name || m.Source].filter(Boolean).join(' ')} → ${m.Destination}${m.RW ? '' : ' (somente leitura)'}`));
  const env = d.Env.map(([k, v]) => `${esc(k)}=${v === null ? '<span aria-hidden="true">••••••</span><span class="sr-only">(oculto)</span>' : esc(v)}`);
  const dt = 'font-sans text-muted';
  return `<dl class="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 font-mono text-fg-soft [overflow-wrap:anywhere]">
    <dt class="${dt}">Restart</dt><dd>${esc(d.Restart)}</dd>
    <dt class="${dt}">Redes</dt><dd>${list(nets)}</dd>
    <dt class="${dt}">Mounts</dt><dd>${list(mounts)}</dd>
    <dt class="${dt}">Env</dt><dd>${list(env)}${d.Env.length ? `<button id="insp-env" onclick="loadInspect(${!reveal})"
      class="mt-1.5 ${BTN} font-sans text-fg hover:bg-hover">${reveal ? 'Ocultar valores' : 'Revelar valores'}</button>` : ''}</dd></dl>`;
}

// abrir o "Configuração" sempre busca mascarado; o valor real do env só vem pelo botão Revelar
async function loadInspect(reveal = false) {
  const id = logId, refocus = document.activeElement?.id === 'insp-env';
  let html: string;
  try {
    const r = await api(`/api/inspect/${id}${reveal ? '/env' : ''}`), j: unknown = await r.json();
    html = r.ok ? inspectHtml(j as Inspect, reveal) : esc(`Não consegui ler o inspect: ${j}`);
  } catch { html = 'Não consegui ler o inspect.'; }
  if (id !== logId || !$<HTMLDetailsElement>('#insp').open) return;  // trocou de container ou fechou enquanto carregava
  $('#insp-body').innerHTML = html;
  if (refocus) $('#insp-env')?.focus();
}

// baixa o que está na tela (com os timestamps do docker), sem ir de novo ao servidor
function downloadLogs() {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([$('#lb').textContent ?? ''], {type: 'text/plain'}));
  a.download = `${$('#lt').textContent}.log`;
  a.click(); setTimeout(() => URL.revokeObjectURL(a.href));
}

// roda no × direto e também no evento close (Esc); chamar duas vezes não faz mal
function afterClose() {
  toggleFollow(false);
  // fecha o "Configuração" e apaga o que estava nele: env revelado não fica na página
  $('#insp').removeAttribute('open'); $('#insp-body').textContent = 'Carregando…';
  // a linha pode ter sido redesenhada com o modal aberto; foca o botão Logs atual dela (ou o do cabeçalho do projeto)
  document.querySelector<HTMLElement>(logProject ? `[data-id="${CSS.escape(`stack-${logProject.project}`)}"][data-a="plogs"]`
                                                 : `[data-id="${logId}"][data-a="logs"]`)?.focus();
}

// terminal no navegador: xterm.js <-> WebSocket <-> `docker exec` com TTY (num PTY do servidor ou, no Windows,
// aberto dentro do container)
const xtermCss = document.createElement('style');
xtermCss.textContent = XTERM_CSS;
document.head.append(xtermCss);
let sess: {id: string; term: Terminal; ws: WebSocket; ro: ResizeObserver} | null = null;

function openShell(id: string) {
  const c = data.find(c => c.ID === id);
  if (!c) return;
  $('#shell-name').textContent = c.Names;
  $('#shell-status').textContent = 'Conectando…';
  $<HTMLDialogElement>('#shell').showModal();
  const term = new Terminal({cursorBlink: true, fontSize: 13, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace'});
  const fit = new FitAddon(), enc = new TextEncoder();
  term.loadAddon(fit);
  term.open($('#shell-box'));
  fit.fit();
  // o WebSocket do navegador não manda header custom: o token vai na query
  const ws = new WebSocket(`ws://${location.host}/api/exec/${id}?t=${encodeURIComponent(TOKEN)}`);
  ws.binaryType = 'arraybuffer';
  // a primeira mensagem tem que ser o tamanho: o servidor só sobe o docker exec depois dela
  const size = () => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({cols: term.cols, rows: term.rows})); };
  ws.onopen = () => { size(); $('#shell-status').textContent = 'Conectado. Esc vai para o terminal; feche pelo ×.'; term.focus(); };
  // binário é a saída do terminal; texto é um aviso do servidor (no Windows, imagem sem TTY), que vai para o status
  ws.onmessage = e => {
    if (typeof e.data === 'string') $('#shell-status').textContent = e.data;
    else term.write(new Uint8Array(e.data));
  };
  ws.onclose = () => { $('#shell-status').textContent = 'Sessão encerrada.'; };
  term.onData(d => { if (ws.readyState === WebSocket.OPEN) ws.send(enc.encode(d)); });
  term.onResize(size);
  const ro = new ResizeObserver(() => fit.fit());
  ro.observe($('#shell-box'));
  sess = {id, term, ws, ro};
}

function closeShell() {
  if (!sess) return;
  const {id, term, ws, ro} = sess;
  sess = null;
  ws.onclose = ws.onmessage = null;  // a sessão já foi: nada de escrever num terminal descartado
  ws.close();
  ro.disconnect();
  term.dispose();
  document.querySelector<HTMLElement>(`[data-id="${id}"][data-a="menu"]`)?.focus();
}

// criar container (docker run -d). O runSpec aponta o erro no campo; o servidor confere tudo de novo e monta o argv
const RUN_FIELDS: RunField[] = ['image', 'name', 'ports', 'env', 'restart', 'volume'];
const runField = (k: string) => $<HTMLInputElement>(`#run-${k}`);
let creating = false;

function openCreate() {
  $('#create-msg').innerHTML = '';
  $<HTMLDialogElement>('#create').showModal();
  runField('image').focus();
}

// marca os campos com erro e foca o primeiro; devolve true se está tudo certo
function markRunErrors(errors: RunErrors) {
  for (const k of RUN_FIELDS) {
    // aria-invalid="" vale false para o leitor de tela (e para o aria-invalid: do Tailwind): tem que ser "true"
    if (errors[k]) runField(k).setAttribute('aria-invalid', 'true'); else runField(k).removeAttribute('aria-invalid');
    $(`#run-${k}-err`).textContent = errors[k] || '';
  }
  const first = RUN_FIELDS.find(k => errors[k]);
  if (first) runField(first).focus();
  return !first;
}

// o botão lembra o que vai acontecer: com 0.0.0.0, a porta fica aberta para a rede
function createLabel() {
  if (!creating) $('#create-go').textContent = runField('public').checked ? 'Criar e expor na rede' : 'Criar e iniciar';
}

async function createContainer(e: SubmitEvent) {
  e.preventDefault();
  if (creating) return;
  const v = (k: string) => runField(k).value;
  const {spec, errors} = runSpec({image: v('image'), name: v('name'), ports: v('ports'), all_interfaces: runField('public').checked,
                                  env: v('env'), restart: v('restart'), volume: v('volume')});
  $('#create-msg').innerHTML = '';
  if (!markRunErrors(errors)) return;
  const go = $('#create-go'), label = spec.name || spec.image;
  creating = true;
  go.setAttribute('aria-disabled', 'true');
  go.textContent = 'Criando… (baixa a imagem se faltar)';
  $<HTMLFieldSetElement>('#create-fields').disabled = true;
  $('#shown').textContent = `Criando ${label}…`;
  let ok = false, msg: string;
  try {
    const r = await api('/api/run', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(spec)});
    msg = await r.json(); ok = r.ok;
  } catch { msg = 'Sem resposta do servidor do Docker GUI.'; }
  creating = false;
  go.removeAttribute('aria-disabled');
  $<HTMLFieldSetElement>('#create-fields').disabled = false;
  createLabel();
  const shown = $<HTMLDialogElement>('#create').open;  // pode ter sido fechado durante o pull
  if (!ok) {
    // o formulário fica como estava, para corrigir e tentar de novo. O docker escreve o progresso do pull no
    // stderr: no aviso fora do modal vai só a última linha, que é a que explica
    if (shown) {
      $('#create-msg').innerHTML = `<p class="font-medium">Não deu para criar ${esc(label)}.</p>
        <pre class="mt-1 whitespace-pre-wrap [overflow-wrap:anywhere] font-mono text-xs">${esc(msg || 'Erro sem mensagem.')}</pre>`;
      go.focus();  // o Enter num campo desabilitado durante o envio deixaria o foco no <body>
    } else toast(`Não deu para criar ${label}. ${msg.trim().split('\n').at(-1) || 'Erro sem mensagem.'}`);
    return load();  // run que falha no start (porta ocupada) deixa o container criado e parado
  }
  $<HTMLFormElement>('#create-form').reset(); markRunErrors({}); createLabel();
  if (shown) $<HTMLDialogElement>('#create').close();
  toast(`${label} criado, conferindo se ficou de pé…`, true);
  await load();
  // o ps do docker traz o ID curto e o do podman, o inteiro; o run devolve o inteiro
  const c = data.find(c => msg.startsWith(c.ID));
  if (c) confirmUp([c.ID]); else toast(`${label} criado.`, true);
}

type DiskKind = 'images' | 'volumes' | 'buildcache';
// [Type do docker system df, categoria da API de prune, rótulo, o que o prune apaga, aviso]; Containers fica de fora:
// parado se remove na lista. Volumes sem -a no servidor: no Docker 23+ só os anônimos saem
const DISK: [string, DiskKind, string, string, string][] = [
  ['Images', 'images', 'Imagens', 'as imagens que nenhum container usa', 'Dá para baixar de novo.'],
  ['Local Volumes', 'volumes', 'Volumes', 'os volumes que nenhum container usa', 'Os dados deles se perdem.'],
  ['Build Cache', 'buildcache', 'Build cache', 'o cache de build', 'O próximo build fica mais lento.']];
let disk: DiskUsage[] | string | null = null, diskBusy: DiskKind | '' = '', diskHtml = '';  // string = erro

// abrir a seção (e depois de uma limpeza ou remoção) relê o df e as listas que estiverem abertas
async function loadDisk() {
  await Promise.all([loadDf(), ...KINDS.filter(k => $<HTMLDetailsElement>(`#obj-${k}`).open).map(loadObjects)]);
}

async function loadDf() {
  try {
    const r = await api('/api/df'), j: unknown = await r.json();
    disk = r.ok ? j as DiskUsage[] : `Não consegui ler o uso de disco: ${j}`;
  } catch { disk = 'Não consegui ler o uso de disco. O servidor do Docker GUI está rodando?'; }
  render();
}

function renderDisk() {
  const html = disk === null ? '<p class="py-3 text-muted">Carregando…</p>'
    : typeof disk === 'string' ? `<p class="py-3 text-bad-fg">${esc(disk)}</p>`
    : DISK.map(([type, k, label, what, note]) => {
      const d = (disk as DiskUsage[]).find(d => d.Type === type), id = 'df-' + k, armed = arming?.id === id;
      if (!d) return '';
      const cls = armed ? 'bg-danger text-white ring-danger hover:bg-danger-hover' : 'text-fg hover:bg-hover';
      return `<div class="flex flex-wrap items-center gap-x-3 gap-y-2 py-3 border-t border-line/70">
        <div class="mr-auto min-w-0"><div class="font-medium text-fg-strong">${label}</div>
          <div class="text-xs text-muted">${esc(d.Size)} no total · ${esc(d.Reclaimable)} liberável · ${esc(d.TotalCount)} ${d.TotalCount === '1' ? 'item' : 'itens'}, ${esc(d.Active)} em uso</div></div>
        <button data-id="${id}" data-a="prune" ${diskBusy ? 'aria-disabled="true"' : ''} onclick="prune('${k}')"
          aria-label="${armed ? `Confirmar limpeza de ${label.toLowerCase()}` : `Limpar ${label.toLowerCase()}`}" class="${BTN} ${cls}">${
          diskBusy === k ? 'Limpando…' : armed ? 'Confirmar' : 'Limpar…'}</button>
        ${armed ? `<p aria-hidden="true" class="w-full text-xs text-bad-soft lg:text-right">Apagar ${what}? ${note} ${TOUCH ? 'Cancela sozinho em 8 s.' : 'Esc cancela.'}</p>` : ''}
      </div>`;
    }).join('');
  if (html !== diskHtml) $('#df').innerHTML = diskHtml = html;  // o render roda a cada poll: só troca se mudou
}

async function prune(k: DiskKind) {
  const [, , label, what, note] = DISK.find(d => d[1] === k)!;
  if (diskBusy || !confirmed('df-' + k, what, 'prune', note)) return;
  diskBusy = k; render();
  $('#shown').textContent = `Limpando ${label.toLowerCase()}…`;
  try {
    const r = await api('/api/prune/' + k, {method: 'POST'}), msg: string = await r.json();
    // image/volume prune terminam em "Total reclaimed space: 1.2GB"; builder prune, em "Total: 1.2GB"
    const freed = msg.match(/Total(?: reclaimed space)?:\s*(\S+)/)?.[1];
    if (r.ok) toast(`${label}: ${freed ? `${freed} liberados` : 'limpeza feita'}.`, true);
    else toast(`Não deu para limpar ${label.toLowerCase()}: ${msg || 'erro sem mensagem'}`);
  } catch { toast('Sem resposta do servidor do Docker GUI.'); }
  diskBusy = '';
  await loadDisk();
}

// imagens, volumes e redes um a um: cada lista só vai ao docker quando é aberta (e depois de uma remoção)
type ObjKind = 'images' | 'volumes' | 'networks';
type Obj = Image | Volume | Network;
const KINDS: ObjKind[] = ['images', 'volumes', 'networks'];
// [rota de /api/rm, com artigo, rótulo, plural, particípio, aviso da confirmação, lista vazia]
const OBJ: Record<ObjKind, [rm: string, one: string, label: string, many: string, done: string, note: string, none: string]> = {
  images: ['image', 'a imagem', 'Imagem', 'Imagens', 'removida', 'Dá para baixar de novo.', 'Nenhuma imagem.'],
  volumes: ['volume', 'o volume', 'Volume', 'Volumes', 'removido', 'Os dados dele se perdem.', 'Nenhum volume.'],
  networks: ['network', 'a rede', 'Rede', 'Redes', 'removida', '', 'Nenhuma rede.']};
const objs: Record<ObjKind, Obj[] | string | null> = {images: null, volumes: null, networks: null};  // string = erro
const objHtml: Partial<Record<ObjKind, string>> = {}, objErr = new Map<string, string>();  // data-id -> erro da remoção
let objBusy = '';

// o que vai para a API (ID para imagem e rede, nome para volume) e o que aparece na tela
const objRef = (k: ObjKind, o: Obj) => k === 'volumes' ? (o as Volume).Name : (o as Image | Network).ID;
const anon = (name: string) => /^[0-9a-f]{64}$/.test(name);  // volume anônimo: o nome é um hash
const objName = (k: ObjKind, o: Obj) => k === 'images' ? (o as Image).Tags.join(', ') || `sem tag ${(o as Image).ID.slice(0, 12)}`
  : anon((o as Volume | Network).Name) ? (o as Volume).Name.slice(0, 12) : (o as Volume | Network).Name;

async function loadObjects(k: ObjKind) {
  try {
    const r = await api('/api/' + k), j: unknown = await r.json();
    objs[k] = r.ok ? j as Obj[] : `Não consegui ler a lista: ${j}`;
  } catch { objs[k] = 'Não consegui ler a lista. O servidor do Docker GUI está rodando?'; }
  render();
}

function objItem(k: ObjKind, o: Obj) {
  const r = objRef(k, o), id = `rm-${k}-${r}`, armed = arming?.id === id, what = `${OBJ[k][1]} ${objName(k, o)}`;
  const err = objErr.get(id), hint = err && rmHint(err), badge = (t: string, title: string) =>
    `<span title="${title}" class="ml-1.5 px-1.5 py-0.5 rounded text-xs font-normal ring-1 ring-line-strong text-muted">${t}</span>`;
  // meta: HTML já escapado
  let title = esc(objName(k, o)), meta: string[];
  if (k === 'images') {
    const i = o as Image;
    if (!i.Tags.length) title = `sem tag${badge('dangling', 'nenhuma tag aponta para ela')}`;  // o ID vem logo abaixo
    meta = [`<span class="font-mono">${esc(i.ID.slice(0, 12))}</span>`, esc(i.Size), ...(i.Created ? [`criada há ${age(i.Created)}`] : [])];
  } else if (k === 'volumes') {
    const v = o as Volume;
    if (anon(v.Name)) title = `<span title="${esc(v.Name)}" class="font-mono">${title}…</span>${badge('anônimo', 'criado sem nome, por um container')}`;
    meta = [esc(v.Driver)];
  } else {
    const n = o as Network;
    if (n.Builtin) title += badge('padrão', 'vem com o daemon e não pode ser removida');
    meta = [esc(n.Driver), esc(n.Scope)];
  }
  // rede padrão não remove; rede sem ID (formato antigo do podman) não tem como
  const canRm = k !== 'networks' || (!(o as Network).Builtin && !!(o as Network).ID);
  const cls = armed ? 'bg-danger text-white ring-danger hover:bg-danger-hover' : 'text-fg hover:bg-hover';
  return `<li class="flex flex-wrap items-center gap-x-3 gap-y-2 py-3">
    <div class="mr-auto min-w-0 [overflow-wrap:anywhere]"><div class="font-medium text-fg-strong">${title}</div>
      <div class="text-xs text-muted">${meta.join(' · ')} · ${o.Containers.length
        ? `<span class="text-fg-soft">em uso por ${esc(o.Containers.join(', '))}</span>` : 'sem uso'}</div></div>
    ${canRm ? `<button data-id="${esc(id)}" data-a="rm" data-k="${k}" data-r="${esc(r)}" ${objBusy ? 'aria-disabled="true"' : ''}
      onclick="rmObj(this.dataset.k, this.dataset.r)" aria-label="${armed ? `Confirmar remoção de ${esc(what)}` : `Remover ${esc(what)}`}"
      class="${BTN} ${cls}">${objBusy === id ? 'Removendo…' : armed ? 'Confirmar' : 'Remover…'}</button>` : ''}
    ${armed ? `<p aria-hidden="true" class="w-full text-xs text-bad-soft lg:text-right">Apagar ${esc(what)}? ${OBJ[k][5]} ${TOUCH ? 'Cancela sozinho em 8 s.' : 'Esc cancela.'}</p>` : ''}
    ${err ? `<div class="w-full text-xs text-bad-fg">${hint ? `<p>${hint}</p>` : ''}
      <pre class="mt-1 whitespace-pre-wrap [overflow-wrap:anywhere] font-mono text-bad-soft">${esc(err)}</pre></div>` : ''}</li>`;
}

function renderObjects() {
  for (const k of KINDS) {
    const v = objs[k];
    const html = v === null ? '<p class="py-3 text-muted">Carregando…</p>'
      : typeof v === 'string' ? `<p class="py-3 text-bad-fg">${esc(v)}</p>`
      : !v.length ? `<p class="py-3 text-muted">${OBJ[k][6]}</p>`
      : `<ul aria-label="${OBJ[k][3]}" class="divide-y divide-line/70">${v.map(o => objItem(k, o)).join('')}</ul>`;
    if (html !== objHtml[k]) $(`#obj-${k}-list`).innerHTML = objHtml[k] = html;  // o render roda a cada poll
    $(`#obj-${k}-n`).textContent = Array.isArray(v) ? ` · ${v.length}` : '';
  }
}

// docker image/volume/network rm, com a confirmação em 2 passos. Em uso, o docker recusa e o erro fica no item
async function rmObj(k: ObjKind, r: string) {
  const list = objs[k], o = Array.isArray(list) ? list.find(o => objRef(k, o) === r) : undefined;
  if (!o || objBusy) return;
  const id = `rm-${k}-${r}`, [rm, one, label, , done, note] = OBJ[k], name = objName(k, o);
  if (!confirmed(id, `${one} ${name}`, 'rm', note)) return;
  const btns = [...document.querySelectorAll<HTMLElement>(`#obj-${k}-list [data-a="rm"]`)], i = btns.findIndex(b => b.dataset.id === id);
  const near = (btns[i + 1] || btns[i - 1])?.dataset.id;
  objErr.delete(id); objBusy = id; render();
  $('#shown').textContent = `Removendo ${one} ${name}…`;
  let ok = false;
  try {
    const res = await api(`/api/rm/${rm}/${encodeURIComponent(r)}`, {method: 'POST'}), msg: string = await res.json();
    ok = res.ok;
    if (ok) toast(`${label} ${name} ${done}.`, true);
    else {
      objErr.set(id, msg || 'erro sem mensagem');
      toast(`Não deu para remover ${one} ${name}. ${rmHint(msg) || 'O erro ficou na lista.'}`);
    }
  } catch { toast('Sem resposta do servidor do Docker GUI.'); }
  objBusy = '';
  // rede não ocupa disco; imagem e volume mudam o df também
  await (k === 'networks' ? loadObjects(k) : loadDisk());
  if (ok) (document.querySelector<HTMLElement>(`[data-id="${near}"][data-a="rm"]`) || $(`#obj-${k} > summary`)).focus();
}

// o HTML gerado chama estas funções pelo nome (onclick="act(...)"); com módulos nada é global, então
// esta lista é a interface completa entre o HTML e o código
Object.assign(window, {
  act, afterClose, askNotify, bulkAct, clearFilters, clearSel, composeAct, copyAddr, copyExec, copyLogs, downloadLogs,
  filterBy, loadDisk, loadHealth, loadInspect, loadMore, loadObjects, menuPick, openCreate, openShell, placeMenu, projectLogs,
  prune, refreshLogs, restartService, rmObj, runToastAction, selectAll, stackAct, toggleFollow, toggleSel,
});

$('#dlg').addEventListener('close', afterClose);
$('#shell').addEventListener('close', closeShell);
$('#shell').addEventListener('cancel', e => e.preventDefault());  // Esc é do vim/less, não do modal
$('#create-form').addEventListener('submit', createContainer);
$('#run-public').addEventListener('change', createLabel);
$('#create').addEventListener('close', () => $('#new').focus());
$<HTMLInputElement>('#q').oninput = render;
$('#lf').oninput = paint;
// Esc no filtro com texto limpa o filtro; vazio, segue para o modal, que fecha
$('#lf').addEventListener('keydown', e => {
  const f = e.target as HTMLInputElement;
  if (e.key === 'Escape' && f.value) { e.preventDefault(); f.value = ''; paint(); }
});
// aba escondida solta o stream de eventos (e o docker events do servidor); ao voltar, atualiza na hora
document.addEventListener('visibilitychange', () => {
  if (watching()) connectEvents(); else closeEvents();
  if (!document.hidden) load();
});
$('#notify').hidden = !canAsk();
readHash(); render(); load(); connectEvents(); statsLoop();
// o tique é sempre de 2 s; com o stream de eventos no ar, só consulta se a última consulta tem mais de 30 s
setInterval(() => { if (watching() && Date.now() - lastLoad > (live ? POLL_LIVE : POLL) - 500) load(); }, POLL);
