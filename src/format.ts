// Funções puras que traduzem a saída do docker para a tela. Não tocam no DOM: o app.ts importa daqui,
// e os testes (tests/format.test.mjs) carregam este arquivo direto no Node, que remove os tipos sozinho.
import {LANG, t} from './i18n.ts';

// estados do `docker ps`; "removing" é transitório e cai no "parado"
export type ContainerState = 'created' | 'restarting' | 'running' | 'removing' | 'paused' | 'exited' | 'dead';

// uma linha do `docker ps --format '{{json .}}'`, só com os campos que a página lê
export interface Container {
  ID: string;
  Names: string;
  Image: string;
  State: ContainerState;
  Status: string;
  Ports: string;
  Labels: string;
}

// uma linha do `docker system df --format '{{json .}}'`; os tamanhos já vêm formatados ("4.01GB", "165MB (14%)")
export interface DiskUsage {
  Type: string;
  TotalCount: string;
  Active: string;
  Size: string;
  Reclaimable: string;
}

export type Tone ='ok' | 'check' | 'warn' | 'busy' | 'bad' | 'pause' | 'off';
export type Bucket = 'problema' | 'rodando' | 'pausado' | 'reiniciando' | 'parado';
// [texto, dica opcional]
export type StatusText = [text: string, hint?: string];
// [porta do host, porta do container, protocolo]; em faixa longa, as duas portas vêm como "h1-h2"
export type Port = [host: string, container: string, proto: string];

export const esc = (s: unknown): string => String(s).replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);

export const EXIT: Record<number, string> = {
  1: t`erro da aplicação (veja o log)`, 125: t`falha do próprio docker run`, 126: t`comando sem permissão de execução`,
  127: t`comando não encontrado`, 137: t`morto à força ou sem memória (OOM)`, 139: t`falha de segmentação`,
  143: t`encerrado por SIGTERM`,
};
// [singular, plural]
const UNIT: Record<string, [string, string]> = {second: ['s', 's'], minute: ['min', 'min'], hour: ['h', 'h'], day: ['d', 'd'],
  week: [t`sem`, t`sem`], month: [t`mês`, t`meses`], year: [t`ano`, t`anos`]};

export const restartCode = (c: Container): number => +(c.Status.match(/^Restarting \((\d+)\)/)?.[1] ?? 0);

export function tone(c: Container): Tone {
  if (c.State === 'running') return /\(unhealthy\)/.test(c.Status) ? 'warn' : /health: starting/.test(c.Status) ? 'check' : 'ok';
  if (c.State === 'paused') return 'pause';
  if (c.State === 'restarting') return restartCode(c) ? 'bad' : 'busy';  // código ≠ 0 = loop de crash
  if (c.State === 'dead' || /^Exited \((?!0\))/.test(c.Status)) return 'bad';
  return 'off';
}

const BUCKET_OF_STATE: Partial<Record<ContainerState, Bucket>> = {running: 'rodando', paused: 'pausado', restarting: 'reiniciando'};
export const bucket = (c: Container): Bucket =>
  ['bad', 'warn'].includes(tone(c)) ? 'problema' : BUCKET_OF_STATE[c.State] || 'parado';
export const isProblem = (c: Container): boolean => bucket(c) === 'problema';
// quem entrou na faixa de atenção desde a leitura anterior (IDs que já estavam nela); null = primeira leitura,
// que só serve de base: o que já estava com problema ao abrir a página não vira notificação
// is: o critério de entrada na faixa; key: o que o before guarda (uma chave por causa faz a troca de causa contar como entrada)
export const newProblems = (before: Set<string> | null, cs: Container[], is: (c: Container) => boolean = isProblem,
                            key: (c: Container) => string = c => c.ID): Container[] =>
  before ? cs.filter(c => is(c) && !before.has(key(c))) : [];
// depends_on tem vírgulas no valor, então não dá para fazer split nos Labels; regex só no project
export const project = (c: Pick<Container, 'Labels'>): string =>
  (c.Labels || '').match(/(?:^|,)com\.docker\.compose\.project=([^,]*)/)?.[1] || '';
// pasta do projeto compose (vai para o compose up/down/pull; o servidor confere contra os labels)
export const workingDir = (c: Pick<Container, 'Labels'>): string =>
  (c.Labels || '').match(/(?:^|,)com\.docker\.compose\.project\.working_dir=([^,]*)/)?.[1] || '';
// serviço do compose (vai para o compose restart; o servidor confere contra os serviços do projeto)
export const service = (c: Pick<Container, 'Labels'>): string =>
  (c.Labels || '').match(/(?:^|,)com\.docker\.compose\.service=([^,]*)/)?.[1] || '';

