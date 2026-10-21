import {
  type Bucket, type Container, type ContainerState, type DiskUsage, type Facts, type HistoryEvent, type Image, type LogLevel,
  type Network, type Port, type RunErrors, type RunField, type Sample, type Stats, type Tone, type Volume, HISTORY, age, anonVolume,
  bucket, bulkSummary, bytes, continues, errHint, esc, eventText, fmtBytes, hasHealth, healthChanges, historySummary, io, isProblem,
  logFilter, logLevel, logServices, newProblems, percent, ports, project, prunedVolumes, pushSample, reclaimShare, runSpec, service, shortImage,
  sparkPoints, status, tone, topTable, trend, usage, workingDir,
} from './format';
import {LOCALE, t, translatePage} from './i18n';
import {T} from '#transport';
import type {Closer, Term} from './transport';
import {Terminal} from '@xterm/xterm';
import {FitAddon} from '@xterm/addon-fit';
import XTERM_CSS from '@xterm/xterm/css/xterm.css';  // string (build.py usa --loader:.css=text): nada de CDN

// a página é estática: todo seletor usado aqui existe no page.html
const $ = <T extends HTMLElement = HTMLElement>(s: string): T => document.querySelector(s) as T;

// leitura simples (GET): o resto passa por T.request com o método e o corpo
const api = (path: string) => T.request('GET', path);

type Action = 'start' | 'stop' | 'restart' | 'pause' | 'unpause' | 'remove';
type RowAction = Action | 'logs';
type MenuAction = Action | 'exec' | 'shell' | 'srestart' | 'sbuild' | 'noremove';
type ProblemKind = 'docker' | 'perm' | 'server' | 'auth';
// [título, dica (HTML confiável), detalhe técnico, tipo]
type Problem = [title: string, hint: string, detail: unknown, kind: ProblemKind];
type ToastAction = [label: string, fn: () => unknown];
type RowError = {msg: string; state: ContainerState; what: string};
// rebuild = up --build do projeto; restart, build (up --build --no-deps) e svcup (up de um serviço sem container) são por
// serviço (o resto vale para o projeto inteiro)
type ComposeAction = 'up' | 'rebuild' | 'down' | 'pull' | 'restart' | 'build' | 'svcup';
// confirmação em 2 passos pendente: remover um container (ou os selecionados, id = "bulk"), derrubar um projeto
// (id = "stack-<projeto>"), limpar uma categoria do disco ou remover uma imagem, volume ou rede; a é o data-a do
// botão e note vai para o leitor de tela
type Arming = {id: string; name: string; a: 'remove' | 'down' | 'prune' | 'rm'; note: string; run: () => unknown; at: number; timer: number};
// saída do compose de um projeto, enquanto roda (code null) e, se falhou, até fechar (code -1: o stream caiu no meio)
type Out = {what: string; text: string; code: number | null};
type Health = {Log?: {ExitCode: number; Output: string}[]} | null;
// resumo do /api/inspect; o valor do env vem null (mascarado) até o usuário pedir para revelar
type Inspect = {Restart: string; Networks: Record<string, string>; Env: [key: string, value: string | null][];
                Mounts: {Type: string; Name: string; Source: string; Destination: string; RW: boolean}[]};
// linha da tabela com o HTML que a gerou, para o patchRows saber se mudou
type Row = HTMLElement & {_html?: string};

// o HTML estático vem em pt-BR: em inglês, troca antes de qualquer coisa ler ou desenhar a página
translatePage();
const LABEL: Record<RowAction, string> = {start: t`Iniciar`, stop: t`Parar`, restart: t`Reiniciar`, pause: t`Pausar`, unpause: t`Retomar`, logs: t`Logs`, remove: t`Remover`};
const VERB: Record<Action, string> = {start: t`Iniciando…`, stop: t`Parando…`, restart: t`Reiniciando…`, pause: t`Pausando…`, unpause: t`Retomando…`, remove: t`Removendo…`};
const DONE: Record<Action, string> = {start: t`iniciado`, stop: t`parado`, restart: t`reiniciado`, pause: t`pausado`, unpause: t`retomado`, remove: t`removido`};
const COMPOSE_VERB: Record<ComposeAction, string> = {up: t`Subindo…`, rebuild: t`Reconstruindo…`, down: t`Derrubando…`, pull: t`Baixando…`, restart: t`Reiniciando…`, build: t`Reconstruindo…`,
                                                     svcup: t`Subindo…`};
const COMPOSE_CMD: Record<ComposeAction, string> = {up: 'compose up', rebuild: 'compose up --build', down: 'compose down', pull: 'compose pull', restart: 'compose restart',
                                                    build: 'compose up --build --no-deps', svcup: 'compose up'};
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
  ['problema', t`com problema`, t`com problema`, 'text-bad-fg'], ['rodando', t`rodando bem`, t`rodando bem`, 'text-fg'],
  ['pausado', t`pausado`, t`pausados`, 'text-fg'], ['reiniciando', t`reiniciando`, t`reiniciando`, 'text-fg'],
  ['parado', t`parado`, t`parados`, 'text-fg']];
const TOUCH = matchMedia('(pointer: coarse)').matches;
// a partir de 1280px (xl) a tabela tem as 5 colunas do docker ps; abaixo, imagem e portas descem para baixo do nome.
// Decidido aqui, não por CSS: com as duas cópias no DOM, o leitor de tela e o Tab achariam cada porta duas vezes
const WIDE = matchMedia('(min-width: 80rem)');
const PROBLEM_TXT: Record<ProblemKind, string> = {docker: t`Docker fora do ar`, perm: t`sem acesso ao Docker`, server: t`sem conexão`, auth: t`sem token`};
// Logs é a ação mais usada e a mais inofensiva: sem contorno, para a principal (Parar, Iniciar) ser a que salta aos olhos
const ghost = () => BTN.replace(' ring-1 ring-line-strong/80', '');
const BTN = 'px-2.5 py-1 coarse:min-h-11 coarse:px-4 coarse:text-sm rounded text-xs font-medium ring-1 ring-line-strong/80 transition-[background-color] motion-reduce:transition-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent aria-disabled:opacity-40 aria-disabled:cursor-wait';
let data: Container[] = [], busy = new Map<string, Action>(), composing = new Map<string, ComposeAction>(), errors = new Map<string, RowError>(), lastOk: Date | null = null,
    problem = '', problemKind: ProblemKind | '' = '', only: Bucket | '' = '',
    toastTimer: number | undefined, logId: string | null = null, stream: Closer | null = null, pending: string[] = [],
    arming: Arming | null = null, lastSay = '', dirty = false, seen: Set<string> | null = null,
    // modal de logs com o projeto compose inteiro (logId fica null); a pasta vai junto para o servidor conferir
    logProject: {project: string; dir: string} | null = null;
// seleção para as ações em lote: IDs, não nós do DOM, então sobrevive ao redesenho; visible = IDs na tela agora
// (filtros e busca aplicados); armedIds = o que o Remover em lote armou, para o Confirmar não apagar nada além disso
let sel = new Set<string>(), visible: string[] = [], bulkBusy: Action | '' = '', bulkHtml = '', armedIds: string[] = [],
    lastSel = t`Nenhum container selecionado`;
const CHECK = 'size-4 coarse:size-6 shrink-0 accent-accent cursor-pointer focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent';

