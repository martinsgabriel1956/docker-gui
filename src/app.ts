import {
  type Bucket, type Container, type ContainerState, type DiskUsage, type Image, type Network, type Port, type RunErrors,
  type RunField, type Sample, type Stats, type Tone, type Volume, HISTORY, age, anonVolume, bucket, bulkSummary, bytes, esc,
  fmtBytes, hasHealth, io, isProblem, logFilter, logLevel, newProblems, percent, ports, project, prunedVolumes, pushSample,
  reclaimShare, rmHint, runSpec, service, shortImage, sparkPoints, status, tone, trend, usage, workingDir,
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
type MenuAction = Action | 'exec' | 'shell' | 'srestart' | 'noremove';
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
// Logs é a ação mais usada e a mais inofensiva: sem contorno, para a principal (Parar, Iniciar) ser a que salta aos olhos
const ghost = () => BTN.replace(' ring-1 ring-line-strong/80', '');
const BTN = 'px-2.5 py-1 max-lg:min-h-11 max-lg:px-4 max-lg:text-sm rounded text-xs font-medium ring-1 ring-line-strong/80 transition motion-reduce:transition-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent aria-disabled:opacity-40 aria-disabled:cursor-wait';
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
  // superfície sólida: translúcido, o texto disputava com a linha que estivesse embaixo
  const html = `<div class="flex items-center gap-3 rounded-lg bg-raised ring-1 shadow-lg shadow-black/30 text-sm px-4 py-3 ${ok
    ? 'ring-ok/50 text-ok-soft'
    : 'ring-bad/50 text-bad-soft'}"><span>${REMOTE ? `<span class="font-semibold text-warn-fg">${esc(CTX)}</span> · ` : ''}${esc(msg)}</span>${action ? `<button onclick="runToastAction()"
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
  es.onopen = () => { live = true; showLive(); refresh(); };  // o que mudou antes de o docker events começar a ouvir
  // uma rajada (compose up: create, start... de cada serviço) vira uma consulta só, no máximo COALESCE ms depois
  es.onmessage = () => {
    if (watching() && evTimer === undefined) evTimer = setTimeout(() => { evTimer = undefined; refresh(); }, COALESCE);
  };
  // desiste por um tempo e volta ao poll de 2 s (que mostra o erro, se houver); "end" é o docker events que
  // terminou (daemon fora do ar, podman sem events...)
  const drop = () => { closeEvents(); evRetry = setTimeout(connectEvents, POLL_LIVE); };
  es.addEventListener('end', drop);
  // queda: o EventSource reconecta sozinho, com o poll de 2 s enquanto isso; CLOSED é recusa (token, limite, erro)
  es.onerror = () => { live = false; showLive(); if (es.readyState === EventSource.CLOSED) drop(); };
}
function closeEvents() { events?.close(); events = null; live = false; showLive(); }
// no cabeçalho: a lista vem dos eventos do docker (muda na hora) ou do poll de 2 s (o docker events caiu ou não existe)
function showLive() {
  $('#live').innerHTML = live ? '<span aria-hidden="true" class="inline-block size-1.5 mr-1.5 align-middle rounded-full bg-ok"></span>ao vivo'
    : '<span aria-hidden="true" class="inline-block size-1.5 mr-1.5 align-middle rounded-full ring-1 ring-dim"></span>a cada 2 s';
  $('#live').title = live ? 'A lista muda assim que o docker avisa (docker events)' : 'Sem o docker events: a lista é relida a cada 2 s';
}

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

