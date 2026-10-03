import {
  type Bucket, type Container, type ContainerState, type Port, type Tone,
  bucket, esc, hasHealth, isProblem, ports, project, shortImage, status, tone,
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
type MenuAction = Action | 'exec' | 'shell';
type ProblemKind = 'docker' | 'perm' | 'server' | 'auth';
// [título, dica (HTML confiável), detalhe técnico, tipo]
type Problem = [title: string, hint: string, detail: unknown, kind: ProblemKind];
type ToastAction = [label: string, fn: () => unknown];
type RowError = {msg: string; state: ContainerState; what: string};
type Arming = {id: string; name: string; at: number; timer: number};
type Health = {Log?: {ExitCode: number; Output: string}[]} | null;
// linha da tabela com o HTML que a gerou, para o patchRows saber se mudou
type Row = HTMLElement & {_html?: string};

const LABEL: Record<RowAction, string> = {start: 'Iniciar', stop: 'Parar', restart: 'Reiniciar', pause: 'Pausar', unpause: 'Retomar', logs: 'Logs', remove: 'Remover'};
const VERB: Record<Action, string> = {start: 'Iniciando…', stop: 'Parando…', restart: 'Reiniciando…', pause: 'Pausando…', unpause: 'Retomando…', remove: 'Removendo…'};
const DONE: Record<Action, string> = {start: 'iniciado', stop: 'parado', restart: 'reiniciado', pause: 'pausado', unpause: 'retomado', remove: 'removido'};
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
let data: Container[] = [], busy = new Map<string, Action>(), errors = new Map<string, RowError>(), lastOk: Date | null = null,
    problem = '', problemKind: ProblemKind | '' = '', only: Bucket | '' = '',
    toastTimer: number | undefined, logId: string | null = null, follow: number | null = null, arming: Arming | null = null,
    lastSay = '', dirty = false;

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
  $('#table').inert = !!p;  // dados velhos não aceitam clique
  if (p) $('#banner').innerHTML = `<p class="font-medium text-warn-strong">${p[0]}</p>
    <p class="mt-0.5 text-warn-soft">${p[1]}</p>
    <details class="mt-2 text-xs text-warn-soft"><summary class="cursor-pointer w-fit py-1 max-lg:py-3.5 rounded focus-visible:outline-2 focus-visible:outline-accent">Detalhes técnicos</summary>
    <pre class="mt-1 whitespace-pre-wrap [overflow-wrap:anywhere] font-mono">${esc(p[2])}</pre></details>`;
  renderCount();
  if (!lastOk) render();
}

async function load() {
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
      if (selectingRows()) dirty = true; else render();
    }
    showProblem(null);
  } catch (e) {
    showProblem([lastOk ? 'O servidor do Docker GUI parou de responder.' : 'Não consegui conectar ao servidor do Docker GUI.',
      'Rode <code class="font-mono">python3 docker_gui.py</code> de novo; a página volta sozinha.', (e as Error).message, 'server']);
  }
}

function renderCount() {
  const n = (k: Bucket) => data.filter(c => bucket(c) === k).length, running = data.filter(c => c.State === 'running').length;
  const problemTxt = problemKind ? PROBLEM_TXT[problemKind] : '';
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
  const sig = JSON.stringify([c, withProject, busy.get(c.ID), arming?.id === c.ID, errors.get(c.ID), health[c.ID + c.Status], TOUCH]);
  const hit = rowCache.get(c.ID);
  if (hit?.sig === sig) return hit.html;
  const html = rowHtml(c, withProject);
  rowCache.set(c.ID, {sig, html});
  return html;
}

