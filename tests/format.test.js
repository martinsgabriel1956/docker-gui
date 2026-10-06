// Testes das funções puras do front: node --test tests/format.test.js
// O Node (22.18+) remove os tipos do .ts sozinho, então não há build antes do teste.
// Os Status abaixo são strings reais do `docker ps`; se o formato do CLI mudar, é aqui que quebra.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as f from '../src/format.ts';

const c = (State, Status, extra = {}) => ({State, Status, ...extra});

test('dur traduz a duração do docker', () => {
  assert.equal(f.dur('5 minutes'), '5 min');
  assert.equal(f.dur('1 second'), '1 s');
  assert.equal(f.dur('About an hour'), '~1 h');
  assert.equal(f.dur('About a minute'), '~1 min');
  assert.equal(f.dur('Less than a second'), '<1 s');
  assert.equal(f.dur('3 days'), '3 d');
  assert.equal(f.dur('2 weeks'), '2 sem');
  assert.equal(f.dur('a month'), '1 mês');
  assert.equal(f.dur('2 months'), '2 meses');
  assert.equal(f.dur('3 years'), '3 anos');
  assert.equal(f.dur('algo estranho'), 'algo estranho');  // formato desconhecido passa intacto
});

test('tone classifica o estado', () => {
  assert.equal(f.tone(c('running', 'Up 5 minutes')), 'ok');
  assert.equal(f.tone(c('running', 'Up 2 hours (healthy)')), 'ok');
  assert.equal(f.tone(c('running', 'Up 10 seconds (health: starting)')), 'check');
  assert.equal(f.tone(c('running', 'Up About an hour (unhealthy)')), 'warn');
  assert.equal(f.tone(c('paused', 'Up 3 minutes (Paused)')), 'pause');
  assert.equal(f.tone(c('restarting', 'Restarting (0) Less than a second ago')), 'busy');
  assert.equal(f.tone(c('restarting', 'Restarting (1) 5 seconds ago')), 'bad');  // loop de crash
  assert.equal(f.tone(c('exited', 'Exited (0) 3 days ago')), 'off');
  assert.equal(f.tone(c('exited', 'Exited (137) 2 minutes ago')), 'bad');
  assert.equal(f.tone(c('dead', 'Dead')), 'bad');
  assert.equal(f.tone(c('created', 'Created')), 'off');
});

test('bucket separa o que precisa de atenção', () => {
  const cases = [
    [c('running', 'Up 5 minutes'), 'rodando'],
    [c('running', 'Up 10 seconds (health: starting)'), 'rodando'],
    [c('running', 'Up About an hour (unhealthy)'), 'problema'],
    [c('paused', 'Up 3 minutes (Paused)'), 'pausado'],
    [c('restarting', 'Restarting (0) Less than a second ago'), 'reiniciando'],
    [c('restarting', 'Restarting (1) 5 seconds ago'), 'problema'],
    [c('exited', 'Exited (0) 3 days ago'), 'parado'],
    [c('exited', 'Exited (1) 3 days ago'), 'problema'],
    [c('created', 'Created'), 'parado'],
    [c('dead', 'Dead'), 'problema'],
  ];
  for (const [ctr, want] of cases) {
    assert.equal(f.bucket(ctr), want, ctr.Status);
    assert.equal(f.isProblem(ctr), want === 'problema', ctr.Status);
  }
});

test('newProblems só devolve quem acabou de entrar na faixa de atenção', () => {
  const ok = c('running', 'Up 5 minutes', {ID: 'a'}), bad = c('exited', 'Exited (1) 1 second ago', {ID: 'b'});
  const sick = c('running', 'Up 1 hour (unhealthy)', {ID: 'c'});
  assert.deepEqual(f.newProblems(null, [ok, bad]), []);  // primeira leitura é só a base
  assert.deepEqual(f.newProblems(new Set(), [ok, bad]), [bad]);
  assert.deepEqual(f.newProblems(new Set(['b']), [ok, bad, sick]), [sick]);  // b já estava: não repete
  // continua na faixa, só mudou o motivo: também não repete
  assert.deepEqual(f.newProblems(new Set(['b']), [ok, c('restarting', 'Restarting (1) 2 seconds ago', {ID: 'b'})]), []);
});