let toastFn: (() => unknown) | null = null;
function toast(msg: string, ok = false, action: ToastAction | null = null) {
  toastFn = action?.[1] || null;
  // superfície sólida: translúcido, o texto disputava com a linha que estivesse embaixo
  const html = `<div class="flex items-center gap-3 rounded-lg bg-raised ring-1 shadow-lg shadow-black/30 text-sm px-4 py-3 ${ok
    ? 'ring-ok/50 text-ok-soft'
    : 'ring-bad/50 text-bad-soft'}"><span>${REMOTE ? `<span class="font-semibold text-warn-fg">${esc(CTX)}</span> · ` : ''}${esc(msg)}</span>${action ? `<button onclick="runToastAction()"
      class="shrink-0 font-medium underline underline-offset-4 hover:text-fg-strong focus-visible:outline-2 focus-visible:outline-accent rounded">${esc(action[0])}</button>
      <kbd class="shrink-0 font-mono text-xs px-1 rounded ring-1 ring-current opacity-70" title="${t`Atalho`}">Z</kbd>` : ''}</div>`;
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
    <details class="mt-2 text-xs text-warn-soft"><summary class="cursor-pointer w-fit py-1 coarse:py-3.5 rounded focus-visible:outline-2 focus-visible:outline-accent">${t`Detalhes técnicos`}</summary>
    <pre class="mt-1 whitespace-pre-wrap [overflow-wrap:anywhere] font-mono">${esc(p[2])}</pre></details>`;
  renderCount();
  if (!lastOk) render();
}

const code = (s: string) => `<code class="font-mono">${s}</code>`;
async function load() {
  lastLoad = Date.now();
  try {
    const r = await api('/api/containers'), j: unknown = await r.json();
    if (r.status === 401) return showProblem([t`Esta aba não tem o token do Stivo.`,
      t`Abra o link com ${code('#t=…')} que aparece no terminal onde você rodou ${code('python3 docker_gui.py')}. O token muda a cada execução.`, j, 'auth']);
    if (!r.ok) return showProblem(/permission denied/i.test(String(j))
      ? [t`Seu usuário não tem acesso ao Docker.`, t`Rode ${code('sudo usermod -aG docker $USER')} e entre de novo na sessão.`, j, 'perm']
      : [t`Não consegui falar com o Docker.`, t`O daemon está rodando? Verifique com ${code('systemctl status docker')}.`, j, 'docker']);
    const first = !lastOk;
    lastOk = new Date();
    // só redesenha se mudou (ou na 1ª carga, senão a lista vazia nunca aparece)
    if (first || JSON.stringify(j) !== JSON.stringify(data)) {
      data = j as Container[];
      // a última linha e o inspect de uma queda valem enquanto ela dura: subiu, a próxima queda (mesmo código) lê de novo
      for (const k of Object.keys(tails)) if (!data.some(c => fell(c) && tailKey(c) === k)) { delete tails[k]; delete facts[k]; }
      // container que sumiu (removido, recriado pelo compose com outro ID) sai da seleção
      for (const id of sel) if (!data.some(c => c.ID === id)) sel.delete(id);
      if (selectingRows()) dirty = true; else render();
    }
    notify(newProblems(seen, data));
    seen = new Set(data.filter(isProblem).map(c => c.ID));
    showProblem(null);
  } catch (e) {
    showProblem([lastOk ? t`O servidor do Stivo parou de responder.` : t`Não consegui conectar ao servidor do Stivo.`,
      t`Rode ${code('python3 docker_gui.py')} de novo; a página volta sozinha.`, (e as Error).message, 'server']);
  }
}

// lista ao vivo: com o stream de eventos do docker conectado, cada leva de eventos refaz a consulta e o poll vira
// rede de segurança (o docker não avisa a passagem do tempo: "Up 5 minutes" -> "Up 6 minutes"). Sem o stream
// (recusado, caiu, podman sem events), poll de 2 s
const POLL = 2000, POLL_LIVE = 30000, COALESCE = 200;
let events: Closer | null = null, live = false, lastLoad = 0, evTimer: number | undefined, evRetry: number | undefined,
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
  // desiste por um tempo e volta ao poll de 2 s (que mostra o erro, se houver); "end" é o docker events que
  // terminou (daemon fora do ar, podman sem events...)
  const drop = () => { closeEvents(); evRetry = setTimeout(connectEvents, POLL_LIVE); };
  events = T.stream('/api/events/stream', {}, {
    open: () => { live = true; showLive(); refresh(); },  // o que mudou antes de o docker events começar a ouvir
    // uma rajada (compose up: create, start... de cada serviço) vira uma consulta só, no máximo COALESCE ms depois
    data: () => {
      if (watching() && evTimer === undefined) evTimer = setTimeout(() => { evTimer = undefined; refresh(); }, COALESCE);
    },
    end: drop,
    // queda: reconecta sozinho, com o poll de 2 s enquanto isso; closed é recusa (token, limite, erro)
    error: closed => { live = false; showLive(); if (closed) drop(); },
  });
}
function closeEvents() { events?.close(); events = null; live = false; showLive(); }
// no cabeçalho: a lista vem dos eventos do docker (muda na hora) ou do poll de 2 s (o docker events caiu ou não existe)
function showLive() {
  $('#live').innerHTML = live ? `<span aria-hidden="true" class="inline-block size-1.5 mr-1.5 align-middle rounded-full bg-ok"></span>${t`ao vivo`}`
    : `<span aria-hidden="true" class="inline-block size-1.5 mr-1.5 align-middle rounded-full ring-1 ring-dim"></span>${t`a cada 2 s`}`;
  $('#live').title = live ? t`A lista muda assim que o docker avisa (docker events)` : t`Sem o docker events: a lista é relida a cada 2 s`;
}

// notificação do sistema só por pedido explícito (botão no cabeçalho) e só para quem acabou de entrar na faixa
// de atenção; com a página em foco ela não aparece, a lista e o favicon já mostram
const canAsk = () => !T.desktop && isSecureContext && 'Notification' in window && Notification.permission === 'default';
// no desktop a notificação é do sistema, sem pedir permissão (PRD RF2.4)
const notifying = () => T.desktop || ('Notification' in window && Notification.permission === 'granted');
async function askNotify() {
  const ok = await Notification.requestPermission() === 'granted';
  $('#notify').hidden = !canAsk();
  toast(ok ? t`Pronto: aviso quando um container entrar na faixa de atenção, mesmo com a aba em segundo plano.`
           : t`Sem permissão para notificar. Dá para liberar nas configurações do site, no navegador.`, ok);
}
function notify(cs: Container[]) {
  if (!cs.length || !notifying() || (!document.hidden && document.hasFocus())) return;
  T.notify(cs.length === 1 ? t`${cs[0].Names} precisa de atenção` : t`${cs.length} containers precisam de atenção`,
    cs.length === 1 ? status(cs[0])[0] : cs.map(c => c.Names).join(', '), () => focus());
}

// favicon: o prompt (>_) no ciano do acento, com a contagem da faixa de atenção por cima ("!" quando os dados estão velhos)
function setIcon(badge: string) {
  T.attention(badge, `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none"><rect x="1" y="2.5" width="22" height="19" rx="3" fill="#141a22"/><path d="M5.5 8.5 9.5 12l-4 3.5M11.5 16h6" stroke="#3fd0dc" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>${badge
    ? `<circle cx="16.5" cy="16.5" r="7.5" fill="#dc2626" stroke="none"/><text x="16.5" y="20" text-anchor="middle" font-family="sans-serif" font-size="10" font-weight="700" fill="#fff" stroke="none">${badge}</text>` : ''}</svg>`);
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

// sparkline em SVG inline, sem animação e sem linha de base: a série ocupa a largura toda (estica até a janela de
// HISTORY leituras encher). Para leitor de tela e no hover, um texto com mín, máx e o valor atual. O CPU tem piso de 10% na escala: 0,8% fica baixo e 80% no topo (com 1%, qualquer carga enchia a altura)
const CPU_FMT = (n: number) => `${n.toFixed(2)}%`;
function spark(h: Sample[], k: 'cpu' | 'mem', w = 48, ht = 14) {
  if (h.length < 2) return '';
  const vs = h.map(s => s[k]), label = esc(trend(k === 'cpu' ? 'CPU' : t`Memória`, vs, h.at(-1)!.t - h[0].t, k === 'cpu' ? CPU_FMT : fmtBytes));
  return `<span role="img" data-spark="${k}" aria-label="${label}" title="${label}" class="inline-block align-middle -mt-0.5 mr-0.5"><svg aria-hidden="true"
    viewBox="0 0 ${w} ${ht}" width="${w}" height="${ht}" fill="none" stroke-linecap="round" stroke-linejoin="round">
    <polyline points="${sparkPoints(vs, w, ht, HISTORY, k === 'cpu' ? 10 : 0)}" stroke-width="1.5" class="stroke-accent"/></svg></span>`;
}

// onde a página age (docker_gui.py, where()): "docker · producao". Remoto fica em âmbar, com o endereço para o leitor de
// tela e no title; o contexto também vai para o título da aba, menos o default, que é o caso comum
const WHERE = document.documentElement.dataset, REMOTE = 'remote' in WHERE, CTX = WHERE.where?.split(' · ')[1] ?? '';
$('#where').innerHTML = WHERE.where ? `${esc(WHERE.where)}${REMOTE ? `<span class="sr-only">${t`, daemon remoto em ${esc(WHERE.host!)}`}</span>` : ''}` : '';
$('#where').title = WHERE.host ? t`Daemon em ${WHERE.host}` : '';
if (REMOTE) {
  $('#where').classList.replace('text-muted', 'text-warn-fg');
  $('#where').classList.replace('ring-line-strong', 'ring-warn/60');
}
const TITLE = CTX && CTX !== 'default' ? `Stivo · ${CTX}` : 'Stivo';
// endereço das portas: localhost, ou o host do daemon remoto (tcp://10.0.0.5:2376, ssh://eu@servidor -> 10.0.0.5, servidor)
const PORT_HOST = (() => { try { return REMOTE && new URL(WHERE.host!).hostname || 'localhost'; } catch { return 'localhost'; } })();
// remoto: a faixa âmbar fica no topo o tempo todo, e o "só esta máquina" do Novo container passa a ser a de lá
if (REMOTE) {
  $('#remote').hidden = false;
  $('#remote').innerHTML = t`Daemon remoto ${`<strong class="font-semibold">${esc(CTX)}</strong>`} ${`<span class="font-mono text-xs">(${esc(WHERE.host!)})</span>`}: tudo o que você fizer aqui vale lá.`;
  $('#run-ports-hint').innerHTML = t`portaDoHost:portaDoContainer, separadas por vírgula ou espaço. Ficam em ${code('127.0.0.1')} do daemon remoto ${esc(CTX)}: só aquela máquina acessa, não esta.`;
}

function renderCount() {
  const n = (k: Bucket) => data.filter(c => bucket(c) === k).length;
  const problemTxt = problemKind ? PROBLEM_TXT[problemKind] : '';
  // o favicon conta a faixa de atenção (a queda já vista sai dela); o título usa as mesmas palavras das contagens
  const band = data.filter(inBand).length;
  setIcon(problem ? '!' : band > 9 ? '9+' : String(band || ''));
  document.title = !lastOk && !problem ? TITLE : !problem ? `${TITLE} · ${t`${n('rodando')} rodando bem`}${n('problema') ? ` · ${t`${n('problema')} com problema`}` : ''}`
    : `${TITLE} · ${problemTxt}`;
  $('#obj-containers-n').textContent = lastOk ? ` · ${data.length}` : '';
  if (problem) {
    const at = lastOk?.toLocaleTimeString(LOCALE, {hour: '2-digit', minute: '2-digit'});
    $('#count').textContent = lastOk ? t`Desatualizado · dados de ${at}` : problemTxt[0].toUpperCase() + problemTxt.slice(1);
    return;
  }
  const pill = 'shrink-0 whitespace-nowrap rounded px-2 py-0.5 coarse:py-3 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent';
  // um controle segmentado (é um filtro, não um selo); no celular ele rola de lado em vez de quebrar em duas linhas
  const segs = BUCKETS.filter(([k]) => n(k) || only === k).map(([k, one, many, color]) =>
    `<button data-id="count-${k}" data-a="filter" aria-pressed="${only === k}" onclick="filterBy('${k}')"
      class="${pill} rounded-none font-mono text-data hover:bg-hover aria-pressed:bg-fg-strong aria-pressed:text-canvas ${color}"><span class="font-semibold tabular-nums">${n(k)}</span> ${n(k) === 1 ? one : many}</button>`).join('');
  $('#count').innerHTML = (segs ? `<span class="flex max-sm:max-w-full max-sm:overflow-x-auto [scrollbar-width:none] rounded ring-1 ring-line divide-x divide-line">${segs}</span>`
    : `<span>${t`0 containers`}</span>`) + (only || $<HTMLInputElement>('#q').value.trim()
    ? `<button data-id="count-clear" data-a="filter" onclick="clearFilters()" class="${pill} text-accent-fg underline underline-offset-4 hover:text-accent-soft">${t`Limpar filtros`}</button>` : '');
}

function filterBy(k: Bucket) { only = only === k ? '' : k; render(); }
function clearFilters() { only = ''; $<HTMLInputElement>('#q').value = ''; render(); $('#q').focus(); }

// aba e filtros vivem na URL (#aba=volumes, #estado=problema&q=redis): sobrevivem ao recarregar e dá para salvar o link
type Tab = 'containers' | ObjKind;
const TAB_URL: Record<Tab, string> = {containers: '', images: 'imagens', volumes: 'volumes', networks: 'redes'};
let tab: Tab = 'containers';
function hashUrl() {
  const h = new URLSearchParams(), q = $<HTMLInputElement>('#q').value.trim();
  if (tab !== 'containers') h.set('aba', TAB_URL[tab]);
  if (only) h.set('estado', only);
  if (q) h.set('q', q);
  return h.size ? '#' + h : location.pathname;
}
function saveHash() { history.replaceState(null, '', hashUrl()); }
function readHash() {
  const h = new URLSearchParams(location.hash.slice(1));
  tab = (Object.keys(TAB_URL) as Tab[]).find(k => k !== 'containers' && TAB_URL[k] === h.get('aba')) || 'containers';
  only = BUCKETS.find(([k]) => k === h.get('estado'))?.[0] || '';
  $<HTMLInputElement>('#q').value = h.get('q') || '';
}

// trocar de aba entra no histórico (o voltar do navegador volta de aba); filtros, não
function pickTab(t: Tab, focus = false) {
  if (t !== tab) {
    disarm(false);  // confirmação armada não sobrevive fora da vista
    tab = t;
    history.pushState(null, '', hashUrl());
    showTab();
  }
  if (focus) $('#tab-' + t).focus();
}
function showTab() {
  for (const b of document.querySelectorAll<HTMLElement>('[role="tab"]')) {
    const on = b.id === 'tab-' + tab;
    b.setAttribute('aria-selected', String(on));
    b.tabIndex = on ? 0 : -1;
    $('#' + b.getAttribute('aria-controls')).hidden = !on;
  }
  render();
  loadTab();
}
// setas, Home e End andam entre as abas e já ativam (padrão do ARIA para abas que abrem rápido)
function tabKey(e: KeyboardEvent) {
  const all = Object.keys(TAB_URL) as Tab[], i = all.indexOf(tab);
  const j = {ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: all.length - 1}[e.key];
  if (j === undefined) return;
  e.preventDefault();
  pickTab(all[(j + all.length) % all.length], true);
}

function copyAddr(h: string) {
  const a = `${PORT_HOST}:${h}`;
  navigator.clipboard.writeText(a).then(() => toast(t`Copiado: ${a}`, true), () => toast(t`Não consegui copiar.`));
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
  const base = 'whitespace-nowrap font-mono text-xs px-1 py-0.5 coarse:px-2 coarse:py-3.5 rounded underline-offset-4 focus-visible:outline-2 focus-visible:outline-accent';
  // faixa longa: não há um endereço para abrir ou copiar, então o chip só informa
  if (!reachable(c, h)) return `<span title="${t`Só no loopback do daemon remoto ${esc(CTX)}: não abre daqui`}"
    class="${base} text-muted">${label}</span>`;
  if (h.includes('-')) return `<span title="${t`Faixa de portas: ${h} do host → ${p} do container`}"
    class="${base} text-muted">${label}</span>`;
  return c.State === 'running' && proto === 'tcp' && !NOT_HTTP.has(+p)
    ? `<a href="http://${PORT_HOST}:${h}" target="_blank" rel="noopener" aria-label="${t`Abrir ${PORT_HOST}:${h} em nova aba (porta ${p} do container)`}"
        title="${t`Abrir no navegador`}" class="${base} text-accent-fg hover:underline hover:bg-accent/10">${label}<svg ${svg}><path d="M6 3h7v7M13 3 4 12"/></svg></a>`
    : `<button onclick="copyAddr('${h}')" aria-label="${t`Copiar ${PORT_HOST}:${h} (porta ${p}/${proto} do container)`}" title="${t`Copiar ${PORT_HOST}:${h}`}"
        class="${base} text-fg-soft hover:text-fg-strong hover:underline hover:bg-hover">${label}<svg ${svg}><rect x="5.5" y="5.5" width="7.5" height="7.5" rx="1.5"/><path d="M3 10.5V4a1 1 0 0 1 1-1h6.5"/></svg></button>`;
}

// erro da última ação fica na linha até a próxima ação ou até o estado do container mudar
function errHtml(c: Container) {
  const e = errors.get(c.ID);
  if (!e) return '';
  if (e.state !== c.State) { errors.delete(c.ID); return ''; }
  const hint = errHint(e.msg);  // a causa traduzida fica à vista; o erro do docker, no "ver erro"
  return `<details data-keep="err" class="mt-1 text-xs text-bad-fg"><summary class="cursor-pointer w-fit py-1 coarse:py-3.5 rounded focus-visible:outline-2 focus-visible:outline-accent">${t`Falhou ao ${e.what.toLowerCase()} · ver erro`}</summary>
    <pre class="mt-1 whitespace-pre-wrap [overflow-wrap:anywhere] font-mono text-bad-soft">${esc(e.msg)}</pre></details>${
    hint ? `<p class="[contain:inline-size] font-sans text-xs text-bad-soft">${esc(hint)}</p>` : ''}`;
}

const health: Record<string, string> = {};  // ID+Status -> texto do último probe (o cache vence quando o Status muda)

async function loadHealth(id: string) {
  const c = data.find(c => c.ID === id);
  if (!c || health[id + c.Status]) return;
  let txt: string;
  try {
    const r = await api('/api/health/' + id), h: unknown = await r.json(), last = r.ok ? (h as Health)?.Log?.at(-1) : undefined;
    txt = !r.ok ? t`Não consegui ler o healthcheck: ${h}`
        : last ? t`código ${last.ExitCode} · ${last.Output.trim() || t`(sem saída)`}` : t`Nenhum probe rodou ainda.`;
  } catch { txt = t`Não consegui ler o healthcheck.`; }
  health[id + c.Status] = txt;
  render();
}

// última linha do log de quem caiu (saiu com erro ou está em loop): o motivo costuma estar ali, sem abrir o modal.
// Uma consulta por queda (estado + código de saída), não por poll: o "há 10 min" do Status muda sozinho
const tails: Record<string, string> = {};
const tailKey = (c: Container) => c.ID + c.State + (c.Status.match(/\((\d+)\)/)?.[1] ?? '');
const fell = (c: Container) => isProblem(c) && c.State !== 'running';
// junto com a linha, o inspect de quem caiu: separa o 137 em falta de memória ou SIGKILL e diz quantas vezes reiniciou
const facts: Record<string, Facts> = {};
async function loadTail(c: Container) {
  const k = tailKey(c);
  if (k in tails) return;
  tails[k] = '';
  // sem resposta: o status traduzido já diz o essencial
  const get = (path: string) => api(path).then(r => r.ok ? r.json() : null).catch(() => null);
  const [txt, info]: [string | null, Facts | null] = await Promise.all([get(`/api/logs/${c.ID}?tail=5`), get(`/api/inspect/${c.ID}`)]);
  // stdout e stderr chegam um depois do outro: o timestamp ISO no começo de cada linha devolve a ordem
  tails[k] = txt?.split('\n').filter(l => l.trim()).sort().at(-1)?.replace(/^\d{4}-\d\d-\d\dT\S+\s/, '') ?? '';
  if (info) facts[k] = {OOMKilled: info.OOMKilled, RestartCount: info.RestartCount, FinishedAt: info.FinishedAt};
  if (tails[k] || info) render();
}

const rowCache = new Map<string, {sig: string; html: string}>();
function row(c: Container, withProject = false) {
  if (fell(c)) loadTail(c);
  const sig = JSON.stringify([c, withProject, tails[tailKey(c)], facts[tailKey(c)], busy.get(c.ID), arming?.id === c.ID, errors.get(c.ID), health[c.ID + c.Status], stats[sid(c.ID)],
                              series.get(sid(c.ID))?.at(-1)?.t, composing.has(project(c)), TOUCH, WIDE.matches, sel.has(c.ID), quiet(c), fallKey(c)]);
  const hit = rowCache.get(c.ID);
  if (hit?.sig === sig) return hit.html;
  const html = rowHtml(c, withProject);
  rowCache.set(c.ID, {sig, html});
  return html;
}

// armada, a linha só fica marcada (e a principal e o "⋯" inertes): o Confirmar, o × e o aviso vão para o pé da tela
// (armHtml). A tabela não se mexe na hora da decisão, e o clique por hábito no mesmo lugar não confirma nada
const RESTART_ICON = '<svg aria-hidden="true" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" class="size-4"><path d="M13 8a5 5 0 1 1-1.6-3.7"/><path d="M13 2.5v3h-3"/></svg>';
const X_ICON = '<svg aria-hidden="true" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" class="size-4"><path d="M4 4l8 8M12 4l-8 8"/></svg>';
// nomes que vêm do docker, dentro de uma frase: em mono, como no resto da página
const mono = (s: string) => `<span class="font-mono">${s}</span>`;
// todo estado armado tem o × ao lado do Confirmar (no toque não há Esc, e esperar 8 s não é saída) e o mesmo aviso,
// que começa pelo contexto quando o daemon é remoto: a confirmação diz onde vai apagar
const cancelBtn = (id: string, what: string) => `<button data-id="${id}" data-a="cancel" aria-label="${t`Cancelar ${what}`}" title="${t`Cancelar (Esc)`}"
  onclick="disarm()" class="grid place-items-center shrink-0 w-9 coarse:w-11 ${BTN} text-fg hover:bg-hover">${X_ICON}</button>`;
const armNote = (text: string, cls = 'w-full text-balance') => `<p aria-hidden="true" class="${cls} text-xs text-bad-soft">${
  REMOTE ? `<span class="font-semibold text-warn-fg">${esc(CTX)}</span> · ` : ''}${text} ${TOUCH ? t`Cancela sozinho em 8 s.` : t`Esc cancela.`}</p>`;
// a queda que alguém já viu sai da faixa de atenção até o container cair de novo (o FinishedAt do inspect muda).
// Fica neste navegador; ponytail: guarda as últimas 200
const SEEN_KEY = 'docker-gui-seen';
let seenFails = new Set<string>((() => { try { return JSON.parse(localStorage.getItem(SEEN_KEY) || '[]'); } catch { return []; } })());
const fallKey = (c: Container) => { const f = facts[tailKey(c)]; return f?.FinishedAt ? `${c.ID}@${f.FinishedAt}` : ''; };
const quiet = (c: Container) => (c.State === 'exited' || c.State === 'dead') && seenFails.has(fallKey(c));
// na faixa de atenção: o que está com problema, menos a queda antiga que alguém marcou como vista
const inBand = (c: Container) => isProblem(c) && !quiet(c);
function saveSeen() {
  try { localStorage.setItem(SEEN_KEY, JSON.stringify([...seenFails].slice(-200))); } catch { /* aba privada: vale só agora */ }
  render();
}
function ackFail(id: string) {
  const c = data.find(c => c.ID === id), k = c && fallKey(c);
  if (!k) return;
  seenFails.add(k); saveSeen();
  toast(t`${c.Names} saiu da faixa de atenção. Volta para lá se cair de novo.`, true, [t`Desfazer`, () => { seenFails.delete(k); saveSeen(); }]);
  document.querySelector<HTMLElement>(`[data-id="${id}"][data-a="logs"]`)?.focus();
}
function rowHtml(c: Container, withProject: boolean) {
  const b = busy.get(c.ID), tn = TONE[b ? 'busy' : tone(c)], st = status(c, facts[tailKey(c)]), pp = ports(c.Ports), p = project(c), bt = b && busyText(c, b);
  const armed = arming?.id === c.ID, prim = PRIMARY[c.State], sec = SECONDARY[c.State];
  const u = c.State === 'running' && !b && stats[sid(c.ID)] ? usage(stats[sid(c.ID)]) : null, h = series.get(sid(c.ID)) ?? [];
  const slot = (w = 'w-20') => `<span aria-hidden="true" class="${w} shrink-0 max-sm:hidden"></span>`;
  const btn = (a: RowAction, cls = 'text-fg hover:bg-hover', text = LABEL[a], aria = `${LABEL[a]} ${esc(c.Names)}`, base = BTN) =>
    `<button data-id="${c.ID}" data-a="${a}" ${(b || armed) && a !== 'logs' ? 'aria-disabled="true"' : ''}
      aria-label="${aria}" aria-describedby="st-${c.ID}" onclick="act('${a}','${c.ID}')" class="sm:w-20 max-sm:min-w-24 shrink-0 ${base} ${cls}">${text}</button>`;
  // ações raras (pausar, remover, exec, o compose do serviço) ficam no "⋯": a linha mostra a principal, Reiniciar e Logs
  const svc = p && workingDir(c) && service(c);  // compose restart só com a pasta no label, como o compose up
  // Reiniciar (o ciclo de quem desenvolve: muda, reinicia, olha os logs) fica à vista, em ícone para caber; sai do "⋯".
  // É o docker restart deste container; o do serviço inteiro (todas as réplicas) é o "compose restart" do "⋯"
  const restart = c.State === 'running' ? `<button data-id="${c.ID}" data-a="restart" ${b ? 'aria-disabled="true"' : ''} aria-label="${t`Reiniciar ${esc(c.Names)}`}"
      aria-describedby="st-${c.ID}" title="${t`Reiniciar este container (r)`}" onclick="act('restart','${c.ID}')"
      class="grid place-items-center shrink-0 w-9 coarse:w-11 ${BTN} text-fg hover:bg-hover">${RESTART_ICON}</button>` : slot('w-9');
  // no "⋯", o compose do serviço com o comando literal: "compose restart api" não se confunde com o Reiniciar da linha
  const more = [sec && sec !== 'restart' && [sec, LABEL[sec]], svc && ['srestart', `compose restart ${esc(svc)}`],
                svc && ['sbuild', `compose up --build ${esc(svc)}`], c.State === 'running' && ['pause', t`Pausar`],
                c.State === 'running' && ['shell', t`Abrir terminal`], c.State === 'running' && ['exec', t`Copiar docker exec`],
                removable(c) ? ['remove', t`Remover…`] : ['noremove', t`Pare antes de remover`]].filter((x): x is [MenuAction, string] => !!x);
  const menu = !more.length ? slot('w-9') : menuBox(c.ID, t`Mais ações para ${esc(c.Names)}`, !!b || armed,
    more.map(([a, text]) => a === 'noremove' ? `<button data-id="${c.ID}" data-a="m-noremove" aria-disabled="true" aria-label="${t`Remover (indisponível: pare o container antes)`}" title="${t`O docker só remove container parado (sem -f)`}"
      class="${MENU_ITEM} text-muted cursor-not-allowed hover:bg-transparent">${text}</button>` : `<button data-id="${c.ID}" data-a="m-${a}" ${b || ((a === 'srestart' || a === 'sbuild') && composing.has(p)) ? 'aria-disabled="true"' : ''} onclick="menuPick(this); ${a === 'exec' ? `copyExec('${c.ID}')` : a === 'shell' ? `openShell('${c.ID}')`
      : a === 'srestart' || a === 'sbuild' ? `serviceAct('${a.slice(1)}','${c.ID}')` : `act('${a}','${c.ID}')`}"
      ${a === 'srestart' ? `title="${t`Reinicia todas as réplicas do serviço ${esc(svc)}`}"` : a === 'sbuild' ? `title="${t`Reconstrói a imagem e recria o serviço ${esc(svc)} (b)`}"` : ''}
      class="${MENU_ITEM} ${a === 'remove' ? 'text-bad-fg' : a === 'srestart' || a === 'sbuild' ? 'font-mono text-xs text-fg' : 'text-fg'}">${text}</button>`).join(''));
  // [contain:inline-size]: o healthcheck aberto quebra dentro da coluna, sem alargá-la (a tabela inteira se mexia)
  const healthBox = hasHealth(c) && !b ? `<details data-keep="health" class="mt-1 text-xs [contain:inline-size]" ontoggle="this.open && loadHealth('${c.ID}')">
      <summary class="cursor-pointer w-fit py-1 coarse:py-3.5 rounded focus-visible:outline-2 focus-visible:outline-accent text-muted hover:text-fg">${t`Ver último healthcheck`}</summary>
      <pre class="mt-1 whitespace-pre-wrap [overflow-wrap:anywhere] font-mono text-fg-soft">${esc(health[c.ID + c.Status] || t`Carregando…`)}</pre></details>` : '';
  const tail = fell(c) && !b ? tails[tailKey(c)] : '';
  // na faixa, a última linha do log é o atalho para o diagnóstico: abre os logs
  const tailBtn = tail ? `<button data-id="${c.ID}" data-a="tail" onclick="act('logs','${c.ID}')" title="${esc(tail)}"
      class="block w-full [contain:inline-size] mt-1 text-left font-mono text-xs text-fg-soft sm:truncate [overflow-wrap:anywhere] rounded cursor-pointer hover:text-fg-strong hover:underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-accent"><span aria-hidden="true" class="text-dim">› </span><span class="sr-only">${t`Abrir os logs. Última linha:`} </span>${esc(tail)}</button>` : '';
  const seenBtn = withProject && !b && (c.State === 'exited' || c.State === 'dead') && fallKey(c) ? `<button data-id="${c.ID}" data-a="seen" onclick="ackFail('${c.ID}')"
      aria-label="${t`Marcar a queda de ${esc(c.Names)} como vista: sai da faixa de atenção`}" class="mt-1 py-0.5 coarse:py-3 font-sans text-xs text-muted underline underline-offset-4 rounded hover:text-fg focus-visible:outline-2 focus-visible:outline-accent">${t`Marcar como visto`}</button>` : '';
  // abaixo de 1280px a imagem e as portas descem para baixo do nome (a tabela fica com nome, status e ações)
  const image = `<bdi dir="ltr">${esc(shortImage(c.Image))}</bdi>`, chips = pp.map(x => portChip(c, x)).join('');
  const on = sel.has(c.ID), cell = 'py-3 align-top';
  // na faixa de atenção diagnosticar é a tarefa: o Logs ganha contorno e o ciano do que é interativo
  const logsBtn = withProject ? btn('logs', 'text-accent-fg hover:bg-accent/10', undefined, undefined, BTN.replace('ring-line-strong/80', 'ring-accent/40'))
    : btn('logs', 'text-fg-soft hover:text-fg-strong hover:bg-hover', undefined, undefined, ghost());
  return `<tr data-row data-key="c:${c.ID}" role="row" class="border-t border-line/70 ${armed ? 'bg-bad/10' : on ? 'bg-accent/10' : 'hover:bg-raised/70'} transition-[background-color] motion-reduce:transition-none max-sm:block max-sm:px-4 max-sm:py-4 max-sm:space-y-1.5">
    <th role="rowheader" scope="row" class="${cell} pl-4 pr-6 max-sm:block max-sm:p-0 text-left font-normal"><div class="flex items-start gap-3">
      <input type="checkbox" data-id="${c.ID}" data-a="sel" ${on ? 'checked' : ''} aria-label="${t`Selecionar ${esc(c.Names)}`}" onchange="toggleSel('${c.ID}')" class="${CHECK} mt-0.5 coarse:mt-0">
      <span aria-hidden="true" class="size-2 mt-1.5 coarse:mt-2 shrink-0 rounded-full ${tn[0]}"></span>
      <div class="min-w-0"><div class="font-mono text-data font-semibold text-fg-strong sm:truncate sm:max-w-[28ch]" title="${esc(c.Names)} · ${c.ID.slice(0, 12)}">${esc(c.Names)}</div>${
           withProject && p ? `<div class="font-mono text-xs text-muted">${esc(p)}</div>` : ''}