// favicon: o prompt (>_) no ciano do acento, com a contagem da faixa de atenção por cima ("!" quando os dados estão velhos)
const icon = document.head.appendChild(Object.assign(document.createElement('link'), {rel: 'icon'}));
function setIcon(badge: string) {
  const href = 'data:image/svg+xml,' + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none"><rect x="1" y="2.5" width="22" height="19" rx="3" fill="#141a22"/><path d="M5.5 8.5 9.5 12l-4 3.5M11.5 16h6" stroke="#3fd0dc" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>${badge
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
    <polyline points="${sparkPoints(vs, w, ht, HISTORY, k === 'cpu' ? 1 : 0)}" stroke-width="1.5" class="stroke-accent"/></svg></span>`;
}

// onde a página age (docker_gui.py, where()): "docker · producao". Remoto fica em âmbar, com o endereço para o leitor de
// tela e no title; o contexto também vai para o título da aba, menos o default, que é o caso comum
const WHERE = document.documentElement.dataset, REMOTE = 'remote' in WHERE, CTX = WHERE.where?.split(' · ')[1] ?? '';
$('#where').innerHTML = WHERE.where ? `${esc(WHERE.where)}${REMOTE ? `<span class="sr-only">, daemon remoto em ${esc(WHERE.host!)}</span>` : ''}` : '';
$('#where').title = WHERE.host ? `Daemon em ${WHERE.host}` : '';
if (REMOTE) {
  $('#where').classList.replace('text-muted', 'text-warn-fg');
  $('#where').classList.replace('ring-line-strong', 'ring-warn/60');
}
const TITLE = CTX && CTX !== 'default' ? `Docker GUI · ${CTX}` : 'Docker GUI';
// endereço das portas: localhost, ou o host do daemon remoto (tcp://10.0.0.5:2376, ssh://eu@servidor -> 10.0.0.5, servidor)
const PORT_HOST = (() => { try { return REMOTE && new URL(WHERE.host!).hostname || 'localhost'; } catch { return 'localhost'; } })();
// remoto: a faixa âmbar fica no topo o tempo todo, e o "só esta máquina" do Novo container passa a ser a de lá
if (REMOTE) {
  $('#remote').hidden = false;
  $('#remote').innerHTML = `Daemon remoto <strong class="font-semibold">${esc(CTX)}</strong> <span class="font-mono text-xs">(${esc(WHERE.host!)})</span>: tudo o que você fizer aqui vale lá.`;
  $('#run-ports-hint').innerHTML = `portaDoHost:portaDoContainer, separadas por vírgula ou espaço. Ficam em <code class="font-mono">127.0.0.1</code> do daemon remoto ${esc(CTX)}: só aquela máquina acessa, não esta.`;
}

function renderCount() {
  const n = (k: Bucket) => data.filter(c => bucket(c) === k).length, running = data.filter(c => c.State === 'running').length;
  const problemTxt = problemKind ? PROBLEM_TXT[problemKind] : '';
  setIcon(problem ? '!' : n('problema') > 9 ? '9+' : String(n('problema') || ''));
  document.title = !lastOk && !problem ? TITLE : !problem ? `${TITLE} · ${running} rodando${n('problema') ? ` · ${n('problema')} com problema` : ''}`
    : `${TITLE} · ${problemTxt}`;
  if (problem) {
    const t = lastOk?.toLocaleTimeString('pt-BR', {hour: '2-digit', minute: '2-digit'});
    $('#count').textContent = lastOk ? `Desatualizado · dados de ${t}` : problemTxt[0].toUpperCase() + problemTxt.slice(1);
    return;
  }
  const pill = 'shrink-0 whitespace-nowrap rounded px-2 py-0.5 max-lg:py-3 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent';
  // um controle segmentado (é um filtro, não um selo); no celular ele rola de lado em vez de quebrar em duas linhas
  const segs = BUCKETS.filter(([k]) => n(k) || only === k).map(([k, one, many, color]) =>
    `<button data-id="count-${k}" data-a="filter" aria-pressed="${only === k}" onclick="filterBy('${k}')"
      class="${pill} rounded-none font-mono text-data hover:bg-hover aria-pressed:bg-fg-strong aria-pressed:text-canvas ${color}"><span class="font-semibold tabular-nums">${n(k)}</span> ${n(k) === 1 ? one : many}</button>`).join('');
  $('#count').innerHTML = (segs ? `<span class="flex max-lg:max-w-full max-lg:overflow-x-auto rounded ring-1 ring-line divide-x divide-line">${segs}</span>`
    : '<span>0 containers</span>') + (only || $<HTMLInputElement>('#q').value.trim()
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
  const a = `${PORT_HOST}:${h}`;
  navigator.clipboard.writeText(a).then(() => toast(`Copiado: ${a}`, true), () => toast('Não consegui copiar.'));
}

// no daemon remoto, a porta abre daqui só pelo host dele e só se o bind não for o loopback de lá (127.0.0.1, ::1):
// é o padrão do "Novo container", e aí ela só existe para aquela máquina
const reachable = (c: Container, h: string) => !REMOTE || c.Ports.split(', ').some(b => {
  const m = b.match(/^(.*):(\d+)(?:-(\d+))?->/);
  return !!m && +h >= +m[2] && +h <= +(m[3] ?? m[2]) && !/^(127\.|\[?::1\]?$)/.test(m[1]);
});

function portChip(c: Container, [h, p, proto]: Port) {
  const label = `${h}<span class="font-sans">→</span>${p}${proto === 'tcp' ? '' : '/' + proto}`, svg = 'aria-hidden="true" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" class="inline size-3 ml-1 -mt-0.5"';
  // texto mono, como o PORTS do docker ps: o link sublinha no hover, e o padding vira alvo de toque no celular
  const base = 'whitespace-nowrap font-mono text-xs px-1 py-0.5 max-lg:px-2 max-lg:py-3.5 rounded underline-offset-4 focus-visible:outline-2 focus-visible:outline-accent';
  // faixa longa: não há um endereço para abrir ou copiar, então o chip só informa
  if (!reachable(c, h)) return `<span title="Só no loopback do daemon remoto ${esc(CTX)}: não abre daqui"
    class="${base} text-muted">${label}</span>`;
  if (h.includes('-')) return `<span title="Faixa de portas: ${h} do host → ${p} do container"
    class="${base} text-muted">${label}</span>`;
  return c.State === 'running' && proto === 'tcp' && !NOT_HTTP.has(+p)
    ? `<a href="http://${PORT_HOST}:${h}" target="_blank" rel="noopener" aria-label="Abrir ${PORT_HOST}:${h} em nova aba (porta ${p} do container)"
        title="Abrir no navegador" class="${base} text-accent-fg hover:underline hover:bg-accent/10">${label}<svg ${svg}><path d="M6 3h7v7M13 3 4 12"/></svg></a>`
    : `<button onclick="copyAddr('${h}')" aria-label="Copiar ${PORT_HOST}:${h} (porta ${p}/${proto} do container)" title="Copiar ${PORT_HOST}:${h}"
        class="${base} text-fg-soft hover:text-fg-strong hover:underline hover:bg-hover">${label}<svg ${svg}><rect x="5.5" y="5.5" width="7.5" height="7.5" rx="1.5"/><path d="M3 10.5V4a1 1 0 0 1 1-1h6.5"/></svg></button>`;
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

// última linha do log de quem caiu (saiu com erro ou está em loop): o motivo costuma estar ali, sem abrir o modal.
// Uma consulta por queda (estado + código de saída), não por poll: o "há 10 min" do Status muda sozinho
const tails: Record<string, string> = {};
const tailKey = (c: Container) => c.ID + c.State + (c.Status.match(/\((\d+)\)/)?.[1] ?? '');
const fell = (c: Container) => isProblem(c) && c.State !== 'running';
async function loadTail(c: Container) {
  const k = tailKey(c);
  if (k in tails) return;
  tails[k] = '';
  try {
    const r = await api(`/api/logs/${c.ID}?tail=5`), txt: string = await r.json();
    // stdout e stderr chegam um depois do outro: o timestamp ISO no começo de cada linha devolve a ordem
    tails[k] = r.ok ? txt.split('\n').filter(l => l.trim()).sort().at(-1)?.replace(/^\d{4}-\d\d-\d\dT\S+\s/, '') ?? '' : '';
  } catch { return; }  // sem a linha: o status traduzido já diz o essencial
  if (tails[k]) render();
}

const rowCache = new Map<string, {sig: string; html: string}>();
function row(c: Container, withProject = false) {
  if (fell(c)) loadTail(c);
  const sig = JSON.stringify([c, withProject, tails[tailKey(c)], busy.get(c.ID), arming?.id === c.ID, errors.get(c.ID), health[c.ID + c.Status], stats[sid(c.ID)],
                              series.get(sid(c.ID))?.at(-1)?.t, composing.has(project(c)), TOUCH, sel.has(c.ID)]);
  const hit = rowCache.get(c.ID);
  if (hit?.sig === sig) return hit.html;
  const html = rowHtml(c, withProject);
  rowCache.set(c.ID, {sig, html});
  return html;
}

// armada, a linha troca a principal pelo Confirmar e o "⋯" por um ×, nas mesmas larguras: a coluna não muda e a tabela
// não se mexe na hora da decisão. O aviso também não alarga a coluna ([contain:inline-size]): quebra dentro dela
const RESTART_ICON = '<svg aria-hidden="true" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" class="size-4"><path d="M13 8a5 5 0 1 1-1.6-3.7"/><path d="M13 2.5v3h-3"/></svg>';
const X_ICON = '<svg aria-hidden="true" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" class="size-4"><path d="M4 4l8 8M12 4l-8 8"/></svg>';
// todo estado armado tem o × ao lado do Confirmar (no toque não há Esc, e esperar 8 s não é saída) e o mesmo aviso,
// que começa pelo contexto quando o daemon é remoto: a confirmação diz onde vai apagar
const cancelBtn = (id: string, what: string) => `<button data-id="${id}" data-a="cancel" aria-label="Cancelar ${what}" title="Cancelar (Esc)"
  onclick="disarm()" class="grid place-items-center shrink-0 lg:w-9 max-lg:w-11 ${BTN} text-fg hover:bg-hover">${X_ICON}</button>`;
const armNote = (text: string, cls = 'w-full [contain:inline-size] lg:text-right text-balance') => `<p aria-hidden="true" class="${cls} text-xs text-bad-soft">${
  REMOTE ? `<span class="font-semibold text-warn-fg">${esc(CTX)}</span> · ` : ''}${text} ${TOUCH ? 'Cancela sozinho em 8 s.' : 'Esc cancela.'}</p>`;
function rowHtml(c: Container, withProject: boolean) {
  const b = busy.get(c.ID), t = TONE[b ? 'busy' : tone(c)], st = status(c), pp = ports(c.Ports), p = project(c);
  const armed = arming?.id === c.ID, prim = PRIMARY[c.State], sec = SECONDARY[c.State];
  const u = c.State === 'running' && !b && stats[sid(c.ID)] ? usage(stats[sid(c.ID)]) : null, h = series.get(sid(c.ID)) ?? [];
  const slot = (w = 'lg:w-20') => `<span aria-hidden="true" class="${w} shrink-0 max-lg:hidden"></span>`;
  const btn = (a: RowAction, cls = 'text-fg hover:bg-hover', text = LABEL[a], aria = `${LABEL[a]} ${esc(c.Names)}`, base = BTN) =>
    `<button data-id="${c.ID}" data-a="${a}" ${b && a !== 'logs' ? 'aria-disabled="true"' : ''}
      aria-label="${aria}" aria-describedby="st-${c.ID}" onclick="act('${a}','${c.ID}')" class="lg:w-20 max-lg:min-w-24 shrink-0 ${base} ${cls}">${text}</button>`;
  // ações raras (reiniciar, pausar, remover, exec) ficam no "⋯": a linha mostra só a ação principal e Logs
  const svc = p && workingDir(c) && service(c);  // compose restart só com a pasta no label, como o compose up
  // Reiniciar (o ciclo de quem desenvolve: muda, reinicia, olha os logs) fica à vista, em ícone para caber; sai do "⋯"
  const restart = c.State === 'running' ? `<button data-id="${c.ID}" data-a="restart" ${b ? 'aria-disabled="true"' : ''} aria-label="Reiniciar ${esc(c.Names)}"
      aria-describedby="st-${c.ID}" title="Reiniciar (r)" onclick="act('restart','${c.ID}')"
      class="grid place-items-center shrink-0 lg:w-9 max-lg:w-11 ${BTN} text-fg hover:bg-hover">${RESTART_ICON}</button>` : slot('lg:w-9');
  const more = [sec && sec !== 'restart' && [sec, LABEL[sec]], svc && ['srestart', `Reiniciar serviço ${esc(svc)}`], c.State === 'running' && ['pause', 'Pausar'],
                c.State === 'running' && ['shell', 'Abrir terminal'], c.State === 'running' && ['exec', 'Copiar docker exec'],
                removable(c) ? ['remove', 'Remover…'] : ['noremove', 'Pare antes de remover']].filter((x): x is [MenuAction, string] => !!x);
  const menu = !more.length ? slot('lg:w-9') : menuBox(c.ID, `Mais ações para ${esc(c.Names)}`, !!b,
    more.map(([a, text]) => a === 'noremove' ? `<button data-id="${c.ID}" data-a="m-noremove" aria-disabled="true" title="O docker só remove container parado (sem -f)"
      class="${MENU_ITEM} text-muted cursor-not-allowed hover:bg-transparent">${text}</button>` : `<button data-id="${c.ID}" data-a="m-${a}" ${b || (a === 'srestart' && composing.has(p)) ? 'aria-disabled="true"' : ''} onclick="menuPick(this); ${a === 'exec' ? `copyExec('${c.ID}')` : a === 'shell' ? `openShell('${c.ID}')`
      : a === 'srestart' ? `restartService('${c.ID}')` : `act('${a}','${c.ID}')`}"
      class="${MENU_ITEM} ${a === 'remove' ? 'text-bad-fg' : 'text-fg'}">${text}</button>`).join(''));
  const healthBox = hasHealth(c) && !b ? `<details data-keep="health" class="mt-1 text-xs" ontoggle="this.open && loadHealth('${c.ID}')">
      <summary class="cursor-pointer w-fit py-1 max-lg:py-3.5 rounded focus-visible:outline-2 focus-visible:outline-accent text-muted hover:text-fg">Ver último healthcheck</summary>
      <pre class="mt-1 whitespace-pre-wrap [overflow-wrap:anywhere] font-mono text-fg-soft">${esc(health[c.ID + c.Status] || 'Carregando…')}</pre></details>` : '';
  // no card do celular, imagem, status e portas recuam até o nome (pl-14 = checkbox + bolinha + os gaps)
  const on = sel.has(c.ID);
  return `<tr data-row data-key="c:${c.ID}" role="row" class="border-t border-line/70 ${on ? 'bg-accent/10' : 'hover:bg-raised/70'} transition motion-reduce:transition-none max-lg:block max-lg:px-4 max-lg:py-4 max-lg:space-y-1.5">
    <th role="rowheader" scope="row" class="py-3 pl-4 pr-6 max-lg:block max-lg:p-0 text-left font-normal"><div class="flex items-center gap-3">
      <input type="checkbox" data-id="${c.ID}" data-a="sel" ${on ? 'checked' : ''} aria-label="Selecionar ${esc(c.Names)}" onchange="toggleSel('${c.ID}')" class="${CHECK}">
      <span aria-hidden="true" class="size-2 shrink-0 rounded-full ${t[0]}"></span>
      <div class="min-w-0"><div class="font-mono text-data font-semibold text-fg-strong lg:truncate lg:max-w-[28ch]" title="${esc(c.Names)} · ${c.ID.slice(0, 12)}">${esc(c.Names)}</div>${
           withProject && p ? `<div class="font-mono text-xs text-muted">${esc(p)}</div>` : ''}</div></div></th>
    <td role="cell" class="font-mono text-xs text-muted pr-4 max-lg:block max-lg:p-0 max-lg:pl-14 [overflow-wrap:anywhere]">
      <span class="sr-only lg:hidden">Imagem: </span><div class="lg:truncate lg:max-w-[24ch] lg:[direction:rtl] lg:text-left" title="${esc(c.Image)}"><bdi dir="ltr">${esc(shortImage(c.Image))}</bdi></div></td>
    <td role="cell" class="font-mono text-data pr-4 lg:min-w-[24ch] max-lg:block max-lg:p-0 max-lg:pl-14" title="${esc(c.Status)}">
      <span id="st-${c.ID}" class="${t[1]}">${b ? VERB[b] : esc(st[0])}${st[1] && !b ? `<span class="block text-xs text-muted">${st[1]}</span>` : ''}</span>${
      // [contain:inline-size]: a linha do log ocupa a largura que a coluna já tem, sem alargá-la (a tabela estourava)
      fell(c) && !b && tails[tailKey(c)] ? `<span class="block [contain:inline-size] mt-1 font-mono text-xs text-fg-soft lg:truncate [overflow-wrap:anywhere]" title="${esc(tails[tailKey(c)])}"><span aria-hidden="true" class="text-dim">› </span><span class="sr-only">Última linha do log: </span>${esc(tails[tailKey(c)])}</span>` : ''}${
      u ? `<span id="us-${c.ID}" class="block text-xs font-mono text-muted" title="${esc(u[2])}"><span class="whitespace-nowrap">${esc(u[0])} ${spark(h, 'cpu')}</span> <span class="whitespace-nowrap">· ${esc(u[1])} ${spark(h, 'mem')}</span></span>` : ''}${b ? '' : errHtml(c) + healthBox}</td>
    <td role="cell" class="pr-4 max-lg:hidden max-lg:has-[div]:block max-lg:p-0 max-lg:pl-14">${pp.length
      ? `<div class="flex flex-wrap gap-1 max-lg:gap-x-2 max-lg:-ml-2 max-lg:-my-3">${pp.map(x => portChip(c, x)).join('')}</div>` : ''}</td>
    <td role="cell" class="pr-4 max-lg:block max-lg:p-0 max-lg:pt-2"><div class="flex justify-end max-lg:justify-start items-center gap-1.5 max-lg:gap-2">
      ${armed ? btn('remove', 'bg-danger text-white ring-danger hover:bg-danger-hover', 'Apagar', `Confirmar remoção de ${esc(c.Names)}`)
        : prim ? btn(prim, prim === 'start' ? 'text-ok-fg hover:bg-ok/10' : undefined) : slot()}${restart}${btn('logs', 'text-fg-soft hover:text-fg-strong hover:bg-hover', undefined, undefined, ghost())}
      ${armed ? cancelBtn(c.ID, `remoção de ${esc(c.Names)}`) : menu}
    </div>${armed ? armNote(`Apagar ${esc(c.Names)} de vez? Os volumes ficam.`, 'mt-1.5 [contain:inline-size] lg:text-right text-balance') : ''}</td></tr>`;
}

// "⋯" das ações raras, de um container ou de um projeto: o id e o aria-label dizem de quem é
const MENU_ITEM = 'block w-full text-left px-3 py-2 max-lg:py-3 rounded text-sm hover:bg-hover focus-visible:outline-2 focus-visible:outline-accent';
const menuBox = (id: string, label: string, off: boolean, items: string) => `<details data-keep="menu" class="shrink-0" ontoggle="placeMenu(this)">
    <summary data-id="${id}" data-a="menu" aria-label="${label}" ${off ? 'aria-disabled="true"' : ''}
      class="list-none [&::-webkit-details-marker]:hidden cursor-pointer grid place-items-center lg:w-9 max-lg:w-11 ${BTN} text-fg hover:bg-hover">
      <svg aria-hidden="true" viewBox="0 0 16 16" fill="currentColor" class="size-4"><circle cx="3.5" cy="8" r="1.3"/><circle cx="8" cy="8" r="1.3"/><circle cx="12.5" cy="8" r="1.3"/></svg></summary>
    <div class="fixed z-30 min-w-48 rounded-lg bg-raised ring-1 ring-line-strong p-1 shadow-lg shadow-black/40">${items}</div></details>`;

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
// rolar (a página, a tabela de lado, o modal) leva o menu junto do "⋯"; só fecha quando o "⋯" sai da tela. Fechar a cada
// rolagem derrubava o menu no celular com um toque de dedo, e no desktop quando o clique precisava rolar a tabela até o "⋯"
addEventListener('scroll', () => document.querySelectorAll<HTMLDetailsElement>('details[data-keep="menu"][open]').forEach(d => {
  const r = d.querySelector('summary')!.getBoundingClientRect();
  if (r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth) d.removeAttribute('open');
  else placeMenu(d);
}), true);

function closeMenus(except?: Element | null) {
  document.querySelectorAll('details[data-keep="menu"][open]').forEach(d => d !== except && d.removeAttribute('open'));
}
// clique fora ou Esc fecha o "⋯"
document.addEventListener('click', e => closeMenus(e.target instanceof Element ? e.target.closest('details[data-keep="menu"]') : null));

const bandHead = (text: string, cls: string) => `<tr data-key="h:attn" role="row" class="max-lg:block"><th role="columnheader" colspan="5" scope="colgroup"
  class="max-lg:block px-4 pt-4 pb-2 text-left font-mono text-xs font-semibold uppercase border-t border-line ${cls}">${text}<span class="ml-3 font-sans font-normal normal-case text-bad-soft/80">healthcheck falhando, loop de reinício ou saída com erro</span></th></tr>`;

// cabeçalho do projeto compose: contagem e ações para o stack inteiro (sempre sobre todos os containers do projeto).
// Como na linha: uma ação principal (Iniciar tudo se algo está parado, senão Parar tudo), Logs e o resto no "⋯"
function groupHead(k: string, label: string) {
  const all = data.filter(c => project(c) === k), on = all.filter(c => c.State === 'running').length;
  const anyBusy = composing.has(k) || all.some(c => busy.has(c.ID)), dir = k && workingDir(all[0]), armed = arming?.id === `stack-${k}`;
  const inBand = all.filter(isProblem).length, ek = esc(k), off = anyBusy ? 'aria-disabled="true"' : '';
  const prim: Action = stackList('start', k).length ? 'start' : 'stop';
  // com um container só, o botão diz qual: "Iniciar worker" em vez de "Iniciar tudo (1)"
  const sbtn = (a: Action, text: string, cls: string) => {
    const list = stackList(a, k), n = list.length, one = n === 1 ? `${LABEL[a]} ${esc(list[0].Names)}` : '', label = one || `${text} (${n})`;
    return k && n ? `<button data-id="stack-${ek}" data-a="${a === prim ? a : `m-${a}`}" data-p="${ek}" ${off} aria-label="${one ? `${one} do projeto ${ek}` : `${text} do projeto ${ek} (${n})`}"
      title="${esc(list.map(c => c.Names).join(', '))}" onclick="${a === prim ? '' : 'menuPick(this); '}stackAct('${a}', this.dataset.p)" class="${cls}">${label}</button>` : '';
  };
  // compose up/pull/down e logs do projeto: só com o working_dir no label (o servidor precisa dele para achar o projeto)
  const cbtn = (a: ComposeAction, text: string, cls = MENU_ITEM + ' text-fg') =>
    `<button data-id="stack-${ek}" data-a="m-${a}" data-p="${ek}" ${off} aria-label="${text.replace('…', '')} do projeto ${ek}"
      onclick="menuPick(this); composeAct('${a}', this.dataset.p)" class="${cls}">${composing.get(k) === a ? COMPOSE_VERB[a] : text}</button>`;
  // grupos do menu, separados por um traço: Reiniciar/Parar ou Iniciar, os comandos do compose e, por último, o down
  const groups = [STACK.filter(([a]) => a !== prim).map(([a, text]) => sbtn(a, text, MENU_ITEM + ' text-fg')).join(''),
                  dir ? cbtn('up', 'compose up') + cbtn('rebuild', 'compose up --build') + cbtn('pull', 'compose pull') : '',
                  dir ? cbtn('down', 'compose down…', MENU_ITEM + ' text-bad-fg') : ''].filter(Boolean);
  const verb = composing.get(k);
  // a faixa de estado: um bloco por container do projeto, na cor do estado, como uma calha de processos
  const strip = k ? `<span aria-hidden="true" data-strip class="flex items-center gap-0.5">${[...all].sort((a, b) => a.Names.localeCompare(b.Names)).map(c =>
    `<span title="${esc(c.Names)}: ${esc(status(c)[0])}" class="h-3 w-1.5 rounded-[1px] ${TONE[busy.has(c.ID) ? 'busy' : tone(c)][0]}"></span>`).join('')}</span>` : '';
  return `<tr data-key="g:${ek}" role="row" class="max-lg:block"><th role="columnheader" colspan="5" scope="colgroup" class="max-lg:block px-4 pt-3 pb-2.5 text-left font-normal border-t border-line-strong bg-raised">
    <div class="flex flex-wrap items-center gap-x-3 gap-y-2">
      <span class="font-mono text-data font-semibold ${k ? 'text-fg-strong' : 'text-muted'}">${label}</span>${strip}
      ${k ? `<span class="font-mono text-xs ${verb ? 'text-fg-strong' : 'text-muted'}">compose · ${verb ? COMPOSE_VERB[verb] : `${on} de ${all.length} rodando`}</span>` : ''}
      ${k && inBand ? `<span class="text-xs text-bad-fg">${inBand} na faixa de atenção, acima</span>` : ''}
      <span class="lg:ml-auto max-lg:w-full flex flex-wrap items-center gap-1.5 max-lg:gap-2">${sbtn(prim, prim === 'start' ? 'Iniciar tudo' : 'Parar tudo',
        `${BTN} ${prim === 'start' ? 'text-ok-fg hover:bg-ok/10' : 'text-fg hover:bg-hover'}`)}${dir
        ? `<button data-id="stack-${ek}" data-a="plogs" data-p="${ek}" aria-label="Logs do projeto ${ek}" onclick="projectLogs(this.dataset.p)"
            class="lg:w-20 ${ghost()} text-fg-soft hover:text-fg-strong hover:bg-hover">Logs</button>` : ''}${armed
        ? `<button data-id="stack-${ek}" data-a="down" data-p="${ek}" aria-label="Confirmar compose down do projeto ${ek}" onclick="composeAct('down', this.dataset.p)"
            class="${BTN} bg-danger text-white ring-danger hover:bg-danger-hover">Derrubar ${ek}</button>${cancelBtn(`stack-${ek}`, `compose down do projeto ${ek}`)}`
        : groups.length ? menuBox(`stack-${ek}`, `Mais ações do projeto ${ek}`, anyBusy, groups.join('<hr class="my-1 border-line">')) : ''}</span>
      
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
    ? [...(attn.length ? [bandHead(`Precisa de atenção · ${attn.length}`, 'text-bad-fg bg-bad/10'), ...attn.map(c => row(c, true))] : []),
       ...keys.flatMap(k => [...(heads ? [groupHead(k, k ? esc(k) : keys.length > 1 ? 'Sem projeto compose' : 'Demais containers')] : []),
                             ...groups.get(k)!.map(c => row(c))])]
    : [`<tr data-key="empty" role="row" class="max-lg:block"><td role="cell" colspan="5" class="max-lg:block py-16 px-4 text-center text-muted">${
      !lastOk ? (problem ? 'Sem dados ainda.' : 'Carregando…')  // nunca recebeu dados: não afirma que a lista está vazia
      : !data.length ? 'Nenhum container ainda. Crie um em “Novo container” ou com <code class="font-mono">docker run</code>.'
      : `Nenhum container ${label}${q ? `corresponde a “${esc(q)}”` : 'agora'}.`}</td></tr>`]);
  dirty = false;
  // o aviso do compose down fica preso no pé da tela: dentro da tabela, ou empurrava as linhas ou cobria uma delas
  const dk = arming?.a === 'down' ? arming.name : '';
  const dock = dk ? armNote(`Derrubar ${esc(dk)}? ${esc(downNote(dk))}`, 'max-w-[80ch]') : '';
  if ($('#armdock').innerHTML !== dock) $('#armdock').innerHTML = dock;
  $('#armdock').classList.toggle('hidden', !dock);
  renderCount();
  renderBulk();
  renderDlg();
  renderDisk();
  renderObjects();
  if (f?.id) refocus(f.id, f.a);
  saveHash();
  // só escreve na região viva quando a mensagem muda, para não apagar o anúncio de uma ação em andamento
  const say = arming ? `${REMOTE ? `No daemon remoto ${CTX}: ` : ''}${arming.a === 'down' ? `Clique em Derrubar ${arming.name} para derrubar o projeto.`
    : arming.a === 'prune' ? `Clique em Limpar para apagar ${arming.name}.` : `Clique em Apagar para apagar ${arming.name} de vez.`} ${arming.note} ${TOUCH ? 'Cancela sozinho em 8 segundos.' : 'Esc cancela.'}`
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
   ?? (['m-remove', 'm-down', 'menu'].includes(a ?? '') ? q(`[data-id="${id}"]:is([data-a="remove"], [data-a="down"])`) : null)
   ?? (['remove', 'cancel'].includes(a ?? '') ? q(`[data-id="${id}"][data-a="menu"]`) : null)
   ?? q(`[data-id="${id}"][data-a="logs"]`)
   ?? (id === 'dlg' ? $('#lb') : null)
   ?? (id.startsWith('stack-') ? q(`[data-id="${id}"][data-a="menu"]`) ?? groupLogs() : null)
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
  const near = (trs[i + 1] || trs[i - 1])?.dataset.key?.slice(2), since = new Date().toISOString();
  const done = run(a, c);
  $('#shown').textContent = `${VERB[a]} ${c.Names}`;
  if (!(await done)) { toast(`Não deu para ${LABEL[a].toLowerCase()} ${c.Names}. O erro ficou na linha.`); return load(); }
  if (!UP.includes(a)) {
    // pausado parece "ligado" na lista; o desfazer evita esquecer o container congelado
    // e o Parar oferece Iniciar de novo, como no lote e no projeto (pausado que parou fica de fora: iniciar não devolve a pausa)
    toast(`${c.Names} ${DONE[a]}.`, true, a === 'pause' ? ['Retomar', () => act('unpause', id)]
      : a === 'stop' && c.State !== 'paused' ? ['Iniciar de novo', () => act('start', id)] : null);
    await load();
    if (a === 'remove') (document.querySelector<HTMLElement>(`[data-id="${near}"][data-a="logs"]`) || $('#q')).focus();
    return;
  }
  toast(`${c.Names} ${DONE[a]}, conferindo se ficou de pé…`, true);
  // com os logs dele abertos: liga o ao vivo (o anterior caiu quando o container parou) e marca onde o novo log começa
  if ($<HTMLDialogElement>('#dlg').open && logId === id) { mark = {at: since, label: `${DONE[a]} às ${new Date().toLocaleTimeString('pt-BR')}`}; toggleFollow(true); }
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
// "cron e velho", "a, b e c" ou "a, b, c e mais 4": a confirmação diz o que vai apagar, não só quantos
const names = (cs: Container[], max = 3) => cs.length > max ? `${cs.slice(0, max).map(c => c.Names).join(', ')} e mais ${cs.length - max}`
  : cs.map(c => c.Names).join(', ').replace(/, ([^,]*)$/, ' e $1');

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
    if (!k || armed && a !== 'remove') return '';  // como no Parar tudo, só o que faz sentido; armado, só o Confirmar e o ×
    const cls = armed && a === 'remove' ? 'bg-danger text-white ring-danger hover:bg-danger-hover'
              : a === 'start' ? 'text-ok-fg hover:bg-ok/10' : a === 'remove' ? 'text-bad-fg hover:bg-bad/10' : 'text-fg hover:bg-hover';
    const aria = armed && a === 'remove' ? `Confirmar remoção de ${plural(k, 'container', 'containers')}` : `${text.replace('…', '')} ${plural(k, 'selecionado', 'selecionados')}`;
    return `<button data-id="bulk" data-a="${a}" ${bulkBusy ? 'aria-disabled="true"' : ''} aria-label="${aria}" title="${esc(bulkList(a, armed && a === 'remove' ? armedIds : undefined).map(c => c.Names).join(', '))}"
      onclick="bulkAct('${a}')" class="${BTN} ${cls}">${bulkBusy === a ? `${VERB[a]} (${k})` : armed && a === 'remove' ? `Apagar ${plural(k, 'container', 'containers')}` : `${text} (${k})`}</button>`;
  };
  const html = !n ? '' : `<p class="mr-auto text-sm font-medium text-fg-strong">${plural(n, 'selecionado', 'selecionados')}${
      hidden ? `<span class="font-normal text-muted"> · ${hidden} fora do filtro</span>` : ''}</p>
    <div class="flex flex-wrap gap-1.5">${BULK.map(btn).join('')}${armed ? cancelBtn('bulk', 'remoção em lote') : ''}
      ${armed ? '' : `<button data-id="bulk" data-a="clear" onclick="clearSel()" class="${BTN} text-muted hover:bg-hover">Limpar seleção</button>`}</div>
    ${armed ? armNote(`Apagar ${esc(names(data.filter(c => armedIds.includes(c.ID)), 10))} de vez? Os volumes ficam.`) : ''}`;
  $('#bulk').classList.toggle('hidden', !n);  // a altura dela vira --dock (ResizeObserver lá embaixo)
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
    const k = armedIds.length, name = names(data.filter(c => armedIds.includes(c.ID)));
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
    // o foco vai para o ×, o botão seguro: um segundo Enter cancela em vez de apagar (o Confirmar fica a um Tab)
    document.querySelector<HTMLElement>(`[data-id="${id}"][data-a="cancel"]`)?.focus();
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
  if (a === 'down' && !confirmed(`stack-${p}`, p, 'down', downNote(p))) return;
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

