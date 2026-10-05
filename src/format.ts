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
export interface Stats {
  ID: string;
  CPUPerc: string;   // "0.52%"
  MemUsage: string;  // "10.5MiB / 1.944GiB"
  MemPerc: string;   // "0.53%"
}

// [texto curto, title com o limite de memória]
export const usage = (s: Stats): StatusText =>
  [`CPU ${s.CPUPerc} · RAM ${s.MemUsage.split(' / ')[0]}`, `Memória: ${s.MemUsage} (${s.MemPerc})`];

// filtro do modal de logs: texto literal (nada de regex do usuário), sem diferenciar maiúsculas; '' = sem filtro.
// O grupo faz o split devolver os trechos que casaram: "erro e Erro".split(re) -> ['', 'erro', ' e ', 'Erro', '']
export const logFilter = (q: string): RegExp | null =>
  q ? new RegExp(`(${q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'i') : null;