function rowHtml(c: Container, withProject: boolean) {
  const b = busy.get(c.ID), t = TONE[b ? 'busy' : tone(c)], st = status(c), pp = ports(c.Ports), p = project(c);
  const armed = arming?.id === c.ID, prim = PRIMARY[c.State], sec = SECONDARY[c.State];
  const slot = (w = 'lg:w-20') => `<span aria-hidden="true" class="${w} shrink-0 max-lg:hidden"></span>`;
  const btn = (a: RowAction, cls = 'text-fg hover:bg-hover', text = LABEL[a], aria = `${LABEL[a]} ${esc(c.Names)}`) =>
    `<button data-id="${c.ID}" data-a="${a}" ${b && a !== 'logs' ? 'aria-disabled="true"' : ''}
      aria-label="${aria}" aria-describedby="st-${c.ID}" onclick="act('${a}','${c.ID}')" class="lg:w-20 shrink-0 ${BTN} ${cls}">${text}</button>`;
  // ações raras (reiniciar, pausar, remover, exec) ficam no "⋯": a linha mostra só a ação principal e Logs
  const more = [sec && [sec, LABEL[sec]], c.State === 'running' && ['pause', 'Pausar'],
                c.State === 'running' && ['shell', 'Abrir terminal'], c.State === 'running' && ['exec', 'Copiar docker exec'],
                removable(c) && ['remove', 'Remover…']].filter((x): x is [MenuAction, string] => !!x);
  const item = 'block w-full text-left px-3 py-2 max-lg:py-3 rounded-md text-sm hover:bg-hover focus-visible:outline-2 focus-visible:outline-accent';
  const menu = !more.length ? slot('lg:w-9') : `<details data-keep="menu" class="shrink-0" ontoggle="placeMenu(this)">
      <summary data-id="${c.ID}" data-a="menu" aria-label="Mais ações para ${esc(c.Names)}" ${b ? 'aria-disabled="true"' : ''}
        class="list-none [&::-webkit-details-marker]:hidden cursor-pointer grid place-items-center lg:w-9 max-lg:w-11 ${BTN} text-fg hover:bg-hover">
        <svg aria-hidden="true" viewBox="0 0 16 16" fill="currentColor" class="size-4"><circle cx="3.5" cy="8" r="1.3"/><circle cx="8" cy="8" r="1.3"/><circle cx="12.5" cy="8" r="1.3"/></svg></summary>
      <div class="fixed z-30 min-w-48 rounded-lg bg-raised ring-1 ring-line-strong p-1 shadow-lg shadow-black/40">
        ${more.map(([a, text]) => `<button data-id="${c.ID}" data-a="m-${a}" ${b ? 'aria-disabled="true"' : ''} onclick="menuPick(this); ${a === 'exec' ? `copyExec('${c.ID}')` : a === 'shell' ? `openShell('${c.ID}')` : `act('${a}','${c.ID}')`}"
          class="${item} ${a === 'remove' ? 'text-bad-fg' : 'text-fg'}">${text}</button>`).join('')}
      </div></details>`;
  const healthBox = hasHealth(c) && !b ? `<details data-keep="health" class="mt-1 text-xs" ontoggle="this.open && loadHealth('${c.ID}')">
      <summary class="cursor-pointer w-fit py-1 max-lg:py-3.5 rounded focus-visible:outline-2 focus-visible:outline-accent text-muted hover:text-fg">Ver último healthcheck</summary>
      <pre class="mt-1 whitespace-pre-wrap [overflow-wrap:anywhere] font-mono text-fg-soft">${esc(health[c.ID + c.Status] || 'Carregando…')}</pre></details>` : '';
  return `<tr data-row data-key="c:${c.ID}" role="row" class="border-t border-line/70 hover:bg-raised/70 transition motion-reduce:transition-none max-lg:block max-lg:px-4 max-lg:py-4 max-lg:space-y-1.5">
    <th role="rowheader" scope="row" class="py-3 pl-4 pr-6 max-lg:block max-lg:p-0 text-left font-normal"><div class="flex items-center gap-3">
      <span aria-hidden="true" class="size-2 shrink-0 rounded-full ${t[0]}"></span>
      <div class="min-w-0"><div class="font-medium text-fg-strong lg:truncate lg:max-w-[24ch]" title="${esc(c.Names)}">${esc(c.Names)}</div>
           <div class="text-xs font-mono text-muted">${c.ID.slice(0, 12)}${withProject && p ? `<span class="font-sans"> · ${esc(p)}</span>` : ''}</div></div></div></th>
    <td role="cell" class="font-mono text-xs text-muted pr-4 max-lg:block max-lg:p-0 max-lg:pl-5 [overflow-wrap:anywhere]">
      <span class="sr-only lg:hidden">Imagem: </span><div class="lg:truncate lg:max-w-[24ch] lg:[direction:rtl] lg:text-left" title="${esc(c.Image)}"><bdi dir="ltr">${esc(shortImage(c.Image))}</bdi></div></td>
    <td role="cell" class="text-sm pr-4 lg:min-w-[24ch] max-lg:block max-lg:p-0 max-lg:pl-5" title="${esc(c.Status)}">
      <span id="st-${c.ID}" class="${t[1]}">${b ? VERB[b] : esc(st[0])}${st[1] && !b ? `<span class="block text-xs text-muted">${st[1]}</span>` : ''}</span>${b ? '' : errHtml(c) + healthBox}</td>
    <td role="cell" class="pr-4 max-lg:hidden max-lg:has-[div]:block max-lg:p-0 max-lg:pl-5 max-lg:pt-1">${pp.length
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
  const anyBusy = all.some(c => busy.has(c.ID));
  const inBand = all.filter(isProblem).length;
  const sbtn = (a: Action, n: number, text: string) => k && n ? `<button data-id="stack-${esc(k)}" data-a="${a}" data-p="${esc(k)}" ${anyBusy ? 'aria-disabled="true"' : ''}
      aria-label="${text} do projeto ${esc(k)} (${n})" title="${esc(stackList(a, k).map(c => c.Names).join(', '))}" onclick="stackAct('${a}', this.dataset.p)" class="${BTN} text-fg hover:bg-hover normal-case tracking-normal">${text} (${n})</button>` : '';
  return `<tr data-key="g:${esc(k)}" role="row" class="max-lg:block"><th role="columnheader" colspan="5" scope="colgroup" class="max-lg:block px-4 pt-5 pb-2 text-left font-normal border-t border-line/70">
    <div class="flex flex-wrap items-center gap-x-3 gap-y-2">
      <span class="text-xs font-medium uppercase tracking-wider text-fg">${label}</span>
      ${k ? `<span class="text-xs text-muted">compose · ${on} de ${all.length} rodando</span>` : ''}
      ${k && inBand ? `<span class="text-xs text-bad-fg">${inBand} na faixa de atenção ↑</span>` : ''}
      <span class="ml-auto flex flex-wrap gap-1.5">${STACK.map(([a, text]) => sbtn(a, stackList(a, k).length, text)).join('')}</span>
    </div></th></tr>`;
}

function render() {
  const q = $<HTMLInputElement>('#q').value.trim().toLowerCase();
  // ordem alfabética estável: a linha não sai de baixo do cursor depois de uma ação;
  // a triagem fica na faixa "Precisa de atenção", o resto agrupado por projeto compose
  const rows = data.filter(c => (!only || bucket(c) === only) && [c.Names, c.Image, project(c)].join(' ').toLowerCase().includes(q))
                   .sort((a, b) => a.Names.localeCompare(b.Names));
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
      : !data.length ? 'Nenhum container ainda. Crie um com <code class="font-mono">docker run</code>.'
      : `Nenhum container ${label}${q ? `corresponde a “${esc(q)}”` : 'agora'}.`}</td></tr>`]);
  dirty = false;
  renderCount();
  renderDlg();
  if (f?.id) refocus(f.id, f.a);
  saveHash();
  // só escreve na região viva quando a mensagem muda, para não apagar o anúncio de uma ação em andamento
  const say = arming ? `Clique em Confirmar para apagar ${arming.name} de vez. Os volumes não são afetados. ${TOUCH ? 'Cancela sozinho em 8 segundos.' : 'Esc cancela.'}`
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
  if (a === 'remove' && arming?.id !== id) {  // 1º clique só arma; o 2º confirma
    disarm(false);
    arming = {id, name: c.Names, at: Date.now(), timer: setTimeout(armTick, 8000)}; render();
    return;
  }
  if (a === 'remove' && arming && Date.now() - arming.at < 600) return;  // duplo clique não pode virar confirmação
  if (a === 'remove') disarm(false);
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
const stackList = (a: Action, p: string, ids?: string[]) => data.filter(c => project(c) === p && (ids ? ids.includes(c.ID)
  : a === 'start' ? PRIMARY[c.State] === 'start' : a === 'restart' ? c.State === 'running' : STOPPABLE.includes(c.State)));