test('status traduz o texto e explica o código de saída', () => {
  assert.deepEqual(f.status(c('running', 'Up 5 minutes')), ['Rodando há 5 min']);
  assert.deepEqual(f.status(c('running', 'Up 2 hours (healthy)')), ['Rodando há 2 h · saudável']);
  assert.deepEqual(f.status(c('running', 'Up About an hour (unhealthy)')), ['Rodando há ~1 h · healthcheck falhando']);
  assert.deepEqual(f.status(c('running', 'Up 10 seconds (health: starting)')), ['Rodando há 10 s · verificando saúde']);
  assert.deepEqual(f.status(c('paused', 'Up 3 minutes (Paused)')), ['Pausado']);
  assert.deepEqual(f.status(c('exited', 'Exited (0) 3 days ago')), ['Parado há 3 d']);
  assert.deepEqual(f.status(c('exited', 'Exited (137) 2 minutes ago')),
                   ['Saiu com código 137 há 2 min', 'morto à força ou sem memória (OOM)']);
  assert.deepEqual(f.status(c('exited', 'Exited (2) About an hour ago')), ['Saiu com código 2 há ~1 h', undefined]);
  assert.deepEqual(f.status(c('restarting', 'Restarting (1) 5 seconds ago')),
                   ['Reiniciando em loop · saiu com código 1', 'erro da aplicação']);
  assert.deepEqual(f.status(c('restarting', 'Restarting (0) Less than a second ago')), ['Reiniciando…']);
  assert.deepEqual(f.status(c('created', 'Created')), ['Criado, nunca iniciado']);
  assert.deepEqual(f.status(c('dead', 'Dead')), ['Morto · só dá para remover']);
});

test('restartCode e hasHealth', () => {
  assert.equal(f.restartCode(c('restarting', 'Restarting (139) 1 second ago')), 139);
  assert.equal(f.restartCode(c('running', 'Up 5 minutes')), 0);
  assert.equal(f.hasHealth(c('running', 'Up 2 hours (healthy)')), true);
  assert.equal(f.hasHealth(c('running', 'Up 2 hours (unhealthy)')), true);
  assert.equal(f.hasHealth(c('running', 'Up 1 second (health: starting)')), true);
  assert.equal(f.hasHealth(c('running', 'Up 5 minutes')), false);
});

test('ports lê só as portas publicadas e remove duplicata IPv4/IPv6', () => {
  assert.deepEqual(f.ports('0.0.0.0:5432->5432/tcp, [::]:5432->5432/tcp'), [['5432', '5432', 'tcp']]);
  assert.deepEqual(f.ports('0.0.0.0:8080->80/tcp, 0.0.0.0:5353->53/udp'), [['8080', '80', 'tcp'], ['5353', '53', 'udp']]);
  assert.deepEqual(f.ports('127.0.0.1:3000->3000/tcp'), [['3000', '3000', 'tcp']]);
  assert.deepEqual(f.ports('80/tcp'), []);  // exposta mas não publicada: não tem como abrir do host
  assert.deepEqual(f.ports(''), []);
});

// o docker só junta numa faixa a partir de 4 portas seguidas; abaixo disso lista uma por uma (formato acima)
test('ports abre faixa curta em uma entrada por porta', () => {
  assert.deepEqual(f.ports('0.0.0.0:3000-3003->3000-3003/tcp, [::]:3000-3003->3000-3003/tcp'),
                   [['3000', '3000', 'tcp'], ['3001', '3001', 'tcp'], ['3002', '3002', 'tcp'], ['3003', '3003', 'tcp']]);
  // defensivo: hoje o docker só agrupa quando host e container usam a mesma porta (com números
  // diferentes ele lista uma por uma), mas o parse não depende disso
  assert.deepEqual(f.ports('0.0.0.0:18000-18003->8000-8003/tcp'),
                   [['18000', '8000', 'tcp'], ['18001', '8001', 'tcp'], ['18002', '8002', 'tcp'], ['18003', '8003', 'tcp']]);
  assert.deepEqual(f.ports('127.0.0.1:5000-5003->5000-5003/udp, 0.0.0.0:8080->80/tcp').map(x => x.join(':')),
                   ['5000:5000:udp', '5001:5001:udp', '5002:5002:udp', '5003:5003:udp', '8080:80:tcp']);
});