// depends_on do compose: "db:service_healthy:false,redis:service_started:false". O 3º campo (restart) entrou no Compose 2.17
// e é opcional. O valor tem vírgulas: a regex vai até o próximo ",chave=", que não casa com "nome:condição"
const DEP = '[^,=:]+:[^,=:]+(?::(?:true|false))?';
const DEPS_RE = new RegExp(`(?:^|,)com\\.docker\\.compose\\.depends_on=(${DEP}(?:,${DEP})*)`);
export type Cond = 'service_started' | 'service_healthy' | 'service_completed_successfully';
export type Dep = {service: string; cond: Cond};
const CONDS: readonly string[] = ['service_started', 'service_healthy', 'service_completed_successfully'];
export function dependsOn(c: Pick<Container, 'Labels'>): Dep[] {
  const v = (c.Labels || '').match(DEPS_RE)?.[1];
  return !v ? [] : v.split(',').map(d => {
    const [service, cond] = d.split(':');
    return {service, cond: (CONDS.includes(cond) ? cond : 'service_started') as Cond};  // condição desconhecida: a mais branda
  });
}

// por que a dependência não cumpre a condição; null = cumpre. "verificando saúde" e um migrate ainda rodando são a espera
// normal de um compose up: não seguram ninguém (senão cada up acenderia a faixa)
export type DepState = 'unhealthy' | 'exited' | 'stopped' | 'missing';
function oneState(c: Container, cond: Cond): DepState | null {
  if (c.State === 'running') return cond === 'service_healthy' && /\(unhealthy\)/.test(c.Status) ? 'unhealthy' : null;
  if (cond === 'service_completed_successfully' && /^Exited \(0\)/.test(c.Status)) return null;
  if (c.State === 'restarting' && !restartCode(c)) return null;  // voltando, sem crash
  return tone(c) === 'bad' ? 'exited' : 'stopped';
}
export function depState(d: Dep, p: string, cs: Container[]): DepState | null {
  const st = cs.filter(c => project(c) === p && service(c) === d.service).map(c => oneState(c, d.cond));
  if (!st.length) return 'missing';
  return st.includes(null) ? null : st.find(s => s === 'unhealthy' || s === 'exited') ?? st[0];  // réplicas: basta uma
}

// as dependências diretas que seguram o container. Container de pé e bem não é segurado por ninguém.
// ponytail: O(n) por container, O(n²) por render; listas locais têm dezenas de containers
export type Blocker = {service: string; state: DepState; c?: Container};
export function blockers(c: Container, cs: Container[]): Blocker[] {
  const p = project(c);
  if (!p || (c.State === 'running' && !isProblem(c))) return [];
  return dependsOn(c).flatMap(d => {
    const state = depState(d, p, cs);
    return state ? [{service: d.service, state, c: cs.find(x => project(x) === p && service(x) === d.service)}] : [];
  });
}
// "Created" esperando uma dependência quebrada: entra na faixa (o criado à mão, sem causa, continua parado)
export const held = (c: Container, cs: Container[]): boolean => c.State === 'created' && blockers(c, cs).length > 0;
// quem este container segura (no mesmo projeto)
export function holds(c: Container, cs: Container[]): Container[] {
  const p = project(c), s = service(c);
  return !p ? [] : cs.filter(d => d.ID !== c.ID && project(d) === p && blockers(d, cs).some(b => b.service === s));
}
// prefixo do `docker compose logs` -> serviço, para os containers do projeto p. O compose escreve o nome do container
// sem o projeto quando é o nome padrão ("shop-api-2" -> "api-2"), e o nome inteiro com container_name ("postgres-17"):
// só o nome e o label dizem qual dos dois é, o "-<número>" no fim do prefixo não
export function logServices(p: string, cs: Pick<Container, 'Names' | 'Labels'>[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const c of cs) {
    const s = service(c), replica = c.Names.slice(p.length + s.length + 2);
    if (project(c) !== p || !s) continue;
    m.set(c.Names.startsWith(`${p}-${s}-`) && /^\d+$/.test(replica) ? `${s}-${replica}` : c.Names, s);
  }
  return m;
}

// "About an hour" -> "~1 h", "23 minutes" -> "23 min", "Less than a second" -> "<1 s"
export function dur(s: string): string {
  if (/less than a second/i.test(s)) return '<1 s';
  const m = s.match(/(about )?(an?|\d+) (second|minute|hour|day|week|month|year)/i);
  if (!m) return s;
  const n = /^an?$/i.test(m[2]) ? 1 : +m[2], u = UNIT[m[3].toLowerCase()];
  return `${m[1] ? '~' : ''}${n} ${u[+(n > 1)]}`;
}

// o que o inspect acrescenta a uma queda (/api/inspect): se o kernel matou por falta de memória e quantas vezes o
// docker já reiniciou o container
// FinishedAt: quando caiu (o "Marcar como visto" da faixa de atenção vale só para esta queda)
export type Facts = {OOMKilled: boolean; RestartCount: number; FinishedAt?: string};