function copyExec(id: string) {
  const cmd = `docker exec -it ${data.find(c => c.ID === id)!.Names} sh`;
  navigator.clipboard.writeText(cmd).then(() => toast(`Copiado: ${cmd}`, true), () => toast(`Não consegui copiar. O comando é: ${cmd}`));
}

// ids: limita a ação a containers específicos (usado pelo "Iniciar de novo" depois de um Parar tudo)
async function stackAct(a: Action, p: string, ids?: string[]) {
  const list = stackList(a, p, ids);
  if (!list.length || list.some(c => busy.has(c.ID))) return;
  const all = Promise.all(list.map(c => run(a, c)));
  $('#shown').textContent = `${VERB[a]} ${list.length} containers de ${p}`;
  const res = await all, fails = res.filter(ok => !ok).length, okIds = list.filter((c, i) => res[i] && c.State !== 'paused').map(c => c.ID);
  if (fails) toast(`${p}: ${fails} de ${list.length} ${fails === 1 ? 'falhou' : 'falharam'}. ${fails === 1 ? 'O erro ficou na linha' : 'Os erros ficaram nas linhas'}.`);
  else if (a === 'stop') toast(`${p}: ${list.length} parados.`, true, okIds.length ? ['Iniciar de novo', () => stackAct('start', p, okIds)] : null);
  else toast(`${p}: ${list.length} ${a === 'start' ? 'iniciados' : 'reiniciados'}, conferindo se ficaram de pé…`, true);
  if (!fails && UP.includes(a)) return confirmUp(okIds);
  load();
}