test('ports mantém faixa longa numa entrada só', () => {
  const last = 9000 + f.MAX_EXPAND - 1, over = 9000 + f.MAX_EXPAND;
  assert.equal(f.ports(`0.0.0.0:9000-${last}->9000-${last}/tcp`).length, f.MAX_EXPAND);  // no limite ainda abre
  assert.deepEqual(f.ports(`0.0.0.0:9000-${over}->9000-${over}/tcp`), [[`9000-${over}`, `9000-${over}`, 'tcp']]);
  assert.deepEqual(f.ports('0.0.0.0:20000-20999->20000-20999/udp, [::]:20000-20999->20000-20999/udp'),
                   [['20000-20999', '20000-20999', 'udp']]);
});

test('ports não abre faixas de tamanhos diferentes', () => {
  // o docker não gera isso hoje; se gerar, mostra como está em vez de inventar o pareamento
  assert.deepEqual(f.ports('0.0.0.0:7000-7003->80/tcp'), [['7000-7003', '80', 'tcp']]);
});

test('project lê o label do compose sem quebrar nas vírgulas do depends_on', () => {
  const labels = 'com.docker.compose.depends_on=db:service_started:false,redis:service_started:false,'
               + 'com.docker.compose.project=shop,com.docker.compose.service=api';
  assert.equal(f.project({Labels: labels}), 'shop');
  assert.equal(f.project({Labels: 'com.docker.compose.project=shop'}), 'shop');
  assert.equal(f.project({Labels: 'xcom.docker.compose.project=falso'}), '');
  assert.equal(f.project({Labels: 'maintainer=alguem'}), '');
  assert.equal(f.project({Labels: ''}), '');
  assert.equal(f.project({}), '');
});

test('workingDir lê a pasta do projeto compose', () => {
  const labels = 'com.docker.compose.project=shop,com.docker.compose.project.working_dir=/srv/shop,'
               + 'com.docker.compose.project.config_files=/srv/shop/a.yml,/srv/shop/b.yml';
  assert.equal(f.workingDir({Labels: labels}), '/srv/shop');
  assert.equal(f.project({Labels: labels}), 'shop');
  assert.equal(f.workingDir({Labels: 'com.docker.compose.project=shop'}), '');
  assert.equal(f.workingDir({}), '');
});

test('service lê o serviço do compose sem confundir com outros labels', () => {
  const labels = 'com.docker.compose.depends_on=db:service_started:false,redis:service_started:false,'
               + 'com.docker.compose.project=shop,com.docker.compose.service=api,com.docker.compose.service.extra=x';
  assert.equal(f.service({Labels: labels}), 'api');
  assert.equal(f.service({Labels: 'com.docker.compose.service=db'}), 'db');
  assert.equal(f.service({Labels: 'xcom.docker.compose.service=falso'}), '');
  assert.equal(f.service({Labels: 'com.docker.compose.project=shop'}), '');
  assert.equal(f.service({}), '');
});

test('shortImage tira o host do registry e mantém a tag', () => {
  assert.equal(f.shortImage('ghcr.io/acme/api:1.4'), 'acme/api:1.4');
  assert.equal(f.shortImage('localhost:5000/app:dev'), 'app:dev');
  assert.equal(f.shortImage('nginx:alpine'), 'nginx:alpine');
  assert.equal(f.shortImage('acme/api'), 'acme/api');  // usuário do Docker Hub não é host
});

test('esc neutraliza HTML', () => {
  assert.equal(f.esc(`<img src=x onerror="alert('x')">&`),
               '&#60;img src=x onerror=&#34;alert(&#39;x&#39;)&#34;&#62;&#38;');
  assert.equal(f.esc(42), '42');
});

test('todo código de saída explicado tem texto', () => {
  for (const [code, txt] of Object.entries(f.EXIT)) assert.ok(txt.length > 3, code);
});

test('usage mostra CPU e a memória usada; o limite, a rede e o disco ficam no title', () => {
  assert.deepEqual(f.usage({ID: 'a', CPUPerc: '0.52%', MemUsage: '10.5MiB / 1.944GiB', MemPerc: '0.53%'}),
                   ['CPU 0.52%', 'RAM 10.5MiB', 'Memória: 10.5MiB / 1.944GiB (0.53%)']);
  assert.equal(f.usage({ID: 'a', CPUPerc: '0.52%', MemUsage: '10.5MiB / 1.944GiB', MemPerc: '0.53%',
                        NetIO: '1.2kB / 648B', BlockIO: '0B / 4.1kB'})[2],
               'Memória: 10.5MiB / 1.944GiB (0.53%)\nRede: 1.2kB recebidos · 648B enviados\nDisco: 0B lidos · 4.1kB gravados');
});