// a dica de uma queda: a causa do código de saída e, com o inspect na mão, o 137 separado em memória ou SIGKILL e os
// reinícios. undefined quando não há o que dizer
function exitHint(code: number, f?: Facts): string | undefined {
  const cause = code === 137 && f ? (f.OOMKilled ? t`sem memória (OOM)` : t`morto à força (SIGKILL), não por falta de memória`) : EXIT[code];
  const again = !f?.RestartCount ? '' : f.RestartCount === 1 ? t`reiniciou 1 vez` : t`reiniciou ${f.RestartCount} vezes`;
  return [cause, again].filter(Boolean).join(' · ') || undefined;
}

// traduz o Status do docker; o original fica no title. f: o inspect de quem caiu, quando já veio
export function status(c: Container, f?: Facts): StatusText {
  const s = c.Status, d = dur(s.replace(/^(Up|Exited \(\d+\)|Restarting \(\d+\))\s*/, '').replace(/ \(.*\)$/, '').replace(/ ago$/, ''));
  const h = /\(unhealthy\)/.test(s) ? t` · healthcheck falhando` : /health: starting/.test(s) ? t` · verificando saúde`
          : /\(healthy\)/.test(s) ? t` · saudável` : '';
  if (c.State === 'running') return [t`Rodando há ${d}${h}`];
  if (c.State === 'paused') return [t`Pausado`];
  if (c.State === 'restarting') return restartCode(c)
    // em loop, o RestartCount sobe a cada volta e o inspect é lido uma vez por queda: a contagem sairia velha
    ? [t`Reiniciando em loop · saiu com código ${restartCode(c)}`, exitHint(restartCode(c), f && {...f, RestartCount: 0})] : [t`Reiniciando…`];
  if (c.State === 'created') return [t`Criado, nunca iniciado`];
  if (c.State === 'dead') return [t`Morto · só dá para remover`];
  const code = +(s.match(/^Exited \((\d+)\)/)?.[1] ?? 0);
  return code ? [t`Saiu com código ${code} há ${d}`, exitHint(code, f)] : [t`Parado há ${d}`];
}

// "0.0.0.0:5432->5432/tcp, [::]:5432->5432/tcp" -> [["5432","5432","tcp"]]
// o docker junta 4+ portas seguidas numa faixa ("0.0.0.0:3000-3003->3000-3003/tcp"): faixa curta vira uma
// entrada por porta (cada uma clicável); faixa longa (mídia RTP, FTP passivo...) fica numa entrada só, "h1-h2"
export const MAX_EXPAND = 8;
export const ports = (p: string): Port[] => {
  const out: Port[] = [];
  for (const [, h1, h2 = h1, c1, c2 = c1, proto] of p.matchAll(/:(\d+)(?:-(\d+))?->(\d+)(?:-(\d+))?\/(\w+)/g)) {
    const n = +h2 - +h1;
    if (n === +c2 - +c1 && n < MAX_EXPAND) for (let i = 0; i <= n; i++) out.push([`${+h1 + i}`, `${+c1 + i}`, proto]);
    else out.push([h1 === h2 ? h1 : `${h1}-${h2}`, c1 === c2 ? c1 : `${c1}-${c2}`, proto]);
  }
  return [...new Set(out.map(x => x.join(':')))].map(s => s.split(':') as Port);
};