${WIDE.matches ? '' : `
        <div class="font-mono text-xs text-muted sm:truncate sm:max-w-[28ch] sm:[direction:rtl] sm:text-left [overflow-wrap:anywhere]" title="${esc(c.Image)}"><span class="sr-only">${t`Imagem:`} </span>${image}</div>${
        chips ? `<div class="mt-0.5 flex flex-wrap gap-1 -ml-1 coarse:gap-x-2 coarse:-ml-2">${chips}</div>` : ''}`}</div></div></th>
    <td role="cell" class="${cell} font-mono text-xs text-muted pr-4 max-xl:hidden">${WIDE.matches ? `<div class="truncate [direction:rtl] text-left" title="${esc(c.Image)}">${image}</div>` : ''}</td>
    <td role="cell" class="${cell} font-mono text-data pr-4 sm:min-w-[20ch] max-sm:block max-sm:p-0 max-sm:pl-12 max-sm:coarse:pl-14" title="${esc(c.Status)}">
      <span id="st-${c.ID}" class="${tn[1]}">${bt || esc(st[0])}${st[1] && !b ? `<span class="block text-xs text-muted">${st[1]}</span>` : ''}</span>${tailBtn}${
      u ? `<span id="us-${c.ID}" class="block text-xs font-mono text-muted" title="${esc(u[2])}"><span class="whitespace-nowrap">${esc(u[0])} ${spark(h, 'cpu')}</span> <span class="whitespace-nowrap max-xl:block"><span class="max-xl:hidden">· </span>${esc(u[1])} ${spark(h, 'mem')}</span></span>` : ''}${b ? '' : errHtml(c) + healthBox}${seenBtn}</td>
    <td role="cell" class="${cell} pr-4 max-xl:hidden">${WIDE.matches && chips ? `<div class="flex flex-wrap gap-1">${chips}</div>` : ''}</td>
    <td role="cell" class="py-2.5 align-top pr-4 max-sm:block max-sm:p-0 max-sm:pt-2"><div class="flex justify-end max-sm:justify-start items-center gap-1.5 coarse:gap-2">
      ${prim ? btn(prim, prim === 'start' ? 'text-ok-fg hover:bg-ok/10' : undefined) : slot()}${restart}${logsBtn}
      ${menu}
    </div></td></tr>`;
}

// "⋯" das ações raras, de um container ou de um projeto: o id e o aria-label dizem de quem é
const MENU_ITEM = 'block w-full text-left px-3 py-2 coarse:py-3 rounded text-sm hover:bg-hover focus-visible:outline-2 focus-visible:outline-accent';
const menuBox = (id: string, label: string, off: boolean, items: string) => `<details data-keep="menu" class="shrink-0" ontoggle="placeMenu(this)">
    <summary data-id="${id}" data-a="menu" aria-label="${label}" ${off ? 'aria-disabled="true"' : ''}
      class="list-none [&::-webkit-details-marker]:hidden cursor-pointer grid place-items-center w-9 coarse:w-11 ${BTN} text-fg hover:bg-hover">
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
WIDE.addEventListener('change', () => render());
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

const bandHead = (text: string, cls: string) => `<tr data-key="h:attn" role="row" class="max-sm:block"><th role="columnheader" colspan="5" scope="colgroup"
  class="max-sm:block px-4 pt-4 pb-2 text-left font-mono text-xs font-semibold uppercase border-t border-line ${cls}">${text}<span class="ml-3 font-sans font-normal normal-case text-bad-soft/80">${t`healthcheck falhando, loop de reinício ou saída com erro`}</span></th></tr>`;

// cabeçalho do projeto compose: contagem e ações para o stack inteiro (sempre sobre todos os containers do projeto).
// Como na linha: uma ação principal (Iniciar tudo se algo está parado, senão Parar tudo), Logs e o resto no "⋯"
function groupHead(k: string, label: string) {
  const all = data.filter(c => project(c) === k), on = all.filter(c => c.State === 'running').length;
  const anyBusy = composing.has(k) || all.some(c => busy.has(c.ID)), dir = k && workingDir(all[0]), armed = arming?.id === `stack-${k}`;
  const nBand = all.filter(inBand).length, ek = esc(k), off = anyBusy ? 'aria-disabled="true"' : '';
  // o que não está rodando nem parado aparece pelo nome: "Parar tudo (5)" fecha com "3 de 5 rodando · 1 pausado · 1 reiniciando"
  const nst = (st: ContainerState) => all.filter(c => c.State === st).length;
  const also = [nst('paused') && plural(nst('paused'), t`pausado`, t`pausados`), nst('restarting') && t`${nst('restarting')} reiniciando`]
    .filter(Boolean).map(x => ` · ${x}`).join('');
  const prim: Action = stackList('start', k).length ? 'start' : 'stop';
  // com um container só, o botão diz qual: "Iniciar worker" em vez de "Iniciar tudo (1)"
  const sbtn = (a: Action, text: string, cls: string) => {
    const list = stackList(a, k), n = list.length, one = n === 1 ? `${LABEL[a]} ${esc(list[0].Names)}` : '', label = one || `${text} (${n})`;
    return k && n ? `<button data-id="stack-${ek}" data-a="${a === prim ? a : `m-${a}`}" data-p="${ek}" ${off} aria-label="${one ? t`${one} do projeto ${ek}` : t`${text} do projeto ${ek} (${n})`}"
      title="${esc(list.map(c => c.Names).join(', '))}" onclick="${a === prim ? '' : 'menuPick(this); '}stackAct('${a}', this.dataset.p)" class="${cls}">${label}</button>` : '';
  };
  // compose up/pull/down e logs do projeto: só com o working_dir no label (o servidor precisa dele para achar o projeto)
  const cbtn = (a: ComposeAction, text: string, cls = MENU_ITEM + ' text-fg') =>
    `<button data-id="stack-${ek}" data-a="m-${a}" data-p="${ek}" ${off} aria-label="${t`${text.replace('…', '')} do projeto ${ek}`}"
      onclick="menuPick(this); composeAct('${a}', this.dataset.p)" class="${cls}">${composing.get(k) === a ? COMPOSE_VERB[a] : text}</button>`;
  // grupos do menu, separados por um traço: Reiniciar/Parar ou Iniciar, os comandos do compose e, por último, o down
  // serviços do arquivo sem container: o menu sobe cada um (compose up <serviço>)
  const missing = dir ? missingSvcs(k, dir, all) : [];
  const upSvc = missing.map(s => `<button data-id="stack-${ek}" data-a="m-svcup-${esc(s)}" data-p="${ek}" data-s="${esc(s)}" ${off}
      aria-label="${t`compose up ${esc(s)} do projeto ${ek}`}" onclick="menuPick(this); composeAct('svcup', this.dataset.p, this.dataset.s)"
      class="${MENU_ITEM} text-fg">compose up ${esc(s)}</button>`).join('');
  const groups = [STACK.filter(([a]) => a !== prim).map(([a, text]) => sbtn(a, text, MENU_ITEM + ' text-fg')).join(''),
                  dir ? cbtn('up', 'compose up') + cbtn('rebuild', 'compose up --build') + cbtn('pull', 'compose pull') : '', upSvc,
                  dir ? cbtn('down', 'compose down…', MENU_ITEM + ' text-bad-fg') : ''].filter(Boolean);
  const verb = composing.get(k);
  // a faixa de estado: um bloco por container do projeto, na cor do estado, como uma calha de processos
  const strip = k ? `<span aria-hidden="true" data-strip class="flex items-center gap-0.5">${[...all].sort((a, b) => a.Names.localeCompare(b.Names)).map(c =>
    `<span title="${esc(c.Names)}: ${esc(status(c)[0])}" class="h-3 w-1.5 rounded-[1px] ${TONE[busy.has(c.ID) ? 'busy' : tone(c)][0]}"></span>`).join('')}</span>` : '';
  return `<tr data-key="g:${ek}" role="row" class="max-sm:block"><th role="columnheader" colspan="5" scope="colgroup" class="max-sm:block px-4 pt-3 pb-2.5 text-left font-normal border-t border-line-strong bg-raised">
    <div class="flex flex-wrap items-center gap-x-3 gap-y-2">
      <span class="font-mono text-group font-semibold ${k ? 'text-fg-strong' : 'text-fg-soft'}">${label}</span>${strip}
      ${k ? `<span class="font-mono text-xs ${verb ? 'text-fg-strong' : 'text-muted'}">compose · ${verb ? COMPOSE_VERB[verb] : t`${on} de ${all.length} rodando` + also}</span>` : ''}
      ${k && nBand ? `<span class="text-xs text-bad-fg">${t`${nBand} na faixa de atenção, acima`}</span>` : ''}
      ${missing.length ? `<span class="text-xs text-muted" title="${t`No arquivo do compose, sem container: sobem pelo menu ⋯ do projeto`}">${
        t`sem container: ${`<span class="font-mono">${esc(missing.join(', '))}</span>`}`}</span>` : ''}
      <span class="sm:ml-auto max-sm:w-full flex flex-wrap items-center gap-1.5 coarse:gap-2">${sbtn(prim, prim === 'start' ? t`Iniciar tudo` : t`Parar tudo`,
        `${BTN} ${prim === 'start' ? 'text-ok-fg hover:bg-ok/10' : 'text-fg hover:bg-hover'}`)}${dir
        ? `<button data-id="stack-${ek}" data-a="plogs" data-p="${ek}" aria-label="${t`Logs do projeto ${ek}`}" onclick="projectLogs(this.dataset.p)"
            class="w-20 ${ghost()} text-fg-soft hover:text-fg-strong hover:bg-hover">${t`Logs`}</button>` : ''}${groups.length
        ? menuBox(`stack-${ek}`, t`Mais ações do projeto ${ek}`, anyBusy || armed, groups.join('<hr class="my-1 border-line">')) : ''}</span>
    </div></th></tr>`;
}