// o que o compose down leva, pelo nome (primeiro os da faixa de atenção: são os que você mais quer saber se vão junto). Depois dele o projeto some da lista (a pasta vinha dos labels dos containers),
// então o up para voltar é pelo terminal
const downNote = (p: string) =>
  `Remove ${names(data.filter(c => project(c) === p).sort((a, b) => +isProblem(b) - +isProblem(a)), 10)} e as redes do projeto. Os volumes ficam; para subir de novo, use compose up no terminal.`;

// "Reiniciar serviço" do menu "⋯": compose restart do serviço do container (o servidor confere o nome nos labels)
function restartService(id: string) {
  const c = data.find(c => c.ID === id);
  if (c) composeAct('restart', project(c), service(c));
}

// desarma sozinho depois de 8s, mas nunca enquanto o mouse ou o foco estão no Confirmar ou no × (WCAG 2.2.1).
// No toque não há hover e o foco fica parado no último botão tocado: lá vale o relógio, como o aviso promete
function armTick() {
  if (!arming) return;
  const els = [...document.querySelectorAll(`[data-id="${arming.id}"]:is([data-a="${arming.a}"], [data-a="cancel"])`)];
  if (!TOUCH && els.some(el => el.matches(':hover') || el === document.activeElement)) arming.timer = setTimeout(armTick, 1000);
  else { disarm(); toast('Confirmação cancelada: passaram 8 s sem o segundo clique. Nada foi apagado.', true); }
}