test('bytes entende as unidades binárias do docker e as decimais do podman', () => {
  assert.equal(f.bytes('10.5MiB'), 10.5 * 2 ** 20);
  assert.equal(f.bytes('1.944GiB'), 1.944 * 2 ** 30);
  assert.equal(f.bytes('512KiB'), 512 * 1024);
  assert.equal(f.bytes('0B'), 0);
  assert.equal(f.bytes('1.2kB'), 1200);   // rede e disco do docker, e tudo no podman
  assert.equal(f.bytes('10.5MB'), 10.5e6);
  assert.equal(f.bytes(' 2GB '), 2e9);
  assert.equal(f.bytes('--'), null);
  assert.equal(f.bytes('10.5 parsecs'), null);
});

test('percent lê o CPUPerc e recusa o "--" de quem ainda não mediu', () => {
  assert.equal(f.percent('0.52%'), 0.52);
  assert.equal(f.percent('142.30%'), 142.3);  // mais de um núcleo passa de 100
  assert.equal(f.percent('--'), null);
  assert.equal(f.percent(''), null);
});

test('fmtBytes mostra memória em unidade binária', () => {
  assert.equal(f.fmtBytes(0), '0 B');
  assert.equal(f.fmtBytes(512), '512 B');
  assert.equal(f.fmtBytes(10.5 * 2 ** 20), '10.5 MiB');
  assert.equal(f.fmtBytes(300 * 2 ** 20), '300 MiB');
  assert.equal(f.fmtBytes(1.5 * 2 ** 30), '1.5 GiB');
});

test('pair e io separam rede e disco; campo ausente ou estranho some', () => {
  assert.deepEqual(f.pair('1.2kB / 648B'), ['1.2kB', '648B']);
  assert.deepEqual(f.pair('10.5MB / 2.06GB'), ['10.5MB', '2.06GB']);  // podman
  assert.equal(f.pair('-- / --'), null);
  assert.equal(f.pair(undefined), null);
  assert.deepEqual(f.io({NetIO: '1.2kB / 648B', BlockIO: '0B / 4.1kB'}),
                   ['Rede: 1.2kB recebidos · 648B enviados', 'Disco: 0B lidos · 4.1kB gravados']);
  assert.deepEqual(f.io({NetIO: '-- / --', BlockIO: '0B / 0B'}), ['Disco: 0B lidos · 0B gravados']);
  assert.deepEqual(f.io({}), []);
});

test('pushSample guarda as últimas N leituras sem mexer no array anterior', () => {
  const s = t => ({t, cpu: t, mem: t});
  let buf = [];
  for (let t = 0; t < 70_000; t += 1000) buf = f.pushSample(buf, s(t), 60);
  assert.equal(buf.length, 60);
  assert.equal(buf[0].t, 10_000);
  assert.equal(buf.at(-1).t, 69_000);
  const before = buf, after = f.pushSample(buf, s(70_000), 60);
  assert.equal(before.length, 60);
  assert.equal(before.at(-1).t, 69_000);
  assert.equal(after.at(-1).t, 70_000);
  assert.equal(f.HISTORY, 60);
});

test('pushSample recomeça a série depois de um buraco (aba escondida, servidor fora)', () => {
  const buf = [{t: 0, cpu: 1, mem: 1}, {t: 5000, cpu: 2, mem: 2}];
  assert.equal(f.pushSample(buf, {t: 10_000, cpu: 3, mem: 3}).length, 3);
  assert.deepEqual(f.pushSample(buf, {t: 60_000, cpu: 3, mem: 3}), [{t: 60_000, cpu: 3, mem: 3}]);
});

test('sparkPoints ocupa a largura toda e escala de 0 ao máximo', () => {
  // janela de 3 leituras em 40 px: cada uma ocupa 20 px; 14 px de altura com 1 de margem
  assert.equal(f.sparkPoints([0, 5, 10], 40, 14, 3), '0,13 20,7 40,1');
  // série menor que a janela se estica até ela encher; sem variação, fica no meio da altura (no pé parecia sublinhado)
  assert.equal(f.sparkPoints([10, 10], 40, 14, 3), '0,7 40,7');
  assert.equal(f.sparkPoints([0, 0], 40, 14, 3), '0,7 40,7');  // tudo zero não divide por zero
  assert.equal(f.sparkPoints([1, 2, 3], 40, 14, 60), '0,9 20,5 40,1');
  // piso: 0,5% de CPU com piso de 1% fica na metade, não no topo
  assert.equal(f.sparkPoints([0.5, 1], 40, 14, 3, 1), '0,7 40,1');
});