// pt-BR: "remoção de a rede" -> "remoção da rede" (o artigo vem do OBJ; em inglês não acontece)
const de = (s: string) => s.replace(/\bde ([ao]s?) /g, 'd$1 ');
// o segundo passo de uma ação destrutiva (menos o lote, que tem a barra dele): o que sai e o que fica, o Confirmar com o
// verbo e o alvo, e o ×. Calculado a cada render: o aviso do volume prune, por exemplo, chega depois da lista de volumes
let dockHtml = '';
function armHtml() {
  if (!arming || arming.id === 'bulk') return '';
  const {id, a, name} = arming;
  let note: string, text: string, aria: string, what: string;
  if (a === 'down') {
    note = t`Derrubar ${mono(esc(name))}? ${downNote(name, true)}`; text = t`Derrubar ${esc(name)}`;
    aria = t`Confirmar compose down do projeto ${esc(name)}`; what = t`compose down do projeto ${esc(name)}`;
  } else if (a === 'prune') {
    const [type, , label, what0, note0] = DISK.find(d => 'df-' + d[1] === id)!, d = Array.isArray(disk) ? disk.find(d => d.Type === type) : undefined;
    note = t`Apagar ${what0}? ${esc(pruneNote(d, note0))}`; text = t`Limpar ${label.toLowerCase()}`;
    aria = t`Confirmar limpeza de ${label.toLowerCase()}`; what = t`limpeza de ${label.toLowerCase()}`;
  } else if (a === 'rm') {
    note = t`Remover ${esc(name)}? ${OBJ[id.split('-')[1] as ObjKind][5]}`; text = t`Remover`;
    aria = de(t`Confirmar remoção de ${esc(name)}`); what = de(t`remoção de ${esc(name)}`);
  } else {
    note = t`Remover ${mono(esc(name))} de vez? Os volumes ficam.`; text = t`Remover`;
    aria = t`Confirmar remoção de ${esc(name)}`; what = t`remoção de ${esc(name)}`;
  }
  return `${armNote(note, 'max-w-[60ch] text-balance')}<span class="flex shrink-0 gap-1.5 coarse:gap-2"><button data-id="${esc(id)}" data-a="confirm"
    aria-label="${aria}" onclick="confirmArm()" class="${BTN} bg-danger text-white ring-danger hover:bg-danger-hover">${text}</button>${cancelBtn(esc(id), what)}</span>`;
}

function render() {
  const q = $<HTMLInputElement>('#q').value.trim().toLowerCase();
  // ordem alfabética estável: a linha não sai de baixo do cursor depois de uma ação;
  // a triagem fica na faixa "Precisa de atenção", o resto agrupado por projeto compose
  const rows = data.filter(c => (!only || bucket(c) === only) && [c.Names, c.Image, project(c)].join(' ').toLowerCase().includes(q))
                   .sort((a, b) => a.Names.localeCompare(b.Names));
  visible = rows.map(c => c.ID);
  const attn = rows.filter(inBand), groups = new Map<string, Container[]>();
  for (const c of rows) if (!inBand(c)) groups.set(project(c), [...(groups.get(project(c)) || []), c]);
  // projeto com todos os containers na faixa ainda precisa do cabeçalho (e das ações do stack)
  for (const c of attn) if (project(c) && !groups.has(project(c))) groups.set(project(c), []);
  const keys = [...groups.keys()].sort((a, b) => Number(a === '') - Number(b === '') || a.localeCompare(b));  // soltos por último
  const heads = attn.length || keys.length > 1 || keys[0];  // uma lista só de containers soltos dispensa cabeçalho
  const label = only ? BUCKETS.find(([k]) => k === only)![1] + ' ' : '';
  const f = (document.activeElement as HTMLElement | null)?.dataset;  // re-render não pode roubar o foco do teclado
  patchRows(rows.length
    ? [...(attn.length ? [bandHead(t`Precisa de atenção · ${attn.length}`, 'text-bad-fg bg-bad/10'), ...attn.map(c => row(c, true))] : []),
       ...keys.flatMap(k => [...(heads ? [groupHead(k, k ? esc(k) : keys.length > 1 ? t`Sem projeto compose` : t`Demais containers`)] : []),
                             ...(outs.has(k) ? [outRow(k)] : []),
                             ...groups.get(k)!.map(c => row(c))])]
    : [`<tr data-key="empty" role="row" class="max-sm:block"><td role="cell" colspan="5" class="max-sm:block py-16 px-4 text-center text-muted">${
      !lastOk ? (problem ? t`Sem dados ainda.` : t`Carregando…`)  // nunca recebeu dados: não afirma que a lista está vazia
      : !data.length ? t`Nenhum container ainda. Crie um em “Novo container” ou com ${code('docker run')}.`
      : q ? t`Nenhum container ${label}corresponde a “${esc(q)}”.` : t`Nenhum container ${label}agora.`}</td></tr>`]);
  dirty = false;
  // o texto da saída não vai no HTML da linha (cada linha que chega a redesenharia): entra aqui quando a linha é nova
  outs.forEach((o, k) => { const pre = outPre(k); if (pre && pre.textContent!.length !== o.text.length) { pre.textContent = o.text; pre.scrollTop = pre.scrollHeight; } });
  // o segundo passo fica preso no pé da tela: dentro da tabela, ou empurrava as linhas ou cobria uma delas
  const dock = armHtml();
  if (dock !== dockHtml) $('#armdock').innerHTML = dockHtml = dock;  // só troca se mudou: o foco fica no × ou no Confirmar
  $('#armdock').classList.toggle('hidden', !dock);
  renderCount();
  renderBulk();
  renderDlg();
  renderDisk();
  renderObjects();
  if (f?.id) refocus(f.id, f.a);
  saveHash();
  // só escreve na região viva quando a mensagem muda, para não apagar o anúncio de uma ação em andamento
  const say = arming ? `${REMOTE ? t`No daemon remoto ${CTX}: ` : ''}${arming.a === 'down' ? t`Clique em Derrubar ${arming.name} para derrubar o projeto.`
    : arming.a === 'prune' ? t`Clique em Limpar para apagar ${arming.name}.` : t`Clique em Remover para apagar ${arming.name} de vez.`} ${arming.note} ${TOUCH ? t`Cancela sozinho em 8 segundos.` : t`Esc cancela.`}`
            : q || only ? t`${rows.length} de ${data.length} containers` : '';
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
   ?? (['remove', 'cancel', 'confirm'].includes(a ?? '') ? q(`[data-id="${id}"][data-a="menu"]`) : null)
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
    const r = await T.request('POST', `/api/${a}/${c.ID}`);
    const msg: string = await r.json();
    if (!r.ok) errors.set(c.ID, {msg: msg || t`erro sem mensagem`, state: c.State, what: LABEL[a]});
    return r.ok;
  } catch {
    errors.set(c.ID, {msg: t`Sem resposta do servidor do Stivo.`, state: c.State, what: LABEL[a]});
    return false;
  } finally { busy.delete(c.ID); render(); }
}

// sure: veio do Confirmar do segundo passo
async function act(a: RowAction, id: string, sure = false): Promise<unknown> {
  if (a === 'logs') return logs(id);
  // com a remoção armada, a principal fica inerte: clicar nela por hábito só cancela
  if (arming?.id === id && a !== 'remove') return disarm();
  const c = data.find(c => c.ID === id);
  if (!c || busy.has(id)) return;
  if (a === 'remove' && !sure) return arm(id, c.Names, 'remove', t`Os volumes não são afetados.`, () => act('remove', id, true));
  const trs = [...document.querySelectorAll<HTMLElement>('#rows tr[data-row]')], i = trs.findIndex(tr => tr.dataset.key === 'c:' + id);
  const near = (trs[i + 1] || trs[i - 1])?.dataset.key?.slice(2), since = new Date().toISOString();
  const done = run(a, c);
  $('#shown').textContent = `${VERB[a]} ${c.Names}`;
  if (!(await done)) {
    toast(t`Não deu para ${LABEL[a].toLowerCase()} ${c.Names}. ${errHint(errors.get(id)?.msg ?? '') || t`O erro ficou na linha.`}`);
    return load();
  }
  if (!UP.includes(a)) {
    // pausado parece "ligado" na lista; o desfazer evita esquecer o container congelado
    // e o Parar oferece Iniciar de novo, como no lote e no projeto (pausado que parou fica de fora: iniciar não devolve a pausa)
    toast(`${c.Names} ${DONE[a]}.`, true, a === 'pause' ? [t`Retomar`, () => act('unpause', id)]
      : a === 'stop' && c.State !== 'paused' ? [t`Iniciar de novo`, () => act('start', id)] : null);
    await load();
    if (a === 'remove') (document.querySelector<HTMLElement>(`[data-id="${near}"][data-a="logs"]`) || $('#q')).focus();
    return;
  }
  toast(t`${c.Names} ${DONE[a]}, conferindo se ficou de pé…`, true);
  // com os logs dele abertos: liga o ao vivo (o anterior caiu quando o container parou) e marca onde o novo log começa
  if ($<HTMLDialogElement>('#dlg').open && logId === id) { mark = {at: since, label: t`${DONE[a]} às ${new Date().toLocaleTimeString(LOCALE)}`}; toggleFollow(true); }
  confirmUp([c.ID]);
}

// o docker devolve sucesso assim que o processo sobe; só depois de uns segundos dá para saber se ficou de pé
const UP: Action[] = ['start', 'restart', 'unpause'];
async function confirmUp(ids: string[]) {
  await new Promise(r => setTimeout(r, 3000));
  await load();
  const cs = ids.map(id => data.find(c => c.ID === id)).filter((c): c is Container => !!c);
  const fell = cs.filter(c => c.State !== 'running' || isProblem(c));
  if (!fell.length) return toast(cs.length === 1 ? t`${cs[0].Names} está de pé.` : t`Os ${cs.length} containers estão de pé.`, true);
  if (fell.length === 1) toast(t`${fell[0].Names} subiu mas não ficou bem: ${status(fell[0])[0]}.`, false, [t`Ver logs`, () => logs(fell[0].ID)]);
  else toast(t`${fell.length} containers subiram mas não ficaram bem. Veja a faixa de atenção.`);
}

const STACK: [Action, string][] = [['start', t`Iniciar tudo`], ['restart', t`Reiniciar tudo`], ['stop', t`Parar tudo`]];
// em quem a ação de lote faz sentido: Iniciar só nos parados, Reiniciar nos rodando, Remover só no que não está de pé
const fits = (a: Action, c: Container) => a === 'start' ? PRIMARY[c.State] === 'start' : a === 'restart' ? c.State === 'running'
  : a === 'remove' ? removable(c) : STOPPABLE.includes(c.State);
const stackList = (a: Action, p: string, ids?: string[]) => data.filter(c => project(c) === p && (ids ? ids.includes(c.ID) : fits(a, c)));

function copyExec(id: string) {
  // data-cli: binário e --context com que o servidor foi iniciado (ex.: "podman", "docker --context prod")
  const cmd = `${document.documentElement.dataset.cli} exec -it ${data.find(c => c.ID === id)!.Names} sh`;
  navigator.clipboard.writeText(cmd).then(() => toast(t`Copiado: ${cmd}`, true), () => toast(t`Não consegui copiar. O comando é: ${cmd}`));
}

// ids: limita a ação a containers específicos (usado pelo "Iniciar de novo" depois de um Parar tudo)
async function stackAct(a: Action, p: string, ids?: string[]) {
  const list = stackList(a, p, ids);
  if (!list.length || composing.has(p) || list.some(c => busy.has(c.ID))) return;
  const all = Promise.all(list.map(c => run(a, c)));
  $('#shown').textContent = t`${VERB[a]} ${list.length} containers de ${p}`;
  const res = await all, fails = res.filter(ok => !ok).length, okIds = list.filter((c, i) => res[i] && c.State !== 'paused').map(c => c.ID);
  if (fails) toast(fails === 1 ? t`${p}: 1 de ${list.length} falhou. O erro ficou na linha.` : t`${p}: ${fails} de ${list.length} falharam. Os erros ficaram nas linhas.`);
  else if (a === 'stop') toast(t`${p}: ${list.length} parados.`, true, okIds.length ? [t`Iniciar de novo`, () => stackAct('start', p, okIds)] : null);
  else toast(a === 'start' ? t`${p}: ${list.length} iniciados, conferindo se ficaram de pé…` : t`${p}: ${list.length} reiniciados, conferindo se ficaram de pé…`, true);
  if (!fails && UP.includes(a)) return confirmUp(okIds);
  load();
}

// ---- seleção e ações em lote ----
const BULK: [Action, string][] = [['start', t`Iniciar`], ['stop', t`Parar`], ['restart', t`Reiniciar`], ['remove', t`Remover…`]];
const bulkList = (a: Action, ids: string[] = [...sel]) => data.filter(c => ids.includes(c.ID) && fits(a, c));
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
// "cron e velho", "a, b e c" ou "a, b, c e mais 4": a confirmação diz o que vai apagar, não só quantos
const names = (cs: Container[], max = 3) => cs.length > max ? t`${cs.slice(0, max).map(c => c.Names).join(', ')} e mais ${cs.length - max}`
  : cs.map(c => c.Names).join(', ').replace(/, ([^,]*)$/, (_, last) => t` e ${last}`);

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
  const say = n ? `${plural(n, t`container selecionado`, t`containers selecionados`)}${hidden ? t`, ${hidden} fora do filtro` : ''}`
                : t`Nenhum container selecionado`;
  if (say !== lastSel) $('#sel-live').textContent = lastSel = say;  // só anuncia quando a contagem muda
  const btn = ([a, text]: [Action, string]) => {
    const k = armed && a === 'remove' ? armedIds.length : bulkList(a).length;
    if (!k || armed && a !== 'remove') return '';  // como no Parar tudo, só o que faz sentido; armado, só o Confirmar e o ×
    const cls = armed && a === 'remove' ? 'bg-danger text-white ring-danger hover:bg-danger-hover'
              : a === 'start' ? 'text-ok-fg hover:bg-ok/10' : a === 'remove' ? 'text-bad-fg hover:bg-bad/10' : 'text-fg hover:bg-hover';
    const aria = armed && a === 'remove' ? t`Confirmar remoção de ${plural(k, 'container', 'containers')}` : `${text.replace('…', '')} ${plural(k, t`selecionado`, t`selecionados`)}`;
    return `<button data-id="bulk" data-a="${a}" ${bulkBusy ? 'aria-disabled="true"' : ''} aria-label="${aria}" title="${esc(bulkList(a, armed && a === 'remove' ? armedIds : undefined).map(c => c.Names).join(', '))}"
      onclick="${armed && a === 'remove' ? 'confirmArm()' : `bulkAct('${a}')`}" class="${BTN} ${cls}">${bulkBusy === a ? `${VERB[a]} (${k})` : armed && a === 'remove' ? t`Remover ${plural(k, 'container', 'containers')}` : `${text} (${k})`}</button>`;
  };
  const html = !n ? '' : `<p class="mr-auto text-sm font-medium text-fg-strong">${plural(n, t`selecionado`, t`selecionados`)}${
      hidden ? `<span class="font-normal text-muted"> · ${t`${hidden} fora do filtro`}</span>` : ''}</p>
    <div class="flex flex-wrap gap-1.5">${BULK.map(btn).join('')}${armed ? cancelBtn('bulk', t`remoção em lote`) : ''}
      ${armed ? '' : `<button data-id="bulk" data-a="clear" onclick="clearSel()" class="${BTN} text-muted hover:bg-hover">${t`Limpar seleção`}</button>`}</div>
    ${armed ? armNote(t`Remover ${mono(esc(names(data.filter(c => armedIds.includes(c.ID)), 10)))} de vez? Os volumes ficam.`) : ''}`;
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
    armedIds = bulkList('remove').map(c => c.ID);
    const ids = armedIds;
    if (ids.length) arm('bulk', names(data.filter(c => ids.includes(c.ID))), 'remove', t`Os volumes não são afetados.`, () => bulkAct('remove', ids));
    return;
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
    toast(t`${msg.slice(0, -1)}, conferindo se ficaram de pé…`, true);
    return confirmUp(okIds);
  }
  // o aviso só depois de reler a lista: o desfazer filtra pelo estado atual e, com os dados de antes, não acharia nada
  await load();
  // pausado que parou fica de fora do desfazer, como no Parar tudo: iniciar não devolveria a pausa
  toast(msg, !fails.length, a === 'stop' && okIds.length ? [t`Iniciar de novo`, () => bulkAct('start', okIds)] : null);
  if (a === 'remove' && (!document.activeElement || document.activeElement === document.body)) $('#q').focus();
}

