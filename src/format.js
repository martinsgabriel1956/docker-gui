// Funções puras que traduzem a saída do docker para a tela. Não tocam no DOM: o build as
// concatena antes do app.js no mesmo <script>, e os testes (tests/format.test.js) as carregam no Node.
const esc = s => String(s).replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);

const EXIT = {1: 'erro da aplicação', 125: 'falha do próprio docker run', 126: 'comando sem permissão de execução',
              127: 'comando não encontrado', 137: 'morto à força ou sem memória (OOM)', 139: 'falha de segmentação',
              143: 'encerrado por SIGTERM'};
const UNIT = {second: 's', minute: 'min', hour: 'h', day: 'd', week: 'sem', month: 'mês', year: 'ano'};

const restartCode = c => +(c.Status.match(/^Restarting \((\d+)\)/)?.[1] ?? 0);
function tone(c) {
  if (c.State === 'running') return /\(unhealthy\)/.test(c.Status) ? 'warn' : /health: starting/.test(c.Status) ? 'check' : 'ok';
  if (c.State === 'paused') return 'pause';
  if (c.State === 'restarting') return restartCode(c) ? 'bad' : 'busy';  // código ≠ 0 = loop de crash
  if (c.State === 'dead' || /^Exited \((?!0\))/.test(c.Status)) return 'bad';
  return 'off';
}
const bucket = c => ['bad', 'warn'].includes(tone(c)) ? 'problema'
  : {running: 'rodando', paused: 'pausado', restarting: 'reiniciando'}[c.State] || 'parado';
const isProblem = c => bucket(c) === 'problema';
// depends_on tem vírgulas no valor, então não dá para fazer split nos Labels; regex só no project
const project = c => (c.Labels || '').match(/(?:^|,)com\.docker\.compose\.project=([^,]*)/)?.[1] || '';

// "About an hour" -> "~1 h", "23 minutes" -> "23 min", "Less than a second" -> "<1 s"
function dur(s) {
  if (/less than a second/i.test(s)) return '<1 s';
  const m = s.match(/(about )?(an?|\d+) (second|minute|hour|day|week|month|year)/i);
  if (!m) return s;
  const n = /^an?$/i.test(m[2]) ? 1 : +m[2], u = UNIT[m[3].toLowerCase()];
  return `${m[1] ? '~' : ''}${n} ${n > 1 && u === 'mês' ? 'meses' : n > 1 && u === 'ano' ? 'anos' : u}`;
}

// traduz o Status do docker: [texto, dica opcional]; o original fica no title
function status(c) {
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
const MAX_EXPAND = 8;
const ports = p => {
  const out = [];
  for (const [, h1, h2 = h1, c1, c2 = c1, proto] of p.matchAll(/:(\d+)(?:-(\d+))?->(\d+)(?:-(\d+))?\/(\w+)/g)) {
    const n = h2 - h1;
    if (n === c2 - c1 && n < MAX_EXPAND) for (let i = 0; i <= n; i++) out.push([`${+h1 + i}`, `${+c1 + i}`, proto]);
    else out.push([h1 === h2 ? h1 : `${h1}-${h2}`, c1 === c2 ? c1 : `${c1}-${c2}`, proto]);
  }
  return [...new Set(out.map(x => x.join(':')))].map(s => s.split(':'));
};

// "ghcr.io/acme/api:1.4" -> "acme/api:1.4": o host do registry raramente importa; a tag sim
const shortImage = img => img.replace(/^[^/]+[.:][^/]*\//, '');
const hasHealth = c => /\((un)?healthy\)|health: starting/.test(c.Status);
// no navegador não existe module; no Node os testes importam daqui
if (typeof module === 'object') {
  module.exports = {esc, EXIT, restartCode, tone, bucket, isProblem, project, dur, status, ports, MAX_EXPAND, shortImage, hasHealth};
}