test('trend descreve o sparkline em palavras', () => {
  const pct = n => `${n.toFixed(2)}%`;
  assert.equal(f.trend('CPU', [1, 3, 2], 10_000, pct), 'CPU nos últimos 10 s: mín 1.00%, máx 3.00%, agora 2.00%');
  assert.equal(f.trend('CPU', [1, 2], 200, pct), 'CPU nos últimos 1 s: mín 1.00%, máx 2.00%, agora 2.00%');
  assert.equal(f.trend('Memória', [2 ** 20, 2 ** 21], 295_000, f.fmtBytes),
               'Memória nos últimos 5 min: mín 1.0 MiB, máx 2.0 MiB, agora 2.0 MiB');
});

test('age escreve a idade a partir do epoch', () => {
  const now = 1_800_000_000, ago = s => now - s;
  assert.equal(f.age(ago(10), now), '<1 min');
  assert.equal(f.age(ago(5 * 60), now), '5 min');
  assert.equal(f.age(ago(3 * 3600), now), '3 h');
  assert.equal(f.age(ago(47 * 3600), now), '47 h');
  assert.equal(f.age(ago(3 * 86400), now), '3 d');
  assert.equal(f.age(ago(20 * 86400), now), '2 sem');
  assert.equal(f.age(ago(100 * 86400), now), '3 meses');
  assert.equal(f.age(ago(800 * 86400), now), '2 anos');
});

// mensagens reais do docker 29 e do podman
test('rmHint explica por que a remoção falhou', () => {
  const inUse = 'Em uso: remova o container que usa (ou tire ele da rede) antes.';
  for (const msg of [
    'Error response from daemon: conflict: unable to delete fd7dc98638c8 (cannot be forced) - image is being used by running container e0a85417a665',
    'Error response from daemon: conflict: unable to delete fd7dc98638c8 (must be forced) - image is being used by stopped container e0a85417a665',
    'Error response from daemon: remove pgdata: volume is in use - [8341cdc825766a6d]',
    'Error response from daemon: error while removing network: network loja_default has active endpoints (name:"web" id:"55e1ed46acab")',
    'Error: image used by 3f1c2b9a8e7d: image is in use by a container: consider listing external containers and force-removing image',
    'Error: volume pgdata is being used by the following container(s): 3f1c2b9a8e7d: volume is being used',
    'Error: "loja_default" has associated containers with it. Use -f to forcibly delete containers and pods: network is being used',
  ]) assert.equal(f.rmHint(msg), inUse, msg);
  assert.match(f.rmHint('Error response from daemon: conflict: unable to delete 3e58ae0f7a49 (must be forced) - image is referenced in multiple repositories'), /mais de uma tag/);
  assert.match(f.rmHint('Error response from daemon: conflict: unable to delete 3e58ae0f7a49 (cannot be forced) - image has dependent child images'), /construídas sobre esta/);
  assert.equal(f.rmHint('Error response from daemon: get pgdata: no such volume'), '');
});

test('logFilter busca o texto literal, sem diferenciar maiúsculas', () => {
  assert.equal(f.logFilter(''), null);
  const re = f.logFilter('erro');
  assert.deepEqual('Erro: deu ERRO e erro'.split(re), ['', 'Erro', ': deu ', 'ERRO', ' e ', 'erro', '']);
  assert.deepEqual('tudo certo'.split(re), ['tudo certo']);  // não casou: a linha inteira, sozinha
  // caractere especial de regex vale como texto
  assert.deepEqual('GET /a?b=1 (x) [y] a.b*c'.split(f.logFilter('?b=1 (x) [y]')), ['GET /a', '?b=1 (x) [y]', ' a.b*c']);
  assert.deepEqual('a.b axb'.split(f.logFilter('a.b')), ['', 'a.b', ' axb']);
  assert.deepEqual('C:\\tmp\\x $HOME ^|'.split(f.logFilter('\\tmp\\')), ['C:', '\\tmp\\', 'x $HOME ^|']);
  assert.deepEqual('${x} ^|'.split(f.logFilter('${x} ^|')), ['', '${x} ^|', '']);
});