// 1º clique arma (e desarma o que estiver armado): o Confirmar aparece no pé da tela (ou na barra do lote) e roda run.
// O mesmo botão de novo cancela, como a principal da linha armada: o hábito nunca confirma
function arm(id: string, name: string, a: Arming['a'], note: string, run: () => unknown) {
  if (arming?.id === id && arming.a === a) return disarm();
  disarm(false);
  arming = {id, name, a, note, run, at: Date.now(), timer: setTimeout(armTick, 8000)}; render();
  // o foco vai para o ×, o botão seguro: um segundo Enter cancela em vez de apagar (o Confirmar fica a um Shift+Tab)
  document.querySelector<HTMLElement>(`[data-id="${CSS.escape(id)}"][data-a="cancel"]`)?.focus();
}
function confirmArm() {
  if (!arming || Date.now() - arming.at < 600) return;  // duplo clique não pode virar confirmação
  const run = arming.run;
  disarm(false);
  run();
}

// ponytail: guarda só o fim de um build enorme (OUT_MAX caracteres); o motivo da falha fica nas últimas linhas
const OUT_MAX = 200_000;
const outs = new Map<string, Out>();
const outPre = (k: string) => document.querySelector<HTMLElement>(`pre[data-out="${CSS.escape(k)}"]`);
function addOut(p: string, o: Out, s: string) {
  o.text += s;
  const pre = outPre(p), cut = o.text.length > 2 * OUT_MAX;  // corta de vez em quando, não a cada linha
  if (cut) o.text = o.text.slice(-OUT_MAX);
  if (!pre) return;
  // acompanha o fim, a não ser que a pessoa tenha rolado para cima para ler
  const end = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 8;
  if (cut) pre.textContent = o.text; else pre.append(s);
  if (end) pre.scrollTop = pre.scrollHeight;
}
function closeOut(p: string) {
  outs.delete(p); render();
  document.querySelector<HTMLElement>(`[data-id="stack-${CSS.escape(p)}"][data-a="menu"]`)?.focus();
}
// linha logo abaixo do cabeçalho do projeto: o comando, o estado e a saída (o texto entra pelo render e pelo addOut)
function outRow(k: string) {
  const o = outs.get(k)!, ek = esc(k), what = esc(o.what), running = o.code === null;
  const state = running ? t`rodando…` : o.code === -1 ? t`sem resposta do servidor` : t`falhou (código ${o.code})`;
  return `<tr data-key="o:${ek}" role="row" class="max-sm:block"><td role="cell" colspan="5" class="max-sm:block px-4 pb-3 bg-raised">
    <div class="flex items-center gap-2 font-mono text-xs ${running ? 'text-fg-soft' : 'text-bad-fg'}">
      <span>${what} · ${state}</span>${running ? '' : `<button data-id="out-${ek}" data-a="close" data-p="${ek}" onclick="closeOut(this.dataset.p)"
        aria-label="${t`Fechar a saída do ${what} do projeto ${ek}`}" title="${t`Fechar`}" class="ml-auto grid place-items-center shrink-0 w-9 coarse:w-11 ${BTN} text-fg hover:bg-hover">${X_ICON}</button>`}
    </div>
    <pre data-out="${ek}" tabindex="0" aria-label="${t`Saída do ${what}`}"
      class="mt-1.5 max-h-64 overflow-auto whitespace-pre-wrap [overflow-wrap:anywhere] rounded bg-canvas p-2 font-mono text-xs text-fg-soft ring-1 ring-line focus-visible:outline-2 focus-visible:outline-accent"></pre>
  </td></tr>`;
}

// docker compose up/up --build/pull/down no projeto inteiro (down pede confirmação: o projeto some da lista),
// ou restart/build de um serviço (svc)
async function composeAct(a: ComposeAction, p: string, svc = '', sure = false): Promise<unknown> {
  const c = data.find(c => project(c) === p);
  if (!c || composing.has(p) || data.some(c => project(c) === p && busy.has(c.ID))) return;
  if (a === 'down' && !sure) return arm(`stack-${p}`, p, 'down', downNote(p), () => composeAct('down', p, '', true));
  // por serviço, as linhas dele (todas as réplicas) ficam ocupadas e depois passam pelo confirmUp
  const mine = () => data.filter(c => project(c) === p && service(c) === svc).map(c => c.ID), ids = svc ? mine() : [];
  // svcup é de um serviço sem container: depois do up, os containers novos dele passam pelo confirmUp
  const since = new Date().toISOString();
  const what = `${COMPOSE_CMD[a]}${svc ? ` ${svc}` : ''}`;
  let ok = false;
  const o: Out = {what, text: '', code: null};
  composing.set(p, a); outs.set(p, o); ids.forEach(id => busy.set(id, 'restart')); render();
  $('#shown').textContent = `${COMPOSE_VERB[a]} ${svc || p}`;
  try {
    // a saída chega linha a linha (NDJSON) e o fim traz o código de saída
    const r = await T.ndjson(`/api/compose/${a}`, {project: p, dir: workingDir(c), ...(svc ? {service: svc} : {})}, l => addOut(p, o, l + '\n'));
    // erro antes do compose rodar (projeto ou serviço que não existe): JSON com a mensagem, sem saída para mostrar
    const okStatus = r.status < 400;
    const msg = okStatus ? (o.code = r.code, o.text) : (outs.delete(p), String(r.error));
    ok = okStatus && o.code === 0;
    // o compose escreve o progresso no stderr: no erro, a última linha é a que explica (a saída inteira fica na tela)
    toast(ok ? ids.length ? t`${p}: ${what} concluído, conferindo se ficou de pé…` : t`${p}: ${what} concluído.`
             : t`${p}: ${what} falhou. ${errHint(msg) || msg.trim().split('\n').at(-1) || t`Erro sem mensagem.`}`, ok);
  } catch {
    o.code = -1;
    toast(t`${p}: sem resposta do servidor do Stivo.`);
  }
  // deu certo: o aviso basta. Falhou: a saída fica aberta até o ×, com o motivo
  if (ok || !o.text) outs.delete(p);
  composing.delete(p); ids.forEach(id => busy.delete(id)); svcs.delete(p); render();
  await load();
  // o build recria o container quando a imagem mudou: o ID novo é o que tem que ficar de pé
  const now = svc ? mine() : [];
  // com os logs do serviço abertos: seguem o container de agora (o build pode ter trocado o ID), ao vivo, com a marca
  if (ok && now.length && $<HTMLDialogElement>('#dlg').open && logId && ids.includes(logId)) {
    logId = now.includes(logId) ? logId : now[0];
    mark = {at: since, label: t`${a === 'build' ? t`reconstruído` : DONE.restart} às ${new Date().toLocaleTimeString(LOCALE)}`};
    toggleFollow(true);
  }
  if (ok && now.length) return confirmUp(now);
  if (a === 'down') $('#q').focus();
}

// serviços do arquivo do compose (config --services), para mostrar os que não têm container (nunca subiram, ou
// removidos à mão). Lido uma vez por projeto, de novo quando os serviços com container mudam (um compose up pelo
// terminal) e depois de cada ação do compose pela página. ponytail: só os perfis ativos; quem está atrás de um
// --profile não aparece
const svcs = new Map<string, {key: string; list: string[] | null}>();
async function loadSvcs(p: string, dir: string, key: string) {
  svcs.set(p, {key, list: null});
  let list: string[] = [];
  try {
    const r = await api(`/api/compose/services?${new URLSearchParams({project: p, dir})}`);
    if (r.ok) list = await r.json();
  } catch { /* sem a lista: o projeto só não mostra os serviços sem container */ }
  if (svcs.get(p)?.key !== key) return;  // os containers mudaram enquanto carregava: vale a consulta nova
  svcs.set(p, {key, list});
  render();
}
// serviços do arquivo sem nenhum container
function missingSvcs(p: string, dir: string, all: Container[]): string[] {
  const have = [...new Set(all.map(service))].sort(), key = have.join(','), got = svcs.get(p);
  if (got?.key !== key) { loadSvcs(p, dir, key); return []; }
  return (got.list ?? []).filter(s => !have.includes(s)).sort();
}

// o que o compose down leva, pelo nome (primeiro os da faixa de atenção: são os que você mais quer saber se vão junto). Depois dele o projeto some da lista (a pasta vinha dos labels dos containers),
// então o up para voltar é pelo terminal
const downNote = (p: string, html = false) => {
  const who = names(data.filter(c => project(c) === p).sort((a, b) => +isProblem(b) - +isProblem(a)), 10);
  return t`Remove ${html ? mono(esc(who)) : who} e as redes do projeto. Os volumes ficam; para subir de novo, use compose up no terminal.`;
};

// "Reiniciar serviço" e "Reconstruir serviço" do menu "⋯": compose restart ou up --build --no-deps do serviço do
// container (o servidor confere o nome nos labels)
function serviceAct(a: 'restart' | 'build', id: string) {
  const c = data.find(c => c.ID === id);
  if (c && workingDir(c) && service(c)) composeAct(a, project(c), service(c));
}

// a linha ocupada diz o que está acontecendo: no build do serviço, "Reconstruindo…" (no busy fica o restart)
const busyText = (c: Container, b: Action) => composing.get(project(c)) === 'build' ? COMPOSE_VERB.build : VERB[b];

// desarma sozinho depois de 8s, mas nunca enquanto o mouse ou o foco estão no Confirmar ou no × (WCAG 2.2.1).
// No toque não há hover e o foco fica parado no último botão tocado: lá vale o relógio, como o aviso promete
function armTick() {
  if (!arming) return;
  const els = [...document.querySelectorAll(`[data-id="${CSS.escape(arming.id)}"]:is([data-a="confirm"], [data-a="remove"], [data-a="cancel"])`)];
  if (!TOUCH && els.some(el => el.matches(':hover') || el === document.activeElement)) arming.timer = setTimeout(armTick, 1000);
  else { disarm(); toast(t`Confirmação cancelada: passaram 8 s sem o segundo clique. Nada foi apagado.`, true); }
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
    if ((e.key === 'b' || e.key === 'B') && !typing && logId) serviceAct('build', logId);
    return;
  }
  if (e.key === '/' && !typing) { e.preventDefault(); pickTab('containers'); return $('#q').focus(); }
  if (e.key === '?' && !typing) return $('#hint').togglePopover();
  if ((e.key === 'z' || e.key === 'Z') && !typing && toastFn) return runToastAction();
  if (tab !== 'containers') return;  // o resto mexe na lista de containers, que está escondida
  // x marca a linha em foco (junto com ↑↓ dá para selecionar sem mouse); a marca ou desmarca todos os visíveis
  const curId = el.closest?.<HTMLElement>('tr[data-row]')?.dataset.key?.slice(2);
  if ((e.key === 'x' || e.key === 'X') && !typing && curId) return toggleSel(curId);
  // s faz a ação principal da linha em foco (Iniciar, Parar ou Retomar), a mesma do primeiro botão dela
  const prim = curId && PRIMARY[data.find(c => c.ID === curId)?.State as ContainerState];
  if ((e.key === 's' || e.key === 'S') && !typing && curId && prim) return act(prim, curId);
  // r reinicia a linha em foco (com ↑↓ entre os Logs: muda o código, reinicia, olha os logs, sem mouse)
  if ((e.key === 'r' || e.key === 'R') && !typing && curId && data.find(c => c.ID === curId)?.State === 'running') return act('restart', curId);
  // l abre os logs da linha em foco: o ciclo inteiro (↑↓, r, l) fica no teclado
  if ((e.key === 'l' || e.key === 'L') && !typing && curId) { e.preventDefault(); return logs(curId); }
  // b reconstrói o serviço do compose da linha em foco: muda o código, b, olha os logs (sem compose, não faz nada)
  if ((e.key === 'b' || e.key === 'B') && !typing && curId) return serviceAct('build', curId);
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

// CPU, memória e, fora do celular, rede e disco: cada grupo inteiro numa linha, com o "·" no fim do anterior, para a
// quebra nunca começar uma linha com "·"
function usageLine(s: Stats, u: NonNullable<ReturnType<typeof usage>>, hs: Sample[]) {
  const extra = io(s), sep = (i: number) => i === 1 && extra.length ? '<span class="max-sm:hidden"> ·</span>' : i < 1 + extra.length ? ' ·' : '';
  const parts = [`<span class="text-fg-soft">${esc(u[0])}</span> ${spark(hs, 'cpu', 96, 20)}`, `<span class="text-fg-soft">${esc(u[1])}</span> ${spark(hs, 'mem', 96, 20)}`,
                 ...extra.map(x => `<span class="text-fg-soft" title="${t`Totais desde que o container subiu`}">${esc(x)}</span>`)];
  return parts.map((x, i) => `<span class="whitespace-nowrap${i > 1 ? ' max-sm:hidden' : ''}">${x}${sep(i)}</span>`).join(' ');
}