// desarma sozinho depois de 8s, mas nunca enquanto o mouse ou o foco estão no botão (WCAG 2.2.1)
function armTick() {
  if (!arming) return;
  const el = document.querySelector(`[data-id="${arming.id}"][data-a="remove"]`);
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
  if ($<HTMLDialogElement>('#dlg').open || $<HTMLDialogElement>('#shell').open || e.ctrlKey || e.metaKey || e.altKey) return;
  const el = document.activeElement as HTMLElement, typing = /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName);
  if (e.key === '/' && !typing) { e.preventDefault(); return $('#q').focus(); }
  if ((e.key === 'z' || e.key === 'Z') && !typing && toastFn) return runToastAction();
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
  const c = data.find(c => c.ID === logId);
  if (!c) {
    $('#dlg-status').innerHTML = '<span class="text-muted">Este container não existe mais.</span>';
    $('#dlg-acts').innerHTML = '';
    return;
  }
  const b = busy.get(c.ID), t = TONE[b ? 'busy' : tone(c)], st = status(c);
  const h = hasHealth(c) && health[c.ID + c.Status];
  if (hasHealth(c) && !h) loadHealth(c.ID);
  $('#dlg-status').innerHTML = `<span class="${t[1]}">${b ? VERB[b] : esc(st[0])}</span>${st[1] && !b ? `<span class="text-muted"> · ${st[1]}</span>` : ''}${b ? '' : errHtml(c)}${
    h ? `<div class="mt-1 text-xs text-muted">Último healthcheck: <span class="font-mono text-fg-soft">${esc(h)}</span></div>` : ''}`;
  $('#dlg-acts').innerHTML = [PRIMARY[c.State], SECONDARY[c.State]].filter((a): a is Action => !!a).map(a =>
    `<button data-id="dlg" data-a="${a}" ${b ? 'aria-disabled="true"' : ''} aria-label="${LABEL[a]} ${esc(c.Names)}" onclick="act('${a}', '${c.ID}')"
      class="${BTN} ${a === 'start' ? 'text-ok-fg hover:bg-ok/10' : 'text-fg hover:bg-hover'}">${LABEL[a]}</button>`).join('')
    + (c.State === 'running' ? `<button data-id="dlg" data-a="exec" onclick="copyExec('${c.ID}')" class="${BTN} text-fg hover:bg-hover">Copiar docker exec</button>` : '');
}