// criar container: as mesmas regras do run_argv do servidor (RunArgvTest em tests/test_docker_gui.py)
const form = (o = {}) => ({image: 'nginx', name: '', ports: '', all_interfaces: false, env: '', restart: 'no', volume: '', ...o});
const errs = o => f.runSpec(form(o)).errors;

test('runSpec monta o corpo do POST /api/run', () => {
  assert.deepEqual(f.runSpec(form({
    image: ' ghcr.io/acme/api:1.4 ', name: 'api', ports: '8080:80, 5353:53/udp\n9000:9000/tcp', all_interfaces: true,
    env: 'A=1\n\n# comentário\nB=x=y\r\nMSG=olá; $(id)\nVAZIA=', restart: 'unless-stopped', volume: 'dados:/var/lib/x',
  })), {
    spec: {image: 'ghcr.io/acme/api:1.4', name: 'api', ports: ['8080:80', '5353:53/udp', '9000:9000/tcp'], all_interfaces: true,
           env: ['A=1', 'B=x=y', 'MSG=olá; $(id)', 'VAZIA='], restart: 'unless-stopped', volume: 'dados:/var/lib/x'},
    errors: {},
  });
  assert.deepEqual(f.runSpec(form()).spec, {image: 'nginx', name: '', ports: [], all_interfaces: false, env: [], restart: 'no', volume: ''});
});

test('runSpec aceita as imagens que o docker aceita', () => {
  for (const image of ['nginx', 'nginx:1.25-alpine', 'library/nginx:latest', 'localhost:5000/minha_app:v1.0',
                       'registry-1.example.com:443/a/b/c', 'my.app__x-y', `redis@sha256:${'a'.repeat(64)}`, `redis:7@sha256:${'0'.repeat(64)}`])
    assert.deepEqual(errs({image}), {}, image);
});

test('runSpec recusa imagem que vira flag ou foge do formato', () => {
  for (const image of ['', '-it', '--privileged', '--network=host', 'nginx --privileged', 'nginx;id', 'Nginx', 'nginx:',
                       ':latest', 'nginx:-x', 'nginx@sha256:abc', '../nginx', '/nginx', 'a//b', 'nginx$(id)', 'a'.repeat(600)])
    assert.ok(errs({image}).image, image);
});

test('runSpec confere nome, portas, env, restart e volume', () => {
  for (const name of ['a', '-x', '--privileged', '.web', 'web app', 'web;id', 'web/x', 'wéb', 'x'.repeat(129)])
    assert.ok(errs({name}).name, name);
  for (const ports of ['8080', '0:80', '65536:80', '8080:80/sctp', '127.0.0.1:8080:80', '8080-8090:80', '-p', '8080:80 8080:81'])
    assert.ok(errs({ports}).ports, ports);
  assert.deepEqual(errs({ports: '53:53/tcp 53:53/udp'}), {});  // tcp e udp não colidem
  for (const env of ['A', '=x', '1A=x', 'A-B=x', '-e=x', 'A.B=x', ' A=x', 'A=1\nA=2', `A=${'x'.repeat(f.MAX_ENV_VALUE + 1)}`])
    assert.ok(errs({env}).env, env);
  for (const restart of ['', 'ALWAYS', 'on-failure:3', 'sempre']) assert.ok(errs({restart}).restart, restart);
  for (const r of f.RESTART) assert.deepEqual(errs({restart: r}), {}, r);
  for (const volume of ['/etc:/x', './data:/data', '~/d:/d', 'data', 'data:rel', 'data:/', 'data:/x:ro', 'data:/x,type=bind',
                        'data:/a/../b', 'C:/data', '-v:/x', 'data:/a b'])
    assert.ok(errs({volume}).volume, volume);
  assert.deepEqual(errs({volume: 'pg.data_1:/var/lib/postgresql/data'}), {});
});