// status e ações do container dentro do modal: diagnosticar e agir sem sair dos logs
function renderDlg() {
  if (!$<HTMLDialogElement>('#dlg').open) return;
  if (logProject) {  // projeto inteiro: só a contagem; as ações ficam no cabeçalho do projeto
    const p = logProject.project, all = data.filter(c => project(c) === p), on = all.filter(c => c.State === 'running').length;
    $('#dlg-status').innerHTML = `<span class="text-muted">${all.length
      ? t`Projeto compose · ${on} de ${all.length} rodando · todos os serviços` : t`Este projeto não tem mais containers.`}</span>`;
    $('#dlg-acts').innerHTML = '';
    return;
  }
  const c = data.find(c => c.ID === logId);
  if (!c) {
    $('#dlg-status').innerHTML = `<span class="text-muted">${t`Este container não existe mais.`}</span>`;
    $('#dlg-acts').innerHTML = '';
    return;
  }
  const b = busy.get(c.ID), tn = TONE[b ? 'busy' : tone(c)], st = status(c, facts[tailKey(c)]);
  $('#procs').hidden = c.State !== 'running';  // docker top só com o container de pé
  const h = hasHealth(c) && health[c.ID + c.Status];
  if (hasHealth(c) && !h) loadHealth(c.ID);
  // uso de recursos com sparkline maior, e rede e disco, que não cabem na tabela
  const s = c.State === 'running' && !b ? stats[sid(c.ID)] : undefined, u = s && usage(s), hs = series.get(sid(c.ID)) ?? [];
  // uma linha para cada coisa: status, último healthcheck (inteiro no title) e uso, com rede e disco no fim (fora do celular)
  // depois de reiniciar daqui, o status diz quando foi: a marca no log só aparece se o container escrever algo novo
  const again = mark && c.State === 'running' && !b ? `<span class="text-muted"> · ${esc(mark.label)}</span>` : '';
  $('#dlg-status').innerHTML = `<span class="${tn[1]}">${b ? busyText(c, b) : esc(st[0])}</span>${st[1] && !b ? `<span class="text-muted"> · ${st[1]}</span>` : ''}${again}${b ? '' : errHtml(c)}${
    h ? `<div class="mt-1 text-xs text-muted sm:truncate" title="${esc(h)}"><span class="font-sans">${t`Último healthcheck:`}</span> <span class="text-fg-soft">${esc(h)}</span></div>` : ''}${
    s && u ? `<div id="dlg-usage" class="mt-1 text-xs text-muted">${usageLine(s, u, hs)}</div>` : ''}`;
  // Reiniciar à vista e primeiro (é o ciclo: reiniciar e ver o log novo), depois a ação principal; o resto no "⋯"
  // (remover fica na lista, onde a confirmação aparece)
  const prim = PRIMARY[c.State], sec = SECONDARY[c.State];
  const more = [sec && sec !== 'restart' && [sec, LABEL[sec]], c.State === 'running' && ['exec', t`Copiar docker exec`]].filter((x): x is [string, string] => !!x);
  $('#dlg-acts').innerHTML = (sec === 'restart' ? `<button data-id="dlg" data-a="restart" ${b ? 'aria-disabled="true"' : ''} aria-label="${t`Reiniciar ${esc(c.Names)}`}" title="${t`Reiniciar (r)`}"
      onclick="act('restart', '${c.ID}')" class="inline-flex items-center gap-1.5 ${BTN} text-fg hover:bg-hover">${RESTART_ICON}${t`Reiniciar`}</button>` : '') + (prim ? `<button data-id="dlg" data-a="${prim}" ${b ? 'aria-disabled="true"' : ''} aria-label="${LABEL[prim]} ${esc(c.Names)}" onclick="act('${prim}', '${c.ID}')"
      class="${BTN} ${prim === 'start' ? 'text-ok-fg hover:bg-ok/10' : 'text-fg hover:bg-hover'}">${LABEL[prim]}</button>` : '')
    + (more.length ? menuBox('dlg', t`Mais ações para ${esc(c.Names)} nos logs`, !!b, more.map(([a, text]) =>
      `<button data-id="dlg" data-a="m-${a}" ${b ? 'aria-disabled="true"' : ''} onclick="menuPick(this); ${a === 'exec' ? `copyExec('${c.ID}')` : `act('${a}', '${c.ID}')`}"
        class="${MENU_ITEM} text-fg">${text}</button>`).join('')) : '');
}

// histórico que o "Carregar mais" vai pedindo; o servidor só aceita estes (LOG_TAIL no docker_gui.py)
const TAILS = ['500', '2000', '10000', 'all'] as const;
// o ao vivo vai até 10000: o teto de linhas na tela tem que caber o histórico, e "tudo" ao vivo não teria teto
const LIVE_TAILS = 3;
// trecho que casou com o filtro
const MARK = 'rounded-sm bg-accent/30 text-fg-strong';  // o acento é a seleção; amarelo é aviso
// linhas carregadas (cada uma com o \n), que o filtro relê; ocorrências e linhas que casaram; tudo veio (log curto)
let tailAt = 0, buf: string[] = [], hits = 0, hitLines = 0, complete = false, streamOpen = false;

const fmt = (n: number) => n.toLocaleString(LOCALE);
// janela dos logs (--since, no servidor: LOG_SINCE no docker_gui.py); '' = o log inteiro
const SINCE_TXT: Record<string, string> = {start: t`desde que o container subiu`, '5m': t`dos últimos 5 min`, '15m': t`dos últimos 15 min`,
                                           '1h': t`da última hora`, '24h': t`das últimas 24 h`};
let since = '';
// o compose aplica o --tail em cada container do projeto
const hist = () => (TAILS[tailAt] === 'all' ? t`todas as linhas`
  : logProject ? t`últimas ${fmt(+TAILS[tailAt])} linhas de cada container` : t`últimas ${fmt(+TAILS[tailAt])} linhas`) + (since ? ` ${SINCE_TXT[since]}` : '');
const filterRe = () => logFilter($<HTMLInputElement>('#lf').value);
// nível e serviço: filtram na página, como o texto. level 'warn' = avisos e erros; svcPick = serviço do compose
let level = '', svcPick = '';
const narrowed = () => !!(level || svcPick);
// "api-1  | " -> "api" (as réplicas juntas), pelos nomes e labels dos containers do projeto (logServices), refeito a
// cada leitura da lista. Container que ainda não chegou à lista (acabou de subir): o "-<número>" no fim é a réplica
let svcNames: {d: Container[]; p: string; m: Map<string, string>} | null = null;
const svcOf = (prefix: string) => {
  const p = logProject?.project ?? '', name = prefix.replace(/\s.*$/s, '');
  if (svcNames?.d !== data || svcNames.p !== p) svcNames = {d: data, p, m: logServices(p, data)};
  return svcNames.m.get(name) ?? name.replace(/-\d+$/, '');
};
const passes = (pre: string, lv: LogLevel) =>
  (!svcPick || svcOf(pre) === svcPick) && (!level || lv === 'bad' || (level === 'warn' && lv === 'warn'));
// nível de cada linha, na ordem em que chegam: a que continua um stack trace herda o da linha que o abriu (nos logs do
// projeto, a de cima do mesmo container). Recomeça a cada pintura inteira e a cada conexão do ao vivo
let prevLv = new Map<string, LogLevel>();
function levelOf(pre: string, rest: string): LogLevel {
  const lv = continues(rest.replace(TS, '')) ? prevLv.get(pre) ?? '' : logLevel(rest);
  prevLv.set(pre, lv);
  return lv;
}
// serviços que apareceram nos logs do projeto, para o seletor (do prefixo, não dos labels: com container_name ele muda)
const svcSet = new Set<string>();
function seeSvcs(lines: string[]) {
  if (!logProject) return;
  const n = svcSet.size;
  for (const l of lines) { const pre = l.match(SVC_PREFIX)?.[0]; if (pre) svcSet.add(svcOf(pre)); }
  if (svcSet.size !== n) renderSvcs();
}
function renderSvcs() {
  const sv = $<HTMLSelectElement>('#lsvc');
  sv.hidden = !logProject;
  sv.replaceChildren(new Option(t`Todos os serviços`, ''), ...[...svcSet].sort().map(v => new Option(v, v)));
  sv.value = svcPick;
}
// trocar nível ou serviço redesenha a caixa com o que já veio; trocar o período pede de novo ao docker
function logPick() {
  level = $<HTMLSelectElement>('#llevel').value; svcPick = $<HTMLSelectElement>('#lsvc').value;
  paint();
}
function sinceChange() {
  since = $<HTMLSelectElement>('#lsince').value; complete = false;
  if (stream) toggleFollow(true); else fetchLogs();
}

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
// Réplicas (api-1, api-2) ficam com a cor do serviço, e a cor fica guardada por projeto: reabrir os logs não troca as cores
const svcSeen = new Map<string, string>(), svcCount = new Map<string, number>();
const svcTone = (prefix: string) => {
  const p = logProject?.project ?? '', key = `${p}/${svcOf(prefix)}`;
  if (!svcSeen.has(key)) {
    const n = svcCount.get(p) ?? 0;
    svcSeen.set(key, SVC_TONES[n % SVC_TONES.length]); svcCount.set(p, n + 1);
  }
  return svcSeen.get(key)!;
};

// cor da linha pelo nível (ERROR, WARN, DEBUG...); o resto fica na cor da caixa
const LEVEL_TONE = {bad: 'text-bad-fg', warn: 'text-warn-fg', dim: 'text-muted', '': ''};
const TS = /^\d{4}-\d\d-\d\dT\S+\s/;  // o --timestamps do docker logs

// a linha (com os trechos marcados, o prefixo do serviço colorido, o timestamp apagado e a cor do nível), ou null se o
// filtro não casou (aí nem entra na caixa). ponytail: um trecho que casa atravessando o prefixo ou o timestamp não conta
function hitNode(line: string, re: RegExp | null) {
  const pre = logProject ? line.match(SVC_PREFIX)?.[0] ?? '' : '', span = document.createElement('span');
  const rest = line.slice(pre.length), ts = rest.match(TS)?.[0] ?? '', level = levelOf(pre, rest);
  if (!passes(pre, level)) return null;
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
  const at = ts && new Date(ts.trim().replace(/(\.\d{3})\d+/, '$1'));
  if (at && !isNaN(+at)) {
    const el = part(ts.trimEnd(), 'text-[0px] text-muted before:content-[attr(data-t)] before:text-xs');
    el.dataset.t = at.toLocaleTimeString(LOCALE); el.title = ts.trim();
    part(ts.slice(ts.trimEnd().length), '');
  } else part(ts, 'text-muted');
  const lv = LEVEL_TONE[level];
  if (lv) part(rest.slice(ts.length), lv); else n += markInto(span, rest.slice(ts.length), re);
  if (re && !n) return null;
  if (re) hits += n;
  if (re || narrowed()) hitLines++;
  return span;
}
// até o teto do ao vivo, um nó por linha (para as cores); acima disso, texto cru, que pesa menos
const colored = () => buf.length <= 10000;
// qual linha de buf tem nó na caixa (passou nos filtros): o teto do ao vivo tira do começo só o que está na tela
let shown: boolean[] = [];

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
  const txt = filterRe() ? (hits
    ? t`${fmt(hits)} ${hits === 1 ? t`ocorrência` : t`ocorrências`} em ${fmt(hitLines)} ${hitLines === 1 ? t`linha` : t`linhas`}`
    : t`Nenhuma ocorrência`)
    : narrowed() ? (hitLines ? `${fmt(hitLines)} ${hitLines === 1 ? t`linha` : t`linhas`}` : t`Nenhuma linha`) : '';
  if ($('#lcount').textContent !== txt) $('#lcount').textContent = txt;  // é aria-live: só fala quando muda
}

// redesenha a caixa a partir de buf: sem filtro, o texto como veio; com filtro, só as linhas que casam.
// Ao vivo, um nó por linha (o teto tira do começo); parado, um texto só, que pesa menos com o log inteiro
function paint() {
  const lb = $('#lb'), re = filterRe(), atEnd = lb.scrollHeight - lb.scrollTop - lb.clientHeight < 40;
  hits = hitLines = 0; marked = false; prevLv = new Map(); shown = buf.map(() => true);
  if (buf.length && (re || narrowed() || stream || colored())) {  // sem linhas, a caixa tem um aviso ("(sem logs)", erro): fica
    // num fragment, um a um: espalhar o log inteiro em argumentos (replaceChildren(...)) estoura a pilha
    const frag = document.createDocumentFragment();
    buf.forEach((l, i) => {
      const m = markNode(l), n = re || narrowed() || colored() ? hitNode(l, re) : l;
      if (m) frag.append(m);
      if (n) frag.append(n); else shown[i] = false;
    });
    lb.replaceChildren(frag);
  } else if (buf.length) lb.textContent = buf.join('');
  renderHits();
  if (atEnd) lb.scrollTop = lb.scrollHeight;
}

// "Carregar mais": diz quanto vem. Sem mais o que pedir, aria-disabled (continua no Tab, como o Atualizar)
function renderMore() {
  const next = TAILS[tailAt + 1], b = $('#more');
  b.textContent = !next || complete ? t`Tudo carregado` : next === 'all' ? t`Carregar tudo` : t`Carregar ${fmt(+next)} linhas`;
  b.toggleAttribute('data-done', !next || complete);  // com tudo na caixa, vira texto (page.html)
  b.setAttribute('aria-disabled', String(!next || complete || (!!stream && tailAt + 1 >= LIVE_TAILS)));
}

// more: veio do "Carregar mais", com as linhas antigas entrando em cima; a tela fica parada nas mesmas linhas
async function fetchLogs(more = false) {
  const lb = $('#lb'), atEnd = lb.scrollHeight - lb.scrollTop - lb.clientHeight < 40;  // só gruda no fim se já estava lá
  const fromEnd = lb.scrollHeight - lb.scrollTop, tail = TAILS[tailAt], who = logProject ?? logId, win = since;
  try {
    const q = new URLSearchParams({...logProject, tail, ...(win ? {since: win} : {})});
    const r = await api(logProject ? `/api/compose/logs?${q}` : `/api/logs/${logId}?${q}`);
    const j: string = await r.json();
    // o ao vivo já conectou: ele é quem preenche a caixa. Conectando ainda (ou preso no limite de conexões do navegador),
    // a resposta entra: senão a caixa ficava em "Carregando…" até o stream abrir, se abrisse
    if (streamOpen) return;
    // já pediram outro container (ou projeto) ou mais histórico: vale a resposta nova
    if (who !== (logProject ?? logId) || tail !== TAILS[tailAt] || win !== since) return;
    buf = r.ok && j ? j.match(/[^\n]*\n|[^\n]+$/g)! : [];
    seeSvcs(buf);
    // menos linhas que o pedido: o log inteiro já está aqui (no projeto, o total abaixo do pedido também garante isso)
    complete = r.ok && (tail === 'all' || buf.length < +tail);
    if (buf.length) paint();
    else { lb.textContent = r.ok ? since ? t`Nada no log nesse período.` : t`(sem logs)` : t`Não consegui ler os logs: ${j}`; renderHits(); }
    $('#lmeta').textContent = t`${hist().replace(/^./, c => c.toUpperCase())} · atualizado às ${new Date().toLocaleTimeString(LOCALE)}`;
  } catch { buf = []; lb.textContent = t`Não consegui carregar os logs. O servidor do Stivo está rodando?`; }
  renderMore();
  if (more) lb.scrollTop = lb.scrollHeight - fromEnd;
  else if (atEnd) lb.scrollTop = lb.scrollHeight;
}

function openLogs(title: string, running: boolean) {
  tailAt = 0; buf = []; complete = false; mark = null;
  $('#lt').textContent = title;
  // cada container (ou projeto) começa sem filtro e com o log inteiro; "desde que subiu" é de um container só
  $<HTMLInputElement>('#lf').value = since = level = svcPick = '';
  $<HTMLSelectElement>('#llevel').value = $<HTMLSelectElement>('#lsince').value = '';
  $<HTMLOptionElement>('#lsince-start').hidden = $<HTMLOptionElement>('#lsince-start').disabled = !!logProject;
  svcSet.clear(); renderSvcs();
  $('#lb').textContent = t`Carregando…`; $('#lmeta').textContent = hist().replace(/^./, c => c.toUpperCase()); $('#dlg-msg').innerHTML = '';
  $('#insp').hidden = $('#hist').hidden = $('#procs').hidden = !!logProject;  // configuração, histórico e processos são de um container só
  renderHits(); renderMore();
  $<HTMLDialogElement>('#dlg').showModal(); renderDlg(); fetchLogs();
  $('#lb').focus();  // a caixa do log: as setas rolam, / vai para o filtro e r reinicia
  if (running && wantsFollow()) toggleFollow(true);  // ao vivo por padrão; desligado só para quem desligou da última vez
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
    if (stream && TAILS[tailAt + 1]) toast(t`Ao vivo, o histórico vai até ${fmt(+TAILS[LIVE_TAILS - 1])} linhas. Para carregar tudo, desligue o ao vivo.`);
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
  seeSvcs(add);
  // anexar (em vez de trocar o texto) não apaga a seleção de quem está copiando
  const nodes = add.map(l => [markNode(l), hitNode(l, re)]);
  shown.push(...nodes.map(([, n]) => !!n));
  lb.append(...nodes.flat().filter(n => !!n));
  // o teto vale para as linhas carregadas; na tela, com filtro, só as que passaram têm nó (a marca do reinício sai junto)
  const cut = Math.max(0, buf.length - Math.max(MAX_LINES, +TAILS[tailAt])), had = shown.splice(0, cut);
  buf.splice(0, cut).forEach((l, i) => {
    if (!had[i]) return;
    while ((lb.firstChild as HTMLElement | null)?.dataset?.mark) lb.firstChild!.remove();
    lb.firstChild!.remove();
    if (re) hits -= (l.split(re).length - 1) / 2;  // ponytail: conta também o que casar no prefixo ou no timestamp
    if (re || narrowed()) hitLines--;
  });
  if (re || narrowed()) renderHits();
  if (atEnd) lb.scrollTop = lb.scrollHeight;
}