async function fetchLogs(force = false) {
  const lb = $('#lb'), sel = getSelection();
  if (!force && sel?.toString() && lb.contains(sel.anchorNode)) return;  // não apaga a seleção de quem está copiando
  const atEnd = lb.scrollHeight - lb.scrollTop - lb.clientHeight < 40;  // só gruda no fim se já estava lá
  try {
    const r = await api('/api/logs/' + logId), j: string = await r.json();
    lb.textContent = r.ok ? j || '(sem logs)' : `Não consegui ler os logs: ${j}`;
    $('#lmeta').textContent = `Últimas 500 linhas · atualizado às ${new Date().toLocaleTimeString('pt-BR')}`;
  } catch { lb.textContent = 'Não consegui carregar os logs. O servidor do Docker GUI está rodando?'; }
  if (atEnd) lb.scrollTop = lb.scrollHeight;
}

function logs(id: string) {
  logId = id;
  $('#lt').textContent = data.find(c => c.ID === id)!.Names;
  $('#lb').textContent = 'Carregando…'; $('#lmeta').textContent = 'Últimas 500 linhas'; $('#dlg-msg').innerHTML = '';
  $<HTMLDialogElement>('#dlg').showModal(); renderDlg(); fetchLogs(true);
}

function toggleFollow(on = !follow) {
  clearInterval(follow ?? undefined); follow = on ? setInterval(() => document.hidden || fetchLogs(), 2000) : null;
  $('#follow').setAttribute('aria-pressed', String(on));
  $('#refresh').setAttribute('aria-disabled', String(on));  // com o ao vivo ligado, Atualizar é redundante (mas continua no Tab)
  if (on) fetchLogs();  // sem forçar: ligar o ao vivo não pode apagar uma seleção
}

// botão Atualizar: com o ao vivo ligado não faz nada (já atualiza sozinho)
function refreshLogs() {
  if (!follow) fetchLogs(true);
}

function copyLogs() {
  navigator.clipboard.writeText($('#lb').textContent ?? '').then(() => toast('Logs copiados.', true), () => toast('Não consegui copiar.'));
}

// roda no × direto e também no evento close (Esc); chamar duas vezes não faz mal
function afterClose() {
  toggleFollow(false);
  // a linha pode ter sido redesenhada com o modal aberto; foca o botão Logs atual dela
  document.querySelector<HTMLElement>(`[data-id="${logId}"][data-a="logs"]`)?.focus();
}

// terminal no navegador: xterm.js <-> WebSocket <-> `docker exec -it` num PTY do servidor
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
  ws.onmessage = e => term.write(new Uint8Array(e.data));
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

// o HTML gerado chama estas funções pelo nome (onclick="act(...)"); com módulos nada é global, então
// esta lista é a interface completa entre o HTML e o código
Object.assign(window, {
  act, afterClose, clearFilters, copyAddr, copyExec, copyLogs, filterBy, loadHealth, menuPick, openShell, placeMenu,
  refreshLogs, runToastAction, stackAct, toggleFollow,
});

$('#dlg').addEventListener('close', afterClose);
$('#shell').addEventListener('close', closeShell);
$('#shell').addEventListener('cancel', e => e.preventDefault());  // Esc é do vim/less, não do modal
$<HTMLInputElement>('#q').oninput = render;
// aba escondida não consulta o docker; ao voltar, atualiza na hora
document.addEventListener('visibilitychange', () => document.hidden || load());
readHash(); render(); load(); setInterval(() => document.hidden || load(), 2000);