test('bulkSummary junta sucessos e falhas num aviso só', () => {
  assert.equal(f.bulkSummary('parado', 3, []), '3 parados.');
  assert.equal(f.bulkSummary('removido', 1, []), '1 removido.');
  assert.equal(f.bulkSummary('parado', 3, [['web', 'Error response from daemon: permission denied\n']]),
               '3 parados, 1 falhou: web: Error response from daemon: permission denied.');
  // só a primeira linha do erro, sem ponto duplicado; mensagem vazia não some
  assert.equal(f.bulkSummary('iniciado', 0, [['a', 'deu ruim.\ndetalhe'], ['b', '']]), '2 falharam: a: deu ruim; b: erro sem mensagem.');
  assert.equal(f.bulkSummary('parado', 1, [['a', 'x'], ['b', 'y'], ['c', 'z'], ['d', 'w']]), '1 parado, 4 falharam: a: x; b: y; e mais 2.');
});

test('logLevel acha o nível pela palavra em maiúsculas, pelo level= e pelo [error] do nginx', () => {
  assert.equal(f.logLevel('2026-10-05T19:03:40Z ERROR db: connection refused'), 'bad');
  assert.equal(f.logLevel('api-1  | 2026-10-05T19:03:40Z FATAL boom'), 'bad');
  assert.equal(f.logLevel('time=1 level=error msg="falhou"'), 'bad');
  assert.equal(f.logLevel('{"level":"error","msg":"x"}'), 'bad');
  assert.equal(f.logLevel('2026/10/05 [error] 7#7: *1 open() failed'), 'bad');
  assert.equal(f.logLevel('Error: Cannot find module x'), 'bad');
  assert.equal(f.logLevel('2026-10-05 WARN slow query 812ms'), 'warn');
  assert.equal(f.logLevel('level=warning msg=x'), 'warn');
  assert.equal(f.logLevel('2026-10-05 DEBUG cache miss'), 'dim');
  assert.equal(f.logLevel('{"level":"debug"}'), 'dim');
  // palavra comum no meio da frase não é nível
  assert.equal(f.logLevel('processed 10 jobs, 0 errors'), '');
  assert.equal(f.logLevel('a warning about deprecation'), '');
  assert.equal(f.logLevel('INFO server listening on :8080'), '');
});

test('reclaimShare lê a porcentagem do df ou faz a conta pelos tamanhos', () => {
  const d = (Size, Reclaimable) => ({Type: 'Images', TotalCount: '1', Active: '0', Size, Reclaimable});
  assert.equal(f.reclaimShare(d('5.2GB', '2.1GB (40%)')), 0.4);
  assert.equal(f.reclaimShare(d('3.3GB', '3.3GB')), 1);
  assert.equal(f.reclaimShare(d('2GB', '500MB')), 0.25);
  assert.equal(f.reclaimShare(d('0B', '0B')), null);
  assert.equal(f.reclaimShare(d('1GB', '2GB')), 1);  // o df às vezes conta mais liberável que o total
});

test('prunedVolumes: sem uso; no Docker só os anônimos, no Podman os nomeados também', () => {
  const anon = 'a'.repeat(64), vs = [{Name: anon, Driver: 'local', Containers: []}, {Name: 'dados', Driver: 'local', Containers: []},
                                     {Name: 'b'.repeat(64), Driver: 'local', Containers: ['web']}];
  assert.deepEqual(f.prunedVolumes(vs, false).map(v => v.Name), [anon]);
  assert.deepEqual(f.prunedVolumes(vs, true).map(v => v.Name), [anon, 'dados']);
});

test('sparkPoints põe série sem variação no meio da altura', () => {
  assert.equal(f.sparkPoints([5, 5, 5], 48, 14, 3), '0,7 24,7 48,7');
});

test('logLevel entende o nível numérico do pino e do bunyan, e o severity e o lvl', () => {
  assert.equal(f.logLevel('{"level":50,"time":1,"msg":"boom"}'), 'bad');
  assert.equal(f.logLevel('{"level": 60,"msg":"fatal"}'), 'bad');
  assert.equal(f.logLevel('{"level":40,"msg":"devagar"}'), 'warn');
  assert.equal(f.logLevel('{"level":20,"msg":"detalhe"}'), 'dim');
  assert.equal(f.logLevel('{"level":30,"msg":"ok"}'), '');
  assert.equal(f.logLevel('{"level":500,"msg":"ok"}'), '');  // número que não é nível do pino
  assert.equal(f.logLevel('{"severity":"ERROR","message":"x"}'), 'bad');
  assert.equal(f.logLevel('lvl=warn msg=x'), 'warn');
  assert.equal(f.logLevel('zoom level: 50'), '');  // fora de JSON, número não é nível
});