// "ghcr.io/acme/api:1.4" -> "acme/api:1.4": o host do registry raramente importa; a tag sim
export const shortImage = (img: string): string => img.replace(/^[^/]+[.:][^/]*\//, '');
export const hasHealth = (c: Container): boolean => /\((un)?healthy\)|health: starting/.test(c.Status);

// uma linha do `docker stats --no-stream --format '{{json .}}'`, só com os campos que a página lê
// (o servidor converte a do podman para este formato)
export interface Stats {
  ID: string;
  CPUPerc: string;   // "0.52%"
  MemUsage: string;  // "10.5MiB / 1.944GiB"
  MemPerc: string;   // "0.53%"
  NetIO?: string;    // "1.2kB / 648B": recebido / enviado, total desde que o container subiu
  BlockIO?: string;  // "0B / 4.1kB": lido / gravado no disco, idem
}

// [CPU, memória usada, title com o limite de memória e, quando vierem, rede e disco]
export const usage = (s: Stats): [cpu: string, ram: string, title: string] =>
  [`CPU ${s.CPUPerc}`, `RAM ${s.MemUsage.split(' / ')[0]}`, [t`Memória: ${s.MemUsage} (${s.MemPerc})`, ...io(s)].join('\n')];

// "10.5MiB" -> 11010048, "1.2kB" -> 1200; null se não for um tamanho ("--"). O docker usa unidade binária na
// memória e decimal na rede e no disco; o podman, decimal em tudo
const SIZE: Record<string, number> = {B: 1, KB: 1e3, MB: 1e6, GB: 1e9, TB: 1e12, PB: 1e15,
                                      KIB: 2 ** 10, MIB: 2 ** 20, GIB: 2 ** 30, TIB: 2 ** 40, PIB: 2 ** 50};
export function bytes(s: string): number | null {
  const m = s.trim().match(/^(\d+(?:\.\d+)?)\s*([kKMGTP]i?B|B)$/);
  return m ? +m[1] * SIZE[m[2].toUpperCase()] : null;
}
// "0.52%" -> 0.52; null em "--" (o podman manda isso enquanto ainda não mediu)
export const percent = (s: string): number | null => {
  const m = s.trim().match(/^(\d+(?:\.\d+)?)%$/);
  return m ? +m[1] : null;
};
// 11010048 -> "10.5 MiB": memória em unidade binária, como o docker mostra
export function fmtBytes(n: number): string {
  const u = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let i = 0;
  for (; n >= 1024 && i < u.length - 1; i++) n /= 1024;
  return `${i && n < 100 ? n.toFixed(1) : Math.round(n)} ${u[i]}`;
}

// memória: uso e limite do "476MiB / 512MiB" do stats. Sem limite, o docker põe a RAM toda do daemon no lugar do limite
export function memLimit(s: Stats): {used: number; limit: number} | null {
  const [u, l] = s.MemUsage.split(' / ').map(x => bytes(x ?? ''));
  return u !== null && l ? {used: u, limit: l} : null;
}
// o MemPerc do docker vem das contas exatas; sem ele ("--" no podman), a conta com o que veio
export const memPct = (s: Stats): number | null => {
  const m = memLimit(s);
  return percent(s.MemPerc) ?? (m && m.used / m.limit * 100);
};
// container quente: 2 leituras seguidas em 90% ou mais do limite; sai abaixo de 85% (entre os dois, fica como está).
// Limite acima de 95% da RAM total conta como sem limite (o stats arredonda a RAM: "7.6GiB" são 7,63 GiB). first: a
// primeira leitura da página, que serve de base (quem já estava no alto fica quente sem esperar, e não notifica)
export type MemState = Map<string, {n: number; on: boolean}>;
const MEM_IN = 90, MEM_OUT = 85, MEM_READS = 2, NO_LIMIT = 0.95;
export function memWatch(prev: MemState, stats: Record<string, Stats>, memTotal: number | null, first = false): MemState {
  const next: MemState = new Map();
  if (!memTotal) return next;
  for (const [id, s] of Object.entries(stats)) {
    const m = memLimit(s), pct = memPct(s), was = prev.get(id) ?? {n: 0, on: false};
    if (!m || pct === null || m.limit >= NO_LIMIT * memTotal) continue;
    if (pct >= MEM_IN) next.set(id, {n: was.n + 1, on: was.on || first || was.n + 1 >= MEM_READS});
    else if (pct >= MEM_OUT && was.on) next.set(id, {n: 0, on: true});
  }
  return next;
}
export const memHot = (st: MemState, id: string): boolean => !!st.get(id)?.on;
export const memText = (s: Stats): string => {
  const m = memLimit(s)!;
  return t`Memória em ${Math.round(memPct(s)!)}% do limite (${fmtBytes(m.used)} de ${fmtBytes(m.limit)})`;
};

// "1.2kB / 648B" -> ["1.2kB", "648B"]; null se faltar o campo ou um dos lados não for tamanho
export function pair(s?: string): [string, string] | null {
  const m = s?.match(/^\s*(\S+)\s*\/\s*(\S+)\s*$/);
  return m && bytes(m[1]) !== null && bytes(m[2]) !== null ? [m[1], m[2]] : null;
}
// rede e disco em texto, uma linha cada (só as que vieram); são totais desde que o container subiu
export function io(s: Stats): string[] {
  const net = pair(s.NetIO), blk = pair(s.BlockIO);
  return [net && t`Rede: ${net[0]} recebidos · ${net[1]} enviados`, blk && t`Disco: ${blk[0]} lidos · ${blk[1]} gravados`]
    .filter((x): x is string => !!x);
}

// histórico do stats para o sparkline: uma amostra por leitura, no máximo HISTORY. Com o poll de 5 s mais os
// ~2 s que o stats leva para medir, 60 leituras dão uns 5 a 7 min
export type Sample = {t: number; cpu: number; mem: number};  // t em ms, cpu em %, mem em bytes
export const HISTORY = 60;
// acrescenta no fim e descarta o mais velho (fila de tamanho fixo); devolve um array novo, sem mexer no antigo.
// Um buraco maior que gap (aba escondida, servidor fora) recomeça a série: a linha passaria por cima dele
export function pushSample(buf: Sample[], s: Sample, max = HISTORY, gap = 30_000): Sample[] {
  const last = buf.at(-1);
  return [...(last && s.t - last.t <= gap ? buf : []), s].slice(-max);
}
// pontos de um polyline num viewBox w x h, com 1 de margem para o traço não ser cortado. Cada amostra ocupa
// uma fatia fixa, alinhada à direita: a linha cresce da direita e a largura sempre vale a mesma janela de tempo.
// O eixo y vai de 0 ao máximo da série (ou a floor, se maior): uma variação de 0,01% não vira montanha
export function sparkPoints(vs: number[], w: number, h: number, max = HISTORY, floor = 0): string {
  // até a janela encher, a série ocupa a largura toda: 3 leituras numa janela de 60 viravam um ponto na ponta
  const top = Math.max(floor, ...vs) || 1, dx = w / (Math.max(2, Math.min(vs.length, max)) - 1), r = (n: number) => +n.toFixed(1);
  // série sem variação vai no meio da altura: deitada no pé, parecia um sublinhado quebrado
  const flat = vs.every(v => v === vs[0]);
  return vs.map((v, i) => `${r(w - (vs.length - 1 - i) * dx)},${r(flat ? h / 2 : h - 1 - (v / top) * (h - 2))}`).join(' ');
}
// texto alternativo do sparkline: "CPU nos últimos 4 min: mín 0.1%, máx 2.3%, agora 0.5%"
export function trend(label: string, vs: number[], span: number, fmt: (n: number) => string): string {
  const when = span < 60_000 ? `${Math.max(1, Math.round(span / 1000))} s` : `${Math.round(span / 60_000)} min`;
  return t`${label} nos últimos ${when}: mín ${fmt(Math.min(...vs))}, máx ${fmt(Math.max(...vs))}, agora ${fmt(vs.at(-1)!)}`;
}

// filtro do modal de logs: texto literal (nada de regex do usuário), sem diferenciar maiúsculas; '' = sem filtro.
// O grupo faz o split devolver os trechos que casaram: "erro e Erro".split(re) -> ['', 'erro', ' e ', 'Erro', '']
export const logFilter = (q: string): RegExp | null =>
  q ? new RegExp(`(${q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'i') : null;

// /api/images, /api/volumes e /api/networks: o servidor já põe docker e podman num formato só.
// Containers = nomes dos containers que usam (parados também)
export interface Image {
  ID: string;          // inteiro (64 hex)
  Tags: string[];      // vazio = dangling
  Size: string;        // "187MB"
  Created: number | null;  // epoch em segundos
  Containers: string[];
}
export interface Volume { Name: string; Driver: string; Size: string; Containers: string[] }  // Size: "52.56MB" ou '' (podman)
export interface Network { ID: string; Name: string; Driver: string; Scope: string; Builtin: boolean; Containers: string[] }

// idade a partir do epoch (segundos), no estilo do dur(): "<1 min", "5 h", "3 sem", "4 meses"
export function age(t: number, now = Date.now() / 1000): string {
  const s = now - t, d = s / 86400, n = (x: number) => Math.floor(x);
  return s < 60 ? '<1 min' : s < 3600 ? `${n(s / 60)} min` : s < 172800 ? `${n(s / 3600)} h` : d < 14 ? `${n(d)} d`
    : d < 60 ? `${n(d / 7)} ${UNIT.week[1]}` : d < 730 ? `${n(d / 30)} ${UNIT.month[1]}` : `${n(d / 365)} ${UNIT.year[1]}`;
}

// erro do docker (ou do podman) ao iniciar, criar ou remover -> explicação curta; '' quando não reconhece. Os de subir
// vêm antes: "address already in use" e "name ... is already in use" também casariam com o "in use" da remoção
export function errHint(msg: string): string {
  if (/port is already allocated|address already in use|ports are not available/i.test(msg)) return t`A porta do host já está em uso: pare o que usa ela ou troque a porta.`;
  if (/container name .* is already in use/i.test(msg)) return t`Já existe um container com esse nome: escolha outro ou remova o antigo.`;
  if (/pull access denied|repository does not exist|manifest unknown|manifest for \S+ not found/i.test(msg)) return t`A imagem não existe no registry, ou falta login: confira o nome, a tag e o docker login.`;
  if (/no space left on device/i.test(msg)) return t`Disco cheio: libere espaço (aba Imagens, Limpar…).`;
  if (/network \S+ not found/i.test(msg)) return t`A rede do container não existe mais: recrie o container (no compose, compose up).`;
  if (/exec format error/i.test(msg)) return t`A imagem é de outra arquitetura (ex.: arm64 num host amd64).`;
  if (/executable file not found|exec: .*no such file or directory/i.test(msg)) return t`O comando que a imagem roda não existe dentro dela.`;
  if (/referenced in multiple repositories/.test(msg)) return t`A imagem tem mais de uma tag: remova as tags pelo terminal, uma a uma.`;
  if (/dependent child images/.test(msg)) return t`Outras imagens foram construídas sobre esta.`;
  if (/in use|being used|active endpoints|associated containers/i.test(msg)) return t`Em uso: remova o container que usa (ou tire ele da rede) antes.`;
  return '';
}

// GET /api/history/<id>: o que o docker events ainda guarda do container (o servidor já põe docker e podman num
// formato só). t em segundos; code só no die; health só no health_status
export interface HistoryEvent { t: number; a: 'start' | 'die' | 'oom' | 'pause' | 'unpause' | 'health_status'; code: number | null; health: string }
// [texto, tom] de um evento: "saiu com código 137 · morto à força ou sem memória (OOM)"
export function eventText(e: HistoryEvent): [string, Tone] {
  if (e.a === 'start') return [t`subiu`, 'ok'];
  if (e.a === 'die') return e.code ? [t`saiu com código ${e.code}` + (EXIT[e.code] ? ` · ${EXIT[e.code]}` : ''), 'bad'] : [t`parou`, 'off'];
  if (e.a === 'oom') return [t`ficou sem memória (OOM)`, 'bad'];
  if (e.a === 'pause') return [t`pausado`, 'pause'];
  if (e.a === 'unpause') return [t`retomado`, 'ok'];
  return e.health === 'unhealthy' ? [t`healthcheck começou a falhar`, 'warn'] : e.health === 'healthy' ? [t`healthcheck voltou a passar`, 'ok']
    : [t`healthcheck: ${e.health || '?'}`, 'check'];
}
// o podman avisa a saúde a cada probe, o docker só quando muda: fica só a mudança
export function healthChanges(evs: HistoryEvent[]): HistoryEvent[] {
  let last = '';
  return evs.filter(e => {
    if (e.a !== 'health_status') return true;
    const changed = e.health !== last;
    last = e.health;
    return changed;
  });
}
// "subiu 5× · caiu 4× · 1 OOM": o que importa num loop de reinício, sem ler a lista; '' sem nada disso
export function historySummary(evs: HistoryEvent[]): string {
  const n = (f: (e: HistoryEvent) => boolean) => evs.filter(f).length;
  const up = n(e => e.a === 'start'), fell = n(e => e.a === 'die' && !!e.code), oom = n(e => e.a === 'oom');
  return [up && t`subiu ${up}×`, fell && t`caiu ${fell}×`, oom && t`${oom} OOM`].filter(Boolean).join(' · ');
}

// saída do `docker top` -> linhas de células, a primeira com os títulos. O docker alinha as colunas com muitos espaços (a
// CMD, que é a que importa, ia parar fora da tela): separa por 2+ espaços, e o que sobra depois da última coluna é do
// comando. ponytail: um argumento com dois espaços seguidos no CMD vira dois; aqui ele volta junto, com dois espaços
export function topTable(text: string): string[][] {
  const [head, ...lines] = text.split('\n').filter(l => l.trim()).map(l => l.trim().split(/\s{2,}/));
  if (!head) return [];
  return [head, ...lines.map(c => [...c.slice(0, head.length - 1), c.slice(head.length - 1).join('  ')])];
}

// um probe do healthcheck, como o `inspect` guarda (as 5 últimas execuções, a mais velha primeiro)
export type Probe = {Start: string; End: string; ExitCode: number; Output: string};
// o docker usa 1 para "falhou" e -1 para timeout ou probe que nem rodou; outro código também é "não rodou como esperado"
export const probeResult = (p: Probe): 'ok' | 'fail' | 'error' => p.ExitCode === 0 ? 'ok' : p.ExitCode === 1 ? 'fail' : 'error';
// o Date.parse não garante mais de 3 casas na fração: corta os nanossegundos do docker
export const probeTime = (s: string): number => Date.parse(s.replace(/(\.\d{3})\d+/, '$1'));
export function probeDuration(p: Probe): number | null {
  const d = probeTime(p.End) - probeTime(p.Start);
  return Number.isFinite(d) && d >= 0 ? d : null;
}
export function healthSummary(log: Probe[]): string {
  const bad = log.filter(p => probeResult(p) !== 'ok').length;
  return !log.length ? '' : bad ? t`${bad} de ${log.length} falharam` : t`as ${log.length} passaram`;
}

// uma linha do `docker diff`, já separada pelo servidor: A (adicionado), C (alterado), D (apagado)
export type DiffItem = {k: 'A' | 'C' | 'D'; p: string};
export const DIFF_MAX = 500;  // a lista mostra até aqui; o filtro e o Copiar valem para todos
export function diffSummary(items: DiffItem[]): string {
  const n = (k: DiffItem['k']) => items.filter(d => d.k === k).length, a = n('A'), c = n('C'), d = n('D');
  return [a && (a === 1 ? t`1 adicionado` : t`${a} adicionados`), c && (c === 1 ? t`1 alterado` : t`${c} alterados`),
          d && (d === 1 ? t`1 apagado` : t`${d} apagados`)].filter(Boolean).join(' · ');
}

// criar container: as mesmas regras do run_argv do servidor, para apontar o erro no campo antes de enviar.
// Quem decide é o servidor, que confere tudo de novo
export const RESTART = ['no', 'on-failure', 'unless-stopped', 'always'] as const;
export type Restart = typeof RESTART[number];
// corpo do POST /api/run
export interface RunSpec {
  image: string; name: string; ports: string[]; all_interfaces: boolean; env: string[]; restart: Restart; volume: string;
}
// o que o usuário digitou: portas separadas por espaço ou vírgula, env uma por linha
export interface RunForm {
  image: string; name: string; ports: string; all_interfaces: boolean; env: string; restart: string; volume: string;
}
export type RunField = 'image' | 'name' | 'ports' | 'env' | 'restart' | 'volume';
export type RunErrors = Partial<Record<RunField, string>>;

const HOST = '[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?', PATH = '[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*';
const IMAGE_RE = new RegExp(`^(?:${HOST}(?:\\.${HOST})*(?::[0-9]+)?/)?${PATH}(?:/${PATH})*` +
                            '(?::[A-Za-z0-9_][A-Za-z0-9_.-]{0,127})?(?:@sha256:[0-9a-f]{64})?$');
const NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{1,127}$/;
const PORT_RE = /^([0-9]{1,5}):([0-9]{1,5})(?:\/(tcp|udp))?$/;
const ENV_RE = /^[A-Za-z_][A-Za-z0-9_]{0,255}$/;
const VOLUME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{1,127}:((?:\/[A-Za-z0-9._@+-]+)+)$/;
export const MAX_ENV_VALUE = 4096, MAX_ITEMS = 64;

// "8080:80, 5353:53/udp" -> ["8080:80", "5353:53/udp"]
export const splitPorts = (s: string): string[] => s.split(/[\s,]+/).filter(Boolean);
// uma variável por linha; linha em branco e comentário (#) ficam de fora, como num .env
export const splitEnv = (s: string): string[] => s.split(/\r?\n/).filter(l => l.trim() && !l.trimStart().startsWith('#'));

// formulário -> corpo do POST /api/run e o erro de cada campo (vazio = pode enviar)
export function runSpec(f: RunForm): {spec: RunSpec; errors: RunErrors} {
  const errors: RunErrors = {}, image = f.image.trim(), name = f.name.trim(), volume = f.volume.trim();
  const ports = splitPorts(f.ports), env = splitEnv(f.env);
  if (!image) errors.image = t`Informe a imagem, ex.: nginx:1.27 ou ghcr.io/acme/api:1.4.`;
  else if (image.length > 512 || !IMAGE_RE.test(image)) errors.image = t`Imagem inválida: use repo[:tag] ou repo@sha256:…, com o caminho em minúsculas.`;
  if (name && !NAME_RE.test(name)) errors.name = t`Nome inválido: 2 a 128 caracteres entre letras, números, _ . e -, começando por letra ou número.`;

  const seen = new Set<string>();
  for (const p of ports) {
    const m = p.match(PORT_RE);
    if (!m || [m[1], m[2]].some(n => +n < 1 || +n > 65535)) {
      errors.ports = t`“${p.slice(0, 40)}” não é uma porta válida: use portaDoHost:portaDoContainer, ex.: 8080:80 ou 5353:53/udp.`;
      break;
    }
    const key = `${+m[1]}/${m[3] || 'tcp'}`;
    if (seen.has(key)) { errors.ports = t`A porta ${key} do host aparece duas vezes.`; break; }
    seen.add(key);
  }
  if (!errors.ports && ports.length > MAX_ITEMS) errors.ports = t`No máximo ${MAX_ITEMS} portas.`;

  const keys = new Set<string>();
  for (const e of env) {
    // sem "=", o docker copiaria a variável do ambiente do servidor: o servidor também recusa
    const i = e.indexOf('='), k = e.slice(0, i), v = e.slice(i + 1);
    if (i < 0 || !ENV_RE.test(k)) {
      errors.env = t`“${e.slice(0, 40)}” não é CHAVE=valor: a chave tem letras, números e _, e não começa com número.`;
      break;
    }
    if (v.includes('\0') || v.length > MAX_ENV_VALUE) { errors.env = t`O valor de ${k} tem o caractere NUL ou passa de ${MAX_ENV_VALUE} caracteres.`; break; }
    if (keys.has(k)) { errors.env = t`${k} aparece duas vezes.`; break; }
    keys.add(k);
  }
  if (!errors.env && env.length > MAX_ITEMS) errors.env = t`No máximo ${MAX_ITEMS} variáveis.`;

  const restart = RESTART.find(r => r === f.restart);
  if (!restart) errors.restart = t`Escolha uma das opções da lista.`;
  const path = volume.length <= 1024 ? volume.match(VOLUME_RE)?.[1] : undefined;
  if (volume && (!path || path.split('/').some(s => s === '.' || s === '..')))
    errors.volume = t`Use nome:/caminho/no/container, ex.: dados:/var/lib/postgresql/data. Pasta do host (bind mount) não é aceita.`;
  return {spec: {image, name, ports, all_interfaces: f.all_interfaces, env, restart: restart || 'no', volume}, errors};
}

// resumo de uma ação em lote para o aviso: "3 parados, 1 falhou: web: permission denied."
// done é o particípio no singular (DONE do app.ts; em inglês, o plural é igual); só as 2 primeiras falhas vão por
// extenso, o resto fica nas linhas
export function bulkSummary(done: string, ok: number, fails: [name: string, msg: string][]): string {
  const why = (m: string) => m.trim().split('\n')[0].replace(/\.$/, '') || t`erro sem mensagem`;
  const f = fails.length, list = fails.slice(0, 2).map(([n, m]) => `${n}: ${why(m)}`).join('; ');
  return [ok && `${ok} ${ok === 1 || LANG === 'en' ? done : done + 's'}`,
          f && `${f} ${f === 1 ? t`falhou` : t`falharam`}: ${list}${f > 2 ? t`; e mais ${f - 2}` : ''}`].filter(Boolean).join(', ') + '.';
}

// nível de uma linha de log, para a cor: 'bad' (erro), 'warn' (aviso), 'dim' (debug) ou '' (o resto). Vale a palavra
// solta em maiúsculas (ERROR, WARN: "0 errors" não é nível), Error:/Warning: começando a mensagem, level=... ou
// "level":"..." (também lvl e severity) de log estruturado, o "level":50 do pino e do bunyan (10 trace ... 60 fatal), o
// [error] do nginx e o começo de um stack trace (ValueError:, java.io.IOException:, Traceback do Python).
// ponytail: heurística; "No Error: found" sai vermelho
export type LogLevel = 'bad' | 'warn' | 'dim' | '';
const LEVEL: [Exclude<LogLevel, ''>, RegExp, RegExp][] = [
  ['bad', /\b(FATAL|PANIC|CRIT(ICAL)?|ERROR|ERR|EMERG)\b|\b\w*(Error|Exception)\b:|\bTraceback \(most recent call last\)/,
   /\b(level|lvl|severity)["=: ]+"?(fatal|panic|crit|err|alert|emerg)|"level":\s*[56]0\b|\[(error|crit|alert|emerg)\]/i],
  ['warn', /\bWARN(ING)?\b|\bWarning:/, /\b(level|lvl|severity)["=: ]+"?warn|"level":\s*40\b|\[warn\]/i],
  ['dim', /\b(DEBUG|TRACE)\b/, /\b(level|lvl|severity)["=: ]+"?(debug|trace)|"level":\s*[12]0\b|\[debug\]/i]];
export const logLevel = (line: string): LogLevel => LEVEL.find(([, word, mark]) => word.test(line) || mark.test(line))?.[0] ?? '';
// linha que continua a de cima num stack trace (indentada, "Caused by:", "... 3 more"): ela herda o nível da linha que
// abriu o trace, para "Só erros" mostrar o trace inteiro. Recebe a linha sem o prefixo do serviço e sem o timestamp
export const continues = (body: string): boolean => /^(\s+\S|Caused by:|\.\.\. \d+ more)/.test(body);

// fatia liberável de uma categoria do docker system df (0 a 1), para a barra: o "(40%)" do Reclaimable, ou a
// conta pelos tamanhos quando ele não vem (o build cache manda só "3.3GB"); null se não der para saber
export function reclaimShare(d: DiskUsage): number | null {
  const pct = d.Reclaimable.match(/\((\d+(?:\.\d+)?)%\)/), r = bytes(d.Reclaimable.split(' ')[0]), t = bytes(d.Size);
  const v = pct ? +pct[1] / 100 : r !== null && t ? r / t : null;
  return v === null ? null : Math.min(1, Math.max(0, v));
}

// volume anônimo: o nome é um hash de 64 hex
export const anonVolume = (name: string): boolean => /^[0-9a-f]{64}$/.test(name);
// o que o volume prune (sem -a) leva: o que nenhum container usa; no Docker 23+ só os anônimos, no Podman os nomeados
// também. ponytail: Docker anterior ao 23 (2023) também leva os nomeados e aqui sai a conta menor
export const prunedVolumes = (vs: Volume[], podman: boolean): Volume[] =>
  vs.filter(v => !v.Containers.length && (podman || anonVolume(v.Name)));