// ao vivo: o docker logs -f em stream (SSE na web, Channel no desktop). Fechar o stream mata o processo no servidor
function toggleFollow(on = !stream, why = '') {
  const was = !!stream;
  stream?.close(); stream = null; streamOpen = false;
  if (was) flushLogs();  // o que já chegou entra antes de parar
  if (on) {
    tailAt = Math.min(tailAt, LIVE_TAILS - 1); complete = false;
    const q = {...logProject, tail: TAILS[tailAt], ...(since ? {since} : {})};
    stream = T.stream(logProject ? '/api/compose/logs/stream' : `/api/logs/${logId}/stream`, q, {
      // cada conexão (inclusive a reconexão automática) recomeça do histórico pedido: limpa para não duplicar
      open: () => {
        streamOpen = true;
        pending = []; buf = []; shown = []; prevLv = new Map(); hits = hitLines = 0; marked = false; $('#lb').textContent = ''; renderHits();
        $('#lmeta').textContent = t`Ao vivo · ${hist()} e as novas`;
      },
      data: line => { if (pending.push(JSON.parse(line)) === 1) setTimeout(flushLogs, 50); },
      end: () => toggleFollow(false, logProject ? t`os containers pararam` : t`o container parou`),
      // queda de rede: reconecta sozinho; closed é recusa do servidor (token, erro)
      error: closed => { if (closed) toggleFollow(false, t`falhou`); else $('#lmeta').textContent = t`Ao vivo · reconectando…`; },
    });
  } else if (was) $('#lmeta').textContent = t`Ao vivo parado às ${new Date().toLocaleTimeString(LOCALE)}${why ? ` · ${why}` : ''}`;
  $('#follow').setAttribute('aria-pressed', String(on));
  $('#refresh').setAttribute('aria-disabled', String(on));  // com o ao vivo ligado, Atualizar é redundante (mas continua no Tab)
  renderMore();
}

// botão Ao vivo: a escolha fica para os próximos logs (deste navegador); o ao vivo que cai sozinho não muda a escolha
function followClick() {
  toggleFollow();
  try { localStorage.setItem('docker-gui-follow', stream ? '1' : ''); } catch { /* aba privada: vale só agora */ }
}
const wantsFollow = () => { try { return localStorage.getItem('docker-gui-follow') !== ''; } catch { return true; } };

// botão Atualizar: com o ao vivo ligado não faz nada (já atualiza sozinho)
function refreshLogs() {
  if (!stream) fetchLogs();
}

function copyLogs() {
  navigator.clipboard.writeText($('#lb').textContent ?? '').then(() => toast(t`Logs copiados.`, true), () => toast(t`Não consegui copiar.`));
}

// o mesmo texto do select do "Novo container"
const RESTART_TXT: Record<string, string> = {no: t`não reinicia`, 'on-failure': t`se sair com erro`, 'unless-stopped': t`sempre, menos se você parar`, always: t`sempre`};
function inspectHtml(d: Inspect, reveal: boolean) {
  const list = (xs: string[], none = t`nenhum`) => xs.length ? xs.map(x => `<div>${x}</div>`).join('') : `<span class="font-sans text-muted">${none}</span>`;
  const nets = Object.entries(d.Networks).map(([n, ip]) => esc(ip ? `${n} · ${ip}` : n));
  const mounts = d.Mounts.map(m => esc(`${[m.Type, m.Name || m.Source].filter(Boolean).join(' ')} → ${m.Destination}${m.RW ? '' : t` (somente leitura)`}`));
  const env = d.Env.map(([k, v]) => `${esc(k)}=${v === null ? `<span aria-hidden="true">••••••</span><span class="sr-only">${t`(oculto)`}</span>` : esc(v)}`);
  const dt = 'font-sans text-muted';
  return `<dl class="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 font-mono text-fg-soft [overflow-wrap:anywhere]">
    <dt class="${dt}">Restart</dt><dd>${esc(d.Restart)}${RESTART_TXT[d.Restart.split(':')[0]] ? `<span class="font-sans text-muted"> · ${RESTART_TXT[d.Restart.split(':')[0]]}</span>` : ''}</dd>
    <dt class="${dt}">${t`Redes`}</dt><dd>${list(nets, t`nenhuma`)}</dd>
    <dt class="${dt}">Mounts</dt><dd>${list(mounts)}</dd>
    <dt class="${dt}">Env</dt><dd>${list(env, t`nenhuma`)}${d.Env.length ? `<button id="insp-env" onclick="loadInspect(${!reveal})"
      class="mt-1.5 ${BTN} font-sans text-fg hover:bg-hover">${reveal ? t`Ocultar valores` : t`Revelar valores`}</button>` : ''}</dd></dl>`;
}

// abrir o "Configuração" sempre busca mascarado; o valor real do env só vem pelo botão Revelar
async function loadInspect(reveal = false) {
  const id = logId, refocus = document.activeElement?.id === 'insp-env';
  let html: string;
  try {
    const r = await api(`/api/inspect/${id}${reveal ? '/env' : ''}`), j: unknown = await r.json();
    html = r.ok ? inspectHtml(j as Inspect, reveal) : esc(t`Não consegui ler o inspect: ${j}`);
  } catch { html = t`Não consegui ler o inspect.`; }
  if (id !== logId || !$<HTMLDetailsElement>('#insp').open) return;  // trocou de container ou fechou enquanto carregava
  $('#insp-body').innerHTML = html;
  if (refocus) $('#insp-env')?.focus();
}

// histórico do container: um resumo ("subiu 5× · caiu 4×") e a lista, do mais novo para o mais velho
function historyHtml(raw: HistoryEvent[]) {
  const evs = healthChanges(raw), today = new Date().toDateString();
  if (!evs.length) return `<p class="text-muted">${t`Nada nas últimas 24 h. O docker guarda só os eventos mais recentes.`}</p>`;
  const when = (s: number) => {
    const d = new Date(s * 1000);
    return d.toLocaleString(LOCALE, {...(d.toDateString() === today ? {} : {day: '2-digit', month: '2-digit'}), hour: '2-digit', minute: '2-digit', second: '2-digit'});
  };
  const sum = historySummary(evs);
  return `${sum ? `<p class="mb-1 text-fg-soft">${t`Desde ${when(evs[0].t)}: ${esc(sum)}`}</p>` : ''}<ol class="max-h-40 overflow-auto font-mono space-y-0.5">${
    [...evs].reverse().map(e => {
      const [txt, tn] = eventText(e);
      return `<li><span class="text-muted">${when(e.t)}</span> <span class="${TONE[tn][1]}">${esc(txt)}</span></li>`;
    }).join('')}</ol>`;
}

// abrir o "Histórico" ou o "Processos" consulta o docker na hora (fechar e abrir de novo relê)
async function loadHistory() {
  const id = logId;
  let html: string;
  try {
    const r = await api(`/api/history/${id}`), j: unknown = await r.json();
    html = r.ok ? historyHtml(j as HistoryEvent[]) : esc(t`Não consegui ler os eventos: ${j}`);
  } catch { html = t`Não consegui ler os eventos.`; }
  if (id !== logId || !$<HTMLDetailsElement>('#hist').open) return;
  $('#hist-body').innerHTML = html;
}
// a tabela do docker top, compacta: o comando (última coluna) quebra linha em vez de sair da tela
function topHtml(text: string) {
  const [head, ...rows] = topTable(text);
  if (!head) return `<p class="text-muted">${t`Nenhum processo.`}</p>`;
  const cell = (tag: string, v: string, i: number) => `<${tag} class="pr-3 py-0.5 align-top text-left font-normal${
    i === head.length - 1 ? ' [overflow-wrap:anywhere]' : ' whitespace-nowrap'}">${esc(v)}</${tag}>`;
  return `<table class="font-mono"><thead class="text-muted"><tr>${head.map((h, i) => cell('th', h, i)).join('')}</tr></thead>
    <tbody>${rows.map(r => `<tr>${r.map((v, i) => cell('td', v, i)).join('')}</tr>`).join('')}</tbody></table>`;
}
async function loadTop() {
  const id = logId;
  let html: string;
  try {
    const r = await api(`/api/top/${id}`), j: string = await r.json();
    html = r.ok ? topHtml(j) : esc(t`Não consegui ler os processos: ${j}`);
  } catch { html = t`Não consegui ler os processos.`; }
  if (id !== logId || !$<HTMLDetailsElement>('#procs').open) return;
  $('#procs-body').innerHTML = html;
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
  // fecha o "Configuração" (e o histórico e os processos) e apaga o que estava nele: env revelado não fica na página
  for (const k of ['insp', 'hist', 'procs']) { $('#' + k).removeAttribute('open'); $(`#${k}-body`).textContent = t`Carregando…`; }
  // a linha pode ter sido redesenhada com o modal aberto; foca o botão Logs atual dela (ou o do cabeçalho do projeto)
  document.querySelector<HTMLElement>(logProject ? `[data-id="${CSS.escape(`stack-${logProject.project}`)}"][data-a="plogs"]`
                                                 : `[data-id="${logId}"][data-a="logs"]`)?.focus();
}

// terminal no navegador: xterm.js <-> transporte (WebSocket ou IPC) <-> `docker exec` com TTY (num PTY do servidor ou, no Windows,
// aberto dentro do container)
const xtermCss = document.createElement('style');
xtermCss.textContent = XTERM_CSS;
document.head.append(xtermCss);
let sess: {id: string; term: Terminal; ws: Term; ro: ResizeObserver} | null = null;