function disarm(redraw = true) {
  if (!arming) return;
  clearTimeout(arming.timer); arming = null;
  if (redraw) render();
}

document.addEventListener('keydown', e => {
  // Esc fecha o "⋯" aberto e devolve o foco a ele, sem fechar o modal em volta
  const open = e.key === 'Escape' && document.querySelector<HTMLDetailsElement>('details[data-keep="menu"][open]');
  if (open) { e.preventDefault(); closeMenus(); open.querySelector('summary')!.focus(); return; }
  if (e.key === 'Escape' && arming) return disarm();
  // qualquer modal aberto (terminal, novo container) fica com o teclado; o de logs tem o próprio atalho, logo abaixo
  if ([...document.querySelectorAll('dialog')].some(d => d.open && d.id !== 'dlg') || e.ctrlKey || e.metaKey || e.altKey) return;
  // checkbox da seleção não é digitação: com o foco nela os atalhos continuam valendo
  const el = document.activeElement as HTMLElement, typing = /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) && (el as HTMLInputElement).type !== 'checkbox';
  // nos logs, / vai para o filtro das linhas (o mesmo atalho da busca da lista). Ctrl+F fica com o navegador:
  // a busca dele já acha texto na caixa, e quem aperta Ctrl+F espera ela
  if ($<HTMLDialogElement>('#dlg').open) {
    if (e.key === '/' && !typing) { e.preventDefault(); $('#lf').focus(); }
    // r reinicia o container dos logs: o ciclo inteiro (reiniciar, ver o log novo) sem sair do modal
    if ((e.key === 'r' || e.key === 'R') && !typing && logId && data.find(c => c.ID === logId)?.State === 'running') act('restart', logId);
    return;
  }
  if (e.key === '/' && !typing) { e.preventDefault(); return $('#q').focus(); }
  if (e.key === '?' && !typing) return $('#hint').togglePopover();
  if ((e.key === 'z' || e.key === 'Z') && !typing && toastFn) return runToastAction();
  // x marca a linha em foco (junto com ↑↓ dá para selecionar sem mouse); a marca ou desmarca todos os visíveis
  const curId = el.closest?.<HTMLElement>('tr[data-row]')?.dataset.key?.slice(2);
  if ((e.key === 'x' || e.key === 'X') && !typing && curId) return toggleSel(curId);
  // r reinicia a linha em foco (com ↑↓ entre os Logs: muda o código, reinicia, olha os logs, sem mouse)
  if ((e.key === 'r' || e.key === 'R') && !typing && curId && data.find(c => c.ID === curId)?.State === 'running') return act('restart', curId);
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
  // uma linha para cada coisa: status, último healthcheck (inteiro no title) e uso, com rede e disco no fim (fora do celular)
  $('#dlg-status').innerHTML = `<span class="${t[1]}">${b ? VERB[b] : esc(st[0])}</span>${st[1] && !b ? `<span class="text-muted"> · ${st[1]}</span>` : ''}${b ? '' : errHtml(c)}${
    h ? `<div class="mt-1 text-xs text-muted lg:truncate" title="${esc(h)}"><span class="font-sans">Último healthcheck:</span> <span class="text-fg-soft">${esc(h)}</span></div>` : ''}${
    s && u ? `<div id="dlg-usage" class="mt-1 text-xs text-muted"><span class="whitespace-nowrap"><span class="text-fg-soft">${esc(u[0])}</span> ${spark(hs, 'cpu', 96, 20)}</span> <span class="whitespace-nowrap">· <span class="text-fg-soft">${esc(u[1])}</span> ${spark(hs, 'mem', 96, 20)}</span>${
      io(s).length ? `<span class="max-lg:hidden text-fg-soft" title="Totais desde que o container subiu">${io(s).map(x => ` <span class="whitespace-nowrap">· ${esc(x)}</span>`).join('')}</span>` : ''}</div>` : ''}`;
  // Reiniciar à vista e primeiro (é o ciclo: reiniciar e ver o log novo), depois a ação principal; o resto no "⋯"
  // (remover fica na lista, onde a confirmação aparece)
  const prim = PRIMARY[c.State], sec = SECONDARY[c.State];
  const more = [sec && sec !== 'restart' && [sec, LABEL[sec]], c.State === 'running' && ['exec', 'Copiar docker exec']].filter((x): x is [string, string] => !!x);
  $('#dlg-acts').innerHTML = (sec === 'restart' ? `<button data-id="dlg" data-a="restart" ${b ? 'aria-disabled="true"' : ''} aria-label="Reiniciar ${esc(c.Names)}" title="Reiniciar (r)"
      onclick="act('restart', '${c.ID}')" class="inline-flex items-center gap-1.5 ${BTN} text-fg hover:bg-hover">${RESTART_ICON}Reiniciar</button>` : '') + (prim ? `<button data-id="dlg" data-a="${prim}" ${b ? 'aria-disabled="true"' : ''} aria-label="${LABEL[prim]} ${esc(c.Names)}" onclick="act('${prim}', '${c.ID}')"
      class="${BTN} ${prim === 'start' ? 'text-ok-fg hover:bg-ok/10' : 'text-fg hover:bg-hover'}">${LABEL[prim]}</button>` : '')
    + (more.length ? menuBox('dlg', `Mais ações para ${esc(c.Names)} nos logs`, !!b, more.map(([a, text]) =>
      `<button data-id="dlg" data-a="m-${a}" ${b ? 'aria-disabled="true"' : ''} onclick="menuPick(this); ${a === 'exec' ? `copyExec('${c.ID}')` : `act('${a}', '${c.ID}')`}"
        class="${MENU_ITEM} text-fg">${text}</button>`).join('')) : '');
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

// põe text em el com os trechos que casam com re marcados; devolve quantos casaram
function markInto(el: HTMLElement, text: string, re: RegExp | null) {
  const parts = re ? text.split(re) : [text];
  parts.forEach((p, i) => {
    if (i % 2 === 0) return p && el.append(p);
    const m = document.createElement('mark');
    m.className = MARK; m.textContent = p; el.append(m);
  });
  return (parts.length - 1) / 2;
}

// logs do projeto: o prefixo do serviço ("api-1  | ") ganha uma cor por serviço, como no `docker compose logs`.
// Paleta própria (theme.css, --color-svc-*): com as cores de status, um serviço que caiu podia sair verde
const SVC_PREFIX = /^\S+\s+\|\s?/, SVC_TONES = ['text-svc-1', 'text-svc-2', 'text-svc-3', 'text-svc-4'];
// cor pela ordem em que o serviço aparece, como o compose: os 4 primeiros nunca repetem (um hash colide com 4 cores).
// Réplicas (api-1, api-2) ficam com a cor do serviço; openLogs zera a ordem
const svcSeen = new Map<string, string>();
const svcTone = (prefix: string) => {
  const svc = prefix.replace(/-\d+\s.*$/s, '');
  if (!svcSeen.has(svc)) svcSeen.set(svc, SVC_TONES[svcSeen.size % SVC_TONES.length]);
  return svcSeen.get(svc)!;
};

// cor da linha pelo nível (ERROR, WARN, DEBUG...); o resto fica na cor da caixa
const LEVEL_TONE = {bad: 'text-bad-fg', warn: 'text-warn-fg', dim: 'text-muted', '': ''};
const TS = /^\d{4}-\d\d-\d\dT\S+\s/;  // o --timestamps do docker logs

// a linha (com os trechos marcados, o prefixo do serviço colorido, o timestamp apagado e a cor do nível), ou null se o
// filtro não casou (aí nem entra na caixa). ponytail: um trecho que casa atravessando o prefixo ou o timestamp não conta
function hitNode(line: string, re: RegExp | null) {
  const pre = logProject ? line.match(SVC_PREFIX)?.[0] ?? '' : '', span = document.createElement('span');
  const rest = line.slice(pre.length), ts = rest.match(TS)?.[0] ?? '';
  let n = 0;
  const part = (text: string, cls: string) => {
    const p = document.createElement('span');
    if (!text) return p;
    p.className = cls; n += markInto(p, text, re); span.append(p);
    return p;
  };
  if (pre) part(pre, svcTone(pre));
  // o timestamp aparece como HH:MM:SS na hora local (a mesma da marca do reinício), desenhado pelo CSS (data-t); o texto
  // continua o do docker, para Copiar e Baixar levarem a linha inteira, e o valor UTC vai no title.
  // ponytail: o filtro conta o que casar no timestamp escondido
  const t = ts && new Date(ts.trim().replace(/(\.\d{3})\d+/, '$1'));
  if (t && !isNaN(+t)) {
    const el = part(ts.trimEnd(), 'text-[0px] text-muted before:content-[attr(data-t)] before:text-xs');
    el.dataset.t = t.toLocaleTimeString('pt-BR'); el.title = ts.trim();
    part(ts.slice(ts.trimEnd().length), '');
  } else part(ts, 'text-muted');
  const lv = LEVEL_TONE[logLevel(rest)];
  if (lv) part(rest.slice(ts.length), lv); else n += markInto(span, rest.slice(ts.length), re);
  if (re && !n) return null;
  if (re) { hits += n; hitLines++; }
  return span;
}
// até o teto do ao vivo, um nó por linha (para as cores); acima disso, texto cru, que pesa menos
const colored = () => buf.length <= 10000;

// marca "reiniciado às 18:31" antes da primeira linha depois do reinício (pelo timestamp do docker). O texto vem do CSS
// (data-mark): Copiar e Baixar levam só o log. marked = já foi posta nesta pintura (ou nesta conexão do ao vivo)
let mark: {at: string; label: string} | null = null, marked = false;
function markNode(line: string) {
  if (!mark || marked) return null;
  const ts = (logProject ? line.replace(SVC_PREFIX, '') : line).match(TS)?.[0].trim();
  if (!ts || ts < mark.at) return null;
  marked = true;
  const m = document.createElement('span');
  m.dataset.mark = `— ${mark.label} —`;
  m.setAttribute('role', 'separator'); m.setAttribute('aria-label', mark.label.replace(/^./, c => c.toUpperCase()));
  m.className = 'block my-1 border-t border-accent/50 font-sans text-[11px] text-accent-fg before:content-[attr(data-mark)]';
  return m;
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
  hits = hitLines = 0; marked = false;
  if (buf.length && (re || stream || colored())) {  // sem linhas, a caixa tem um aviso ("(sem logs)", erro): fica
    // num fragment, um a um: espalhar o log inteiro em argumentos (replaceChildren(...)) estoura a pilha
    const frag = document.createDocumentFragment();
    for (const l of buf) {
      const m = markNode(l), n = re || colored() ? hitNode(l, re) : l;
      if (m) frag.append(m);
      if (n) frag.append(n);
    }
    lb.replaceChildren(frag);
  } else if (buf.length) lb.textContent = buf.join('');
  renderHits();
  if (atEnd) lb.scrollTop = lb.scrollHeight;
}

// "Carregar mais": diz quanto vem. Sem mais o que pedir, aria-disabled (continua no Tab, como o Atualizar)
function renderMore() {
  const next = TAILS[tailAt + 1], b = $('#more');
  b.textContent = !next || complete ? 'Tudo carregado' : next === 'all' ? 'Carregar tudo' : `Carregar ${fmt(+next)} linhas`;
  b.toggleAttribute('data-done', !next || complete);  // com tudo na caixa, vira texto (page.html)
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

function openLogs(title: string, running: boolean) {
  tailAt = 0; buf = []; complete = false; svcSeen.clear(); mark = null;
  $('#lt').textContent = title;
  $<HTMLInputElement>('#lf').value = '';  // cada container (ou projeto) começa sem filtro
  $('#lb').textContent = 'Carregando…'; $('#lmeta').textContent = hist().replace(/^./, c => c.toUpperCase()); $('#dlg-msg').innerHTML = '';
  $('#insp').hidden = !!logProject;  // a configuração (inspect) é de um container só
  renderHits(); renderMore();
  $<HTMLDialogElement>('#dlg').showModal(); renderDlg(); fetchLogs();
  if (running && wantsFollow()) toggleFollow(true);  // quem deixou o ao vivo ligado da última vez
}

function logs(id: string) {
  logId = id; logProject = null;
  const c = data.find(c => c.ID === id)!;
  openLogs(c.Names, c.State === 'running');
}

// logs de todos os serviços do projeto no mesmo modal, com o prefixo do compose ("api-1  | ") em cada linha
function projectLogs(p: string) {
  const c = data.find(c => project(c) === p);
  if (!c) return;
  logId = null; logProject = {project: p, dir: workingDir(c)};
  openLogs(p, data.some(c => project(c) === p && c.State === 'running'));
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
  lb.append(...add.flatMap(l => [markNode(l), hitNode(l, re)]).filter(n => !!n));
  // o teto vale para as linhas carregadas; na tela, com filtro, só as que casaram têm nó (a marca do reinício sai junto)
  for (const l of buf.splice(0, Math.max(0, buf.length - Math.max(MAX_LINES, +TAILS[tailAt])))) {
    const n = re ? (l.split(re).length - 1) / 2 : 1;
    if (!n) continue;
    while ((lb.firstChild as HTMLElement | null)?.dataset?.mark) lb.firstChild!.remove();
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
      pending = []; buf = []; hits = hitLines = 0; marked = false; $('#lb').textContent = ''; renderHits();
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

// botão Ao vivo: a escolha fica para os próximos logs (deste navegador); o ao vivo que cai sozinho não muda a escolha
function followClick() {
  toggleFollow();
  try { localStorage.setItem('docker-gui-follow', stream ? '1' : ''); } catch { /* aba privada: vale só agora */ }
}
const wantsFollow = () => { try { return localStorage.getItem('docker-gui-follow') === '1'; } catch { return false; } };

// botão Atualizar: com o ao vivo ligado não faz nada (já atualiza sozinho)
function refreshLogs() {
  if (!stream) fetchLogs();
}

function copyLogs() {
  navigator.clipboard.writeText($('#lb').textContent ?? '').then(() => toast('Logs copiados.', true), () => toast('Não consegui copiar.'));
}

function inspectHtml(d: Inspect, reveal: boolean) {
  const list = (xs: string[], none = 'nenhum') => xs.length ? xs.map(x => `<div>${x}</div>`).join('') : `<span class="font-sans text-muted">${none}</span>`;
  const nets = Object.entries(d.Networks).map(([n, ip]) => esc(ip ? `${n} · ${ip}` : n));
  const mounts = d.Mounts.map(m => esc(`${[m.Type, m.Name || m.Source].filter(Boolean).join(' ')} → ${m.Destination}${m.RW ? '' : ' (somente leitura)'}`));
  const env = d.Env.map(([k, v]) => `${esc(k)}=${v === null ? '<span aria-hidden="true">••••••</span><span class="sr-only">(oculto)</span>' : esc(v)}`);
  const dt = 'font-sans text-muted';
  return `<dl class="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 font-mono text-fg-soft [overflow-wrap:anywhere]">
    <dt class="${dt}">Restart</dt><dd>${esc(d.Restart)}</dd>
    <dt class="${dt}">Redes</dt><dd>${list(nets, 'nenhuma')}</dd>
    <dt class="${dt}">Mounts</dt><dd>${list(mounts)}</dd>
    <dt class="${dt}">Env</dt><dd>${list(env, 'nenhuma')}${d.Env.length ? `<button id="insp-env" onclick="loadInspect(${!reveal})"
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
// parado se remove na lista. Volumes sem -a no servidor: o aviso deles sai da lista de volumes (volumeNote)
const DISK: [string, DiskKind, string, string, string][] = [
  ['Images', 'images', 'Imagens', 'as imagens que nenhum container usa', 'Dá para baixar de novo.'],
  ['Local Volumes', 'volumes', 'Volumes', 'os volumes que nenhum container usa', 'Os dados deles se perdem.'],
  ['Build Cache', 'buildcache', 'Build cache', 'o cache de build', 'O próximo build fica mais lento.']];
let disk: DiskUsage[] | string | null = null, diskBusy: DiskKind | '' = '', diskHtml = '';  // string = erro
const PODMAN = /^podman\b/.test(document.documentElement.dataset.cli ?? '');
// o volume prune diz exatamente o que leva, pela lista de volumes (no Docker só os anônimos, no Podman os nomeados também)
function volumeNote(): string {
  const vs = objs.volumes;
  if (!Array.isArray(vs)) return vs === null ? 'Conferindo quais volumes saem…' : 'Não consegui ler a lista de volumes; o prune leva os sem uso.';
  const out = prunedVolumes(vs as Volume[], PODMAN), shown = out.slice(0, 10).map(v => anonVolume(v.Name) ? v.Name.slice(0, 12) + '…' : v.Name);
  return !out.length ? 'Nenhum volume sem uso para apagar.'
    : `Vai apagar ${plural(out.length, PODMAN ? 'volume sem uso' : 'volume anônimo sem uso', PODMAN ? 'volumes sem uso' : 'volumes anônimos sem uso')}: ${
      shown.join(', ')}${out.length > 10 ? ` e mais ${out.length - 10}` : ''}. Os dados deles se perdem.${PODMAN ? '' : ' Os nomeados ficam.'}`;
}
// quanto o prune libera e de quantos itens (do df), antes do que ele não desfaz
const pruneNote = (d: DiskUsage | undefined, note: string) => {
  const idle = d ? +d.TotalCount - +d.Active : 0;
  if (d?.Type === 'Local Volumes') return volumeNote();
  return d ? `Libera até ${d.Reclaimable.split(' ')[0]}${idle > 0 ? `, de ${plural(idle, 'item sem uso', 'itens sem uso')}` : ''}. ${note}` : note;
};

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
      const cls = armed ? 'bg-danger text-white ring-danger hover:bg-danger-hover' : 'text-fg hover:bg-hover', share = reclaimShare(d);
      // a barra é o total; a parte em ciano, na ponta, é o que a limpeza libera
      const bar = share === null ? '' : `<div aria-hidden="true" class="mt-1.5 h-1.5 w-full max-w-80 rounded-sm bg-line-strong overflow-hidden flex justify-end">
          <span class="h-full bg-accent" style="width:${Math.round(share * 100)}%"></span></div>`;
      return `<div class="flex flex-wrap items-center gap-x-3 gap-y-2 py-3 border-t border-line/70">
        <div class="mr-auto min-w-0 flex-1"><div class="font-medium text-fg-strong">${label}</div>
          <div class="font-mono text-xs text-muted">${esc(d.Size)} no total · ${esc(d.Reclaimable)} liberável · ${esc(d.TotalCount)} ${d.TotalCount === '1' ? 'item' : 'itens'}, ${esc(d.Active)} em uso</div>${bar}</div>
        <button data-id="${id}" data-a="prune" ${diskBusy ? 'aria-disabled="true"' : ''} onclick="prune('${k}')"
          aria-label="${armed ? `Confirmar limpeza de ${label.toLowerCase()}` : `Limpar ${label.toLowerCase()}`}" class="${BTN} ${cls}">${
          diskBusy === k ? 'Limpando…' : armed ? `Limpar ${label.toLowerCase()}` : 'Limpar…'}</button>${armed ? cancelBtn(id, `limpeza de ${label.toLowerCase()}`) : ''}
        ${armed ? armNote(`Apagar ${what}? ${esc(pruneNote(d, note))}`) : ''}
      </div>`;
    }).join('');
  if (html !== diskHtml) $('#df').innerHTML = diskHtml = html;  // o render roda a cada poll: só troca se mudou
}

async function prune(k: DiskKind) {
  const [type, , label, what, note] = DISK.find(d => d[1] === k)!, d = Array.isArray(disk) ? disk.find(d => d.Type === type) : undefined;
  if (k === 'volumes' && !Array.isArray(objs.volumes)) loadObjects('volumes');  // o aviso diz quais saem
  if (diskBusy || !confirmed('df-' + k, what, 'prune', pruneNote(d, note))) return;
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
const anon = anonVolume;
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
      class="${BTN} ${cls}">${objBusy === id ? 'Removendo…' : armed ? 'Apagar' : 'Remover…'}</button>${armed ? cancelBtn(id, `remoção de ${esc(what)}`) : ''}` : ''}
    ${armed ? armNote(`Apagar ${esc(what)}? ${OBJ[k][5]}`) : ''}
    ${err ? `<div class="w-full text-xs text-bad-fg">${hint ? `<p>${hint}</p>` : ''}
      <pre class="mt-1 whitespace-pre-wrap [overflow-wrap:anywhere] font-mono text-bad-soft">${esc(err)}</pre></div>` : ''}</li>`;
}

// quantos o docker system df conta na categoria (redes não entram no df)
const dfCount = (k: ObjKind) => Array.isArray(disk) ? +(disk.find(d => d.Type === {images: 'Images', volumes: 'Local Volumes', networks: ''}[k])?.TotalCount ?? 0) : 0;

function renderObjects() {
  for (const k of KINDS) {
    const v = objs[k];
    const html = v === null ? '<p class="py-3 text-muted">Carregando…</p>'
      : typeof v === 'string' ? `<p class="py-3 text-bad-fg">${esc(v)}</p>`
      : !v.length ? `<p class="py-3 text-muted">${OBJ[k][6]}${dfCount(k) ? ` O uso de disco conta ${dfCount(k)}: feche e abra a lista para ler de novo.` : ''}</p>`
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
  act, afterClose, askNotify, bulkAct, clearFilters, clearSel, composeAct, copyAddr, copyExec, copyLogs, disarm, downloadLogs,
  filterBy, followClick, loadDisk, loadHealth, loadInspect, loadMore, loadObjects, menuPick, openCreate, openShell, placeMenu, projectLogs,
  prune, refreshLogs, restartService, rmObj, runToastAction, selectAll, stackAct, toggleSel,
});

$('#dlg').addEventListener('close', afterClose);
$('#shell').addEventListener('close', closeShell);
$('#shell').addEventListener('cancel', e => e.preventDefault());
// a barra de lote flutua embaixo: o toast sobe acima dela e a página ganha a mesma folga, para a última linha não ficar atrás
new ResizeObserver(() => document.documentElement.style.setProperty('--dock', `${$('#bulk').offsetHeight && $('#bulk').offsetHeight + 8}px`))
  .observe($('#bulk'));  // Esc é do vim/less, não do modal
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
