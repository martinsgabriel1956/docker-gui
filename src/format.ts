// Funções puras que traduzem a saída do docker para a tela. Não tocam no DOM: o app.ts importa daqui,
// e os testes (tests/format.test.mjs) carregam este arquivo direto no Node, que remove os tipos sozinho.

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
  1: 'erro da aplicação', 125: 'falha do próprio docker run', 126: 'comando sem permissão de execução',
  127: 'comando não encontrado', 137: 'morto à força ou sem memória (OOM)', 139: 'falha de segmentação',
  143: 'encerrado por SIGTERM',
};
const UNIT: Record<string, string> = {second: 's', minute: 'min', hour: 'h', day: 'd', week: 'sem', month: 'mês', year: 'ano'};

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
export const newProblems = (before: Set<string> | null, cs: Container[]): Container[] =>
  before ? cs.filter(c => isProblem(c) && !before.has(c.ID)) : [];
// depends_on tem vírgulas no valor, então não dá para fazer split nos Labels; regex só no project
export const project = (c: Pick<Container, 'Labels'>): string =>
  (c.Labels || '').match(/(?:^|,)com\.docker\.compose\.project=([^,]*)/)?.[1] || '';
// pasta do projeto compose (vai para o compose up/down/pull; o servidor confere contra os labels)
export const workingDir = (c: Pick<Container, 'Labels'>): string =>
  (c.Labels || '').match(/(?:^|,)com\.docker\.compose\.project\.working_dir=([^,]*)/)?.[1] || '';
// serviço do compose (vai para o compose restart; o servidor confere contra os serviços do projeto)
export const service = (c: Pick<Container, 'Labels'>): string =>
  (c.Labels || '').match(/(?:^|,)com\.docker\.compose\.service=([^,]*)/)?.[1] || '';

// "About an hour" -> "~1 h", "23 minutes" -> "23 min", "Less than a second" -> "<1 s"
export function dur(s: string): string {
  if (/less than a second/i.test(s)) return '<1 s';
  const m = s.match(/(about )?(an?|\d+) (second|minute|hour|day|week|month|year)/i);
  if (!m) return s;
  const n = /^an?$/i.test(m[2]) ? 1 : +m[2], u = UNIT[m[3].toLowerCase()];
  return `${m[1] ? '~' : ''}${n} ${n > 1 && u === 'mês' ? 'meses' : n > 1 && u === 'ano' ? 'anos' : u}`;
}

// traduz o Status do docker; o original fica no title
export function status(c: Container): StatusText {
  const s = c.Status, t = dur(s.replace(/^(Up|Exited \(\d+\)|Restarting \(\d+\))\s*/, '').replace(/ \(.*\)$/, '').replace(/ ago$/, ''));
  const h = /\(unhealthy\)/.test(s) ? ' · healthcheck falhando' : /health: starting/.test(s) ? ' · verificando saúde'
          : /\(healthy\)/.test(s) ? ' · saudável' : '';
  if (c.State === 'running') return [`Rodando há ${t}${h}`];
  if (c.State === 'paused') return ['Pausado'];
  if (c.State === 'restarting') return restartCode(c)
    ? [`Reiniciando em loop · saiu com código ${restartCode(c)}`, EXIT[restartCode(c)]] : ['Reiniciando…'];
  if (c.State === 'created') return ['Criado, nunca iniciado'];
  if (c.State === 'dead') return ['Morto · só dá para remover'];
  const code = +(s.match(/^Exited \((\d+)\)/)?.[1] ?? 0);
  return code ? [`Saiu com código ${code} há ${t}`, EXIT[code]] : [`Parado há ${t}`];
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
  [`CPU ${s.CPUPerc}`, `RAM ${s.MemUsage.split(' / ')[0]}`, [`Memória: ${s.MemUsage} (${s.MemPerc})`, ...io(s)].join('\n')];

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

// "1.2kB / 648B" -> ["1.2kB", "648B"]; null se faltar o campo ou um dos lados não for tamanho
export function pair(s?: string): [string, string] | null {
  const m = s?.match(/^\s*(\S+)\s*\/\s*(\S+)\s*$/);
  return m && bytes(m[1]) !== null && bytes(m[2]) !== null ? [m[1], m[2]] : null;
}
// rede e disco em texto, uma linha cada (só as que vieram); são totais desde que o container subiu
export function io(s: Stats): string[] {
  const net = pair(s.NetIO), blk = pair(s.BlockIO);
  return [net && `Rede: ${net[0]} recebidos · ${net[1]} enviados`, blk && `Disco: ${blk[0]} lidos · ${blk[1]} gravados`]
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
  const top = Math.max(floor, ...vs) || 1, dx = w / (max - 1), r = (n: number) => +n.toFixed(1);
  return vs.map((v, i) => `${r(w - (vs.length - 1 - i) * dx)},${r(h - 1 - (v / top) * (h - 2))}`).join(' ');
}
// texto alternativo do sparkline: "CPU nos últimos 4 min: mín 0.1%, máx 2.3%, agora 0.5%"
export function trend(label: string, vs: number[], span: number, fmt: (n: number) => string): string {
  const when = span < 60_000 ? `${Math.max(1, Math.round(span / 1000))} s` : `${Math.round(span / 60_000)} min`;
  return `${label} nos últimos ${when}: mín ${fmt(Math.min(...vs))}, máx ${fmt(Math.max(...vs))}, agora ${fmt(vs.at(-1)!)}`;
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
export interface Volume { Name: string; Driver: string; Containers: string[] }
export interface Network { ID: string; Name: string; Driver: string; Scope: string; Builtin: boolean; Containers: string[] }

// idade a partir do epoch (segundos), no estilo do dur(): "<1 min", "5 h", "3 sem", "4 meses"
export function age(t: number, now = Date.now() / 1000): string {
  const s = now - t, d = s / 86400, n = (x: number) => Math.floor(x);
  return s < 60 ? '<1 min' : s < 3600 ? `${n(s / 60)} min` : s < 172800 ? `${n(s / 3600)} h` : d < 14 ? `${n(d)} d`
    : d < 60 ? `${n(d / 7)} sem` : d < 730 ? `${n(d / 30)} meses` : `${n(d / 365)} anos`;
}

// erro do docker (ou do podman) ao remover imagem, volume ou rede -> explicação curta; '' quando não reconhece
export function rmHint(msg: string): string {
  if (/referenced in multiple repositories/.test(msg)) return 'A imagem tem mais de uma tag: remova as tags pelo terminal, uma a uma.';
  if (/dependent child images/.test(msg)) return 'Outras imagens foram construídas sobre esta.';
  if (/in use|being used|active endpoints|associated containers/i.test(msg)) return 'Em uso: remova o container que usa (ou tire ele da rede) antes.';
  return '';
}