function openShell(id: string) {
  const c = data.find(c => c.ID === id);
  if (!c) return;
  $('#shell-name').textContent = c.Names;
  $('#shell-status').textContent = t`Conectando…`;
  $<HTMLDialogElement>('#shell').showModal();
  const term = new Terminal({cursorBlink: true, fontSize: 13, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace'});
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.open($('#shell-box'));
  fit.fit();
  // a primeira mensagem tem que ser o tamanho: o servidor só sobe o docker exec depois dela
  const size = () => ws.resize(term.cols, term.rows);
  const ws = T.terminal(id, {
    open: () => { size(); $('#shell-status').textContent = t`Conectado. Esc vai para o terminal; feche pelo ×.`; term.focus(); },
    data: b => term.write(b),
    // aviso do servidor (no Windows, imagem sem TTY), que vai para o status
    notice: text => { $('#shell-status').textContent = text; },
    close: () => { $('#shell-status').textContent = t`Sessão encerrada.`; },
  });
  term.onData(d => ws.send(d));
  term.onResize(size);
  const ro = new ResizeObserver(() => fit.fit());
  ro.observe($('#shell-box'));
  sess = {id, term, ws, ro};
}

function closeShell() {
  if (!sess) return;
  const {id, term, ws, ro} = sess;
  sess = null;
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
  if (!creating) $('#create-go').textContent = runField('public').checked ? t`Criar e expor na rede` : t`Criar e iniciar`;
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
  go.textContent = t`Criando… (baixa a imagem se faltar)`;
  $<HTMLFieldSetElement>('#create-fields').disabled = true;
  $('#shown').textContent = t`Criando ${label}…`;
  let ok = false, msg: string;
  try {
    const r = await T.request('POST', '/api/run', spec);
    msg = await r.json(); ok = r.ok;
  } catch { msg = t`Sem resposta do servidor do Stivo.`; }
  creating = false;
  go.removeAttribute('aria-disabled');
  $<HTMLFieldSetElement>('#create-fields').disabled = false;
  createLabel();
  const shown = $<HTMLDialogElement>('#create').open;  // pode ter sido fechado durante o pull
  if (!ok) {
    // o formulário fica como estava, para corrigir e tentar de novo. O docker escreve o progresso do pull no
    // stderr: no aviso fora do modal vai só a última linha, que é a que explica
    if (shown) {
      $('#create-msg').innerHTML = `<p class="font-medium">${t`Não deu para criar ${esc(label)}.`}</p>${
        errHint(msg) ? `<p class="mt-1">${esc(errHint(msg))}</p>` : ''}
        <pre class="mt-1 whitespace-pre-wrap [overflow-wrap:anywhere] font-mono text-xs">${esc(msg || t`Erro sem mensagem.`)}</pre>`;
      go.focus();  // o Enter num campo desabilitado durante o envio deixaria o foco no <body>
    } else toast(t`Não deu para criar ${label}. ${errHint(msg) || msg.trim().split('\n').at(-1) || t`Erro sem mensagem.`}`);
    return load();  // run que falha no start (porta ocupada) deixa o container criado e parado
  }
  $<HTMLFormElement>('#create-form').reset(); markRunErrors({}); createLabel();
  if (shown) $<HTMLDialogElement>('#create').close();
  toast(t`${label} criado, conferindo se ficou de pé…`, true);
  await load();
  // o ps do docker traz o ID curto e o do podman, o inteiro; o run devolve o inteiro
  const c = data.find(c => msg.startsWith(c.ID));
  if (c) confirmUp([c.ID]); else toast(t`${label} criado.`, true);
}

type DiskKind = 'containers' | 'images' | 'volumes' | 'buildcache';
// [Type do docker system df, categoria da API de prune, rótulo, o que o prune apaga, aviso]. Containers parados ficam na
// aba Imagens, antes delas: são eles que seguram as imagens "em uso". O aviso deles e o dos volumes (sem -a no servidor)
// dizem quais saem, pela lista de cada um (containerNote, volumeNote)
const DISK: [string, DiskKind, string, string, string][] = [
  ['Containers', 'containers', t`Containers parados`, t`os containers parados`, t`Os logs deles se perdem; os volumes ficam.`],
  ['Images', 'images', t`Imagens`, t`as imagens que nenhum container usa`, t`Dá para baixar de novo.`],
  ['Local Volumes', 'volumes', t`Volumes`, t`os volumes que nenhum container usa`, t`Os dados deles se perdem.`],
  ['Build Cache', 'buildcache', t`Build cache`, t`o cache de build`, t`O próximo build fica mais lento.`]];
let disk: DiskUsage[] | string | null = null, diskBusy: DiskKind | '' = '';  // string = erro
const diskHtml: Record<string, string> = {};
const PODMAN = /^podman\b/.test(document.documentElement.dataset.cli ?? '');
// o volume prune diz exatamente o que leva, pela lista de volumes (no Docker só os anônimos, no Podman os nomeados também)
function volumeNote(): string {
  const vs = objs.volumes;
  if (!Array.isArray(vs)) return vs === null ? t`Conferindo quais volumes saem…` : t`Não consegui ler a lista de volumes; o prune leva os sem uso.`;
  const out = prunedVolumes(vs as Volume[], PODMAN), shown = out.slice(0, 10).map(v => anonVolume(v.Name) ? v.Name.slice(0, 12) + '…' : v.Name);
  return !out.length ? t`Nenhum volume sem uso para apagar.`
    : t`Vai apagar ${plural(out.length, PODMAN ? t`volume sem uso` : t`volume anônimo sem uso`, PODMAN ? t`volumes sem uso` : t`volumes anônimos sem uso`)}: ${
      shown.join(', ')}${out.length > 10 ? t` e mais ${out.length - 10}` : ''}. Os dados deles se perdem.` + (PODMAN ? '' : t` Os nomeados ficam.`);
}
// o container prune leva todo container que não está de pé (parado, criado, morto), pela lista que a página já tem
function containerNote(note: string): string {
  const out = data.filter(removable);
  return out.length ? t`Vai remover ${names(out, 10)}. ${note}` : t`Nenhum container parado para remover.`;
}
// quanto o prune libera e de quantos itens (do df), antes do que ele não desfaz
const pruneNote = (d: DiskUsage | undefined, note: string) => {
  const idle = d ? +d.TotalCount - +d.Active : 0;
  if (d?.Type === 'Local Volumes') return volumeNote();
  if (d?.Type === 'Containers') return containerNote(note);
  return d ? t`Libera até ${d.Reclaimable.split(' ')[0]}${idle > 0 ? t`, de ${plural(idle, t`item sem uso`, t`itens sem uso`)}` : ''}. ${note}` : note;
};

// abrir a aba (e depois de uma limpeza ou remoção) relê a lista dela e, se ela tem, o df
async function loadTab() {
  if (tab === 'containers') return;
  await Promise.all([...(tab === 'networks' ? [] : [loadDf()]), loadObjects(tab)]);
}

async function loadDf() {
  try {
    const r = await api('/api/df'), j: unknown = await r.json();
    disk = r.ok ? j as DiskUsage[] : t`Não consegui ler o uso de disco: ${j}`;
  } catch { disk = t`Não consegui ler o uso de disco. O servidor do Stivo está rodando?`; }
  render();
}

// build cache fica na aba Imagens: é o que o build deixa junto com elas
function renderDisk() {
  for (const panel of ['images', 'volumes'] as const) {
    const html = disk === null ? `<p class="py-3 text-muted">${t`Carregando…`}</p>`
      : typeof disk === 'string' ? `<p class="py-3 text-bad-fg">${esc(disk)}</p>`
      : DISK.filter(([, k]) => (k === 'volumes') === (panel === 'volumes')).map(([type, k, label]) => {
        const d = (disk as DiskUsage[]).find(d => d.Type === type), id = 'df-' + k, armed = arming?.id === id;
        if (!d) return '';
        // armado, o botão só fica marcado: o Confirmar está no pé da tela, e clicar aqui de novo cancela
        const cls = armed ? 'ring-bad/60 text-bad-fg hover:bg-bad/10' : 'text-fg hover:bg-hover', share = reclaimShare(d);
        // a barra é o total; a parte em ciano, na ponta, é o que a limpeza libera
        const bar = share === null ? '' : `<div aria-hidden="true" class="mt-1.5 h-1.5 w-full max-w-80 rounded-sm bg-line-strong overflow-hidden flex justify-end">
            <span class="h-full bg-accent" style="width:${Math.round(share * 100)}%"></span></div>`;
        return `<div class="flex flex-wrap items-center gap-x-3 gap-y-2 py-3">
          <div class="mr-auto min-w-0 flex-1"><div class="font-medium text-fg-strong">${label}</div>
            <div class="font-mono text-xs text-muted">${t`${esc(d.Size)} no total · ${esc(d.Reclaimable)} liberável · ${esc(d.TotalCount)} ${d.TotalCount === '1' ? t`item` : t`itens`}, ${esc(d.Active)} em uso`}</div>${bar}</div>
          <button data-id="${id}" data-a="prune" ${diskBusy ? 'aria-disabled="true"' : ''} onclick="prune('${k}')"
            aria-label="${t`Limpar ${label.toLowerCase()}`}" ${armed ? 'aria-expanded="true"' : ''} class="${BTN} ${cls}">${diskBusy === k ? t`Limpando…` : t`Limpar…`}</button>
        </div>`;
      }).join('');
    if (html !== diskHtml[panel]) $('#df-' + panel).innerHTML = diskHtml[panel] = html;  // o render roda a cada poll: só troca se mudou
  }
}

async function prune(k: DiskKind, sure = false): Promise<unknown> {
  const [type, , label, what, note] = DISK.find(d => d[1] === k)!, d = Array.isArray(disk) ? disk.find(d => d.Type === type) : undefined;
  if (k === 'volumes' && !Array.isArray(objs.volumes)) loadObjects('volumes');  // o aviso diz quais saem
  if (diskBusy) return;
  if (!sure) return arm('df-' + k, what, 'prune', pruneNote(d, note), () => prune(k, true));
  diskBusy = k; render();
  $('#shown').textContent = t`Limpando ${label.toLowerCase()}…`;
  try {
    const r = await T.request('POST', '/api/prune/' + k), msg: string = await r.json();
    // image/volume prune terminam em "Total reclaimed space: 1.2GB"; builder prune, em "Total: 1.2GB"
    const freed = msg.match(/Total(?: reclaimed space)?:\s*(\S+)/)?.[1];
    if (r.ok) toast(`${label}: ${freed ? t`${freed} liberados` : t`limpeza feita`}.`, true);
    else toast(t`Não deu para limpar ${label.toLowerCase()}: ${msg || t`erro sem mensagem`}`);
  } catch { toast(t`Sem resposta do servidor do Stivo.`); }
  diskBusy = '';
  await Promise.all([loadTab(), k === 'containers' && load()]);
}

// imagens, volumes e redes um a um: cada lista só vai ao docker quando a aba abre (e depois de uma remoção)
type ObjKind = 'images' | 'volumes' | 'networks';
type Obj = Image | Volume | Network;
const KINDS: ObjKind[] = ['images', 'volumes', 'networks'];
// [rota de /api/rm, com artigo, rótulo, plural, particípio, aviso da confirmação, lista vazia]
const OBJ: Record<ObjKind, [rm: string, one: string, label: string, many: string, done: string, note: string, none: string]> = {
  images: ['image', t`a imagem`, t`Imagem`, t`Imagens`, t`removida`, t`Dá para baixar de novo.`, t`Nenhuma imagem.`],
  volumes: ['volume', t`o volume`, t`Volume`, t`Volumes`, t`removido`, t`Os dados dele se perdem.`, t`Nenhum volume.`],
  networks: ['network', t`a rede`, t`Rede`, t`Redes`, t`removida`, '', t`Nenhuma rede.`]};
const objs: Record<ObjKind, Obj[] | string | null> = {images: null, volumes: null, networks: null};  // string = erro
const objHtml: Partial<Record<ObjKind, string>> = {}, objErr = new Map<string, string>();  // data-id -> erro da remoção
let objBusy = '';

// o que vai para a API (ID para imagem e rede, nome para volume) e o que aparece na tela
const objRef = (k: ObjKind, o: Obj) => k === 'volumes' ? (o as Volume).Name : (o as Image | Network).ID;
const anon = anonVolume;
const objName = (k: ObjKind, o: Obj) => k === 'images' ? (o as Image).Tags.join(', ') || t`sem tag ${(o as Image).ID.slice(0, 12)}`
  : anon((o as Volume | Network).Name) ? (o as Volume).Name.slice(0, 12) : (o as Volume | Network).Name;

async function loadObjects(k: ObjKind) {
  try {
    const r = await api('/api/' + k), j: unknown = await r.json();
    objs[k] = r.ok ? j as Obj[] : t`Não consegui ler a lista: ${j}`;
  } catch { objs[k] = t`Não consegui ler a lista. O servidor do Stivo está rodando?`; }
  render();
}

// colunas de cada lista, no ritmo do `docker images` / `docker volume ls` / `docker network ls`: [título, só leitor de tela no celular]
const OBJ_COLS: Record<ObjKind, string[]> = {images: [t`Imagem`, 'ID', t`Tamanho`, t`Criada`, t`Em uso por`],
  volumes: [t`Volume`, 'Driver', t`Tamanho`, t`Em uso por`], networks: [t`Rede`, 'Driver', t`Escopo`, t`Em uso por`]};
function objItem(k: ObjKind, o: Obj) {
  const r = objRef(k, o), id = `rm-${k}-${r}`, armed = arming?.id === id, what = `${OBJ[k][1]} ${objName(k, o)}`;
  const err = objErr.get(id), hint = err && errHint(err), tag = (t: string, title: string) =>
    `<span title="${title}" class="ml-1.5 font-normal text-muted">(${t})</span>`;
  // cells: HTML já escapado, na ordem de OBJ_COLS (sem o título)
  let title = esc(objName(k, o)), cells: string[];
  if (k === 'images') {
    const i = o as Image;
    if (!i.Tags.length) title = `${t`sem tag`}${tag('dangling', t`nenhuma tag aponta para ela`)}`;
    cells = [esc(i.ID.slice(0, 12)), esc(i.Size), i.Created ? t`há ${age(i.Created)}` : '—'];
  } else if (k === 'volumes') {
    const v = o as Volume;
    if (anon(v.Name)) title = `<span title="${esc(v.Name)}">${title}…</span>${tag(t`anônimo`, t`criado sem nome, por um container`)}`;
    cells = [esc(v.Driver), esc(v.Size || '—')];
  } else {
    const n = o as Network;
    if (n.Builtin) title += tag(t`padrão`, t`vem com o daemon e não pode ser removida`);
    cells = [esc(n.Driver), esc(n.Scope)];
  }
  cells.push(o.Containers.length ? `<span class="text-fg-soft">${esc(o.Containers.join(', '))}</span>` : t`nenhum container`);
  // rede padrão não remove; rede sem ID (formato antigo do podman) não tem como
  const canRm = k !== 'networks' || (!(o as Network).Builtin && !!(o as Network).ID);
  // em uso, o docker recusa o rm (sem -f): o botão diz por quê em vez de deixar tentar. A rede só segura com o container de pé
  const holds = k === 'networks' ? o.Containers.filter(n => data.some(c => c.Names === n && c.State === 'running')) : o.Containers;
  const held = holds.length ? esc(holds.join(', ')) : '';
  const cls = armed ? 'ring-bad/60 text-bad-fg hover:bg-bad/10' : 'text-fg hover:bg-hover';
  const cols = OBJ_COLS[k].slice(1);
  return `<tr class="border-t border-line/70 ${armed ? 'bg-bad/10' : ''} max-sm:block max-sm:py-3">
    <th scope="row" class="py-2.5 pl-4 pr-6 max-sm:block max-sm:p-0 max-sm:px-4 text-left font-normal align-top">
      <div class="font-mono text-data font-semibold text-fg-strong [overflow-wrap:anywhere]">${title}</div>
      ${err ? `<div class="mt-1 [contain:inline-size] max-sm:[contain:none] text-xs text-bad-fg">${hint ? `<p class="font-sans">${hint}</p>` : ''}
        <pre class="mt-1 whitespace-pre-wrap [overflow-wrap:anywhere] font-mono text-bad-soft">${esc(err)}</pre></div>` : ''}</th>
    ${cells.map((c, i) => `<td class="py-2.5 pr-4 max-sm:block max-sm:p-0 max-sm:px-4 align-top font-mono text-xs leading-5 text-muted [overflow-wrap:anywhere]"><span class="sm:sr-only">${cols[i]}: </span>${c}</td>`).join('')}
    <td class="py-2 pr-4 max-sm:block max-sm:p-0 max-sm:px-4 max-sm:pt-2 align-top"><div class="flex justify-end max-sm:justify-start items-center gap-1.5">${!canRm ? '' : held
      ? `<button data-id="${esc(id)}" data-a="rm" aria-disabled="true" aria-label="${t`Remover (indisponível: em uso por ${held})`}"
      title="${k === 'networks' ? t`Em uso por ${held}: pare o container antes` : t`Em uso por ${held}: remova o container antes`}" class="${BTN} text-muted cursor-not-allowed">${t`Remover…`}</button>`
      : `<button data-id="${esc(id)}" data-a="rm" data-k="${k}" data-r="${esc(r)}" ${objBusy ? 'aria-disabled="true"' : ''} ${armed ? 'aria-expanded="true"' : ''}
      onclick="rmObj(this.dataset.k, this.dataset.r)" aria-label="${t`Remover ${esc(what)}`}"
      class="${BTN} ${cls}">${objBusy === id ? t`Removendo…` : t`Remover…`}</button>`}</div></td></tr>`;
}

// quantos o docker system df conta na categoria (redes não entram no df)
const dfCount = (k: ObjKind) => Array.isArray(disk) ? +(disk.find(d => d.Type === {images: 'Images', volumes: 'Local Volumes', networks: ''}[k])?.TotalCount ?? 0) : 0;

function renderObjects() {
  for (const k of KINDS) {
    const v = objs[k];
    const html = v === null ? `<p class="py-3 text-muted">${t`Carregando…`}</p>`
      : typeof v === 'string' ? `<p class="py-3 text-bad-fg">${esc(v)}</p>`
      : !v.length ? `<p class="py-3 px-4 text-muted">${OBJ[k][6]}${dfCount(k) ? t` O docker system df conta ${dfCount(k)}: a lista pode ter vindo antes do df. Troque de aba e volte para ler de novo.` : ''}</p>`
      : `<table aria-label="${OBJ[k][3]}" class="w-full text-left max-sm:block"><thead class="max-sm:hidden font-mono text-[11px] uppercase text-muted"><tr>${
        OBJ_COLS[k].map((h, i) => `<th scope="col" class="py-3 ${i ? '' : 'pl-4 '}pr-4 font-medium">${h}</th>`).join('')}<th scope="col" class="pr-4"><span class="sr-only">${t`Ações`}</span></th></tr></thead>
        <tbody class="max-sm:block">${v.map(o => objItem(k, o)).join('')}</tbody></table>`;
    if (html !== objHtml[k]) $(`#obj-${k}-list`).innerHTML = objHtml[k] = html;  // o render roda a cada poll
    $(`#obj-${k}-n`).textContent = Array.isArray(v) ? ` · ${v.length}` : '';
  }
}

// docker image/volume/network rm, com a confirmação em 2 passos. Em uso, o docker recusa e o erro fica no item
async function rmObj(k: ObjKind, r: string, sure = false): Promise<unknown> {
  const list = objs[k], o = Array.isArray(list) ? list.find(o => objRef(k, o) === r) : undefined;
  if (!o || objBusy) return;
  const id = `rm-${k}-${r}`, [rm, one, label, , done, note] = OBJ[k], name = objName(k, o);
  if (!sure) return arm(id, `${one} ${name}`, 'rm', note, () => rmObj(k, r, true));
  const btns = [...document.querySelectorAll<HTMLElement>(`#obj-${k}-list [data-a="rm"]`)], i = btns.findIndex(b => b.dataset.id === id);
  const near = (btns[i + 1] || btns[i - 1])?.dataset.id;
  objErr.delete(id); objBusy = id; render();
  $('#shown').textContent = t`Removendo ${one} ${name}…`;
  let ok = false;
  try {
    const res = await T.request('POST', `/api/rm/${rm}/${encodeURIComponent(r)}`), msg: string = await res.json();
    ok = res.ok;
    if (ok) toast(`${label} ${name} ${done}.`, true);
    else {
      objErr.set(id, msg || t`erro sem mensagem`);
      toast(t`Não deu para remover ${one} ${name}. ${errHint(msg) || t`O erro ficou na lista.`}`);
    }
  } catch { toast(t`Sem resposta do servidor do Stivo.`); }
  objBusy = '';
  await loadTab();  // imagem e volume mudam o df também
  if (ok) (document.querySelector<HTMLElement>(`[data-id="${near}"][data-a="rm"]`) || $('#tab-' + k)).focus();
}

// o HTML gerado chama estas funções pelo nome (onclick="act(...)"); com módulos nada é global, então
// esta lista é a interface completa entre o HTML e o código
Object.assign(window, {
  ackFail, act, afterClose, askNotify, confirmArm, bulkAct, clearFilters, clearSel, closeOut, composeAct, copyAddr, copyExec, copyLogs, disarm, downloadLogs,
  filterBy, followClick, loadHealth, loadHistory, loadInspect, loadMore, loadTop, logPick, menuPick, openCreate, openShell, pickTab, placeMenu, projectLogs,
  prune, refreshLogs, rmObj, serviceAct, runToastAction, selectAll, sinceChange, stackAct, toggleSel,
});

$('#dlg').addEventListener('close', afterClose);
$('#shell').addEventListener('close', closeShell);
$('#shell').addEventListener('cancel', e => e.preventDefault());
// a barra de lote flutua embaixo: o toast sobe acima dela e a página ganha a mesma folga, para a última linha não ficar atrás
// e a confirmação armada (#armdock) fica acima da barra de lote: --bulk é a altura dela, --dock a das duas
const docks = new ResizeObserver(() => {
  const b = $('#bulk').offsetHeight, d = $('#armdock').offsetHeight, root = document.documentElement.style;
  root.setProperty('--bulk', `${b && b + 8}px`);
  root.setProperty('--dock', `${(b && b + 8) + (d && d + 8)}px`);
});
docks.observe($('#bulk')); docks.observe($('#armdock'));
$('#tabs').addEventListener('keydown', tabKey);
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
// voltar/avançar do navegador: a URL manda na aba e nos filtros
addEventListener('popstate', () => {
  // link novo colado nesta aba (#t=..., depois de reiniciar o servidor): só o carregamento lê o token
  if (new URLSearchParams(location.hash.slice(1)).has('t')) return location.reload();
  disarm(false); readHash(); showTab();
});
readHash(); showTab(); load(); connectEvents(); statsLoop();
// o tique é sempre de 2 s; com o stream de eventos no ar, só consulta se a última consulta tem mais de 30 s
setInterval(() => { if (watching() && Date.now() - lastLoad > (live ? POLL_LIVE : POLL) - 500) load(); }, POLL);
