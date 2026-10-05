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

test('usage mostra CPU e a memória usada; o limite fica no title', () => {
  assert.deepEqual(f.usage({ID: 'a', CPUPerc: '0.52%', MemUsage: '10.5MiB / 1.944GiB', MemPerc: '0.53%'}),
                   ['CPU 0.52% · RAM 10.5MiB', 'Memória: 10.5MiB / 1.944GiB (0.53%)']);
});