test('actionHint traduz as falhas comuns ao iniciar ou criar', () => {
  for (const msg of [
    'Error response from daemon: failed to set up container networking: driver failed programming external connectivity on endpoint web (abc): Bind for 0.0.0.0:8080 failed: port is already allocated',
    'Error response from daemon: ports are not available: exposing port TCP 0.0.0.0:8080 -> 127.0.0.1:0: listen tcp4 0.0.0.0:8080: bind: address already in use',
    'Error: rootlessport listen tcp 0.0.0.0:8080: bind: address already in use',  // podman
  ]) assert.match(f.actionHint(msg), /porta 8080 do host já está em uso/, msg);
  assert.match(f.actionHint('docker: Error response from daemon: Conflict. The container name "/web" is already in use by container "abc". You have to remove (or rename) that container to be able to reuse that name.'),
               /chamado web:/);
  assert.match(f.actionHint('Error: creating container storage: the container name "web" is already in use by abc'), /chamado web:/);
  for (const msg of [
    "docker: Error response from daemon: pull access denied for nao-existe, repository does not exist or may require 'docker login'",
    'docker: Error response from daemon: manifest for nginx:999 not found: manifest unknown: manifest unknown',
    'Error: initializing source docker://foo:latest: reading manifest latest in docker.io/library/foo: requested access to the resource is denied',
  ]) assert.match(f.actionHint(msg), /não existe ou é privada/, msg);
  assert.match(f.actionHint('Error response from daemon: network loja_default not found'), /rede loja_default não existe mais/);
  assert.match(f.actionHint('write /var/lib/docker/tmp/x: no space left on device'), /Disco cheio/);
  assert.equal(f.actionHint('Error response from daemon: No such container: abc'), '');
  assert.equal(f.actionHint(''), '');
});

test('eventText e historySummary contam o que aconteceu com o container', () => {
  const ev = (a, extra = {}) => ({t: 1, a, code: null, health: '', ...extra});
  assert.deepEqual(f.eventText(ev('die', {code: 137})), ['saiu com código 137 · morto à força ou sem memória (OOM)', 'bad']);
  assert.deepEqual(f.eventText(ev('die', {code: 3})), ['saiu com código 3', 'bad']);
  assert.deepEqual(f.eventText(ev('die', {code: 0})), ['parou', 'off']);
  assert.deepEqual(f.eventText(ev('start')), ['subiu', 'ok']);
  assert.deepEqual(f.eventText(ev('oom')), ['ficou sem memória (OOM)', 'bad']);
  assert.deepEqual(f.eventText(ev('health_status', {health: 'unhealthy'})), ['healthcheck começou a falhar', 'warn']);
  assert.deepEqual(f.eventText(ev('health_status', {health: 'starting'})), ['healthcheck: starting', 'check']);
  const loop = [ev('start'), ev('die', {code: 1}), ev('start'), ev('oom'), ev('die', {code: 137}), ev('start'), ev('die', {code: 0})];
  assert.equal(f.historySummary(loop), 'subiu 3× · caiu 2× · 1 OOM');  // o die com 0 é parada, não queda
  assert.equal(f.historySummary([ev('pause')]), '');
});

test('healthChanges deixa só a mudança de saúde (o podman avisa a cada probe)', () => {
  const h = (health, t) => ({t, a: 'health_status', code: null, health});
  const evs = [h('healthy', 1), h('healthy', 2), {t: 3, a: 'start', code: null, health: ''}, h('healthy', 4), h('unhealthy', 5), h('unhealthy', 6)];
  assert.deepEqual(f.healthChanges(evs).map(e => e.t), [1, 3, 5]);
});

test('topTable separa as colunas do docker top e deixa o comando inteiro', () => {
  const out = 'UID                 PID                 PPID                C                   STIME               TTY                 TIME                CMD\n'
            + '70                  104584              104560              0                   out05               ?                   00:00:02            postgres: background writer\n'
            + 'root                7                   1                   0                   10:00               ?                   00:00:00            sh -c echo  oi\n';
  assert.deepEqual(f.topTable(out), [
    ['UID', 'PID', 'PPID', 'C', 'STIME', 'TTY', 'TIME', 'CMD'],
    ['70', '104584', '104560', '0', 'out05', '?', '00:00:02', 'postgres: background writer'],
    ['root', '7', '1', '0', '10:00', '?', '00:00:00', 'sh -c echo  oi'],
  ]);
  assert.deepEqual(f.topTable(''), []);
});
