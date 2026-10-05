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
  if (!image) errors.image = 'Informe a imagem, ex.: nginx:1.27 ou ghcr.io/acme/api:1.4.';
  else if (image.length > 512 || !IMAGE_RE.test(image)) errors.image = 'Imagem inválida: use repo[:tag] ou repo@sha256:…, com o caminho em minúsculas.';
  if (name && !NAME_RE.test(name)) errors.name = 'Nome inválido: 2 a 128 caracteres entre letras, números, _ . e -, começando por letra ou número.';

  const seen = new Set<string>();
  for (const p of ports) {
    const m = p.match(PORT_RE);
    if (!m || [m[1], m[2]].some(n => +n < 1 || +n > 65535)) {
      errors.ports = `“${p.slice(0, 40)}” não é uma porta válida: use portaDoHost:portaDoContainer, ex.: 8080:80 ou 5353:53/udp.`;
      break;
    }
    const key = `${+m[1]}/${m[3] || 'tcp'}`;
    if (seen.has(key)) { errors.ports = `A porta ${key} do host aparece duas vezes.`; break; }
    seen.add(key);
  }
  if (!errors.ports && ports.length > MAX_ITEMS) errors.ports = `No máximo ${MAX_ITEMS} portas.`;

  const keys = new Set<string>();
  for (const e of env) {
    // sem "=", o docker copiaria a variável do ambiente do servidor: o servidor também recusa
    const i = e.indexOf('='), k = e.slice(0, i), v = e.slice(i + 1);
    if (i < 0 || !ENV_RE.test(k)) {
      errors.env = `“${e.slice(0, 40)}” não é CHAVE=valor: a chave tem letras, números e _, e não começa com número.`;
      break;
    }
    if (v.includes('\0') || v.length > MAX_ENV_VALUE) { errors.env = `O valor de ${k} tem o caractere NUL ou passa de ${MAX_ENV_VALUE} caracteres.`; break; }
    if (keys.has(k)) { errors.env = `${k} aparece duas vezes.`; break; }
    keys.add(k);
  }
  if (!errors.env && env.length > MAX_ITEMS) errors.env = `No máximo ${MAX_ITEMS} variáveis.`;

  const restart = RESTART.find(r => r === f.restart);
  if (!restart) errors.restart = 'Escolha uma das opções da lista.';
  const path = volume.length <= 1024 ? volume.match(VOLUME_RE)?.[1] : undefined;
  if (volume && (!path || path.split('/').some(s => s === '.' || s === '..')))
    errors.volume = 'Use nome:/caminho/no/container, ex.: dados:/var/lib/postgresql/data. Pasta do host (bind mount) não é aceita.';
  return {spec: {image, name, ports, all_interfaces: f.all_interfaces, env, restart: restart || 'no', volume}, errors};
}
