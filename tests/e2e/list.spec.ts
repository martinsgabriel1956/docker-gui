import { test, expect, ctr, compose, id, row, rowKeys } from './fixtures';

const shop = [
  ctr('api', { Labels: compose('shop', 'api') }),
  ctr('db', { Labels: compose('shop', 'db'), Status: 'Up 2 hours (healthy)' }),
  ctr('worker', { Labels: compose('shop', 'worker'), State: 'exited', Status: 'Exited (137) 2 minutes ago' }),
];
const loose = [
  ctr('cache'),
  ctr('cron', { State: 'exited', Status: 'Exited (0) 3 days ago' }),
  ctr('flaky', { Status: 'Up About an hour (unhealthy)' }),
];

test('problemas vão para a faixa de atenção e o resto fica agrupado por projeto compose', async ({ page, gui }) => {
  await gui.open({ containers: [...shop, ...loose] });
  await expect(page.locator('#rows')).toContainText('Precisa de atenção · 2');
  // faixa primeiro, depois os projetos, e os containers soltos por último; dentro de cada parte, ordem alfabética
  expect(await rowKeys(page)).toEqual([
    'h:attn', `c:${id('flaky')}`, `c:${id('worker')}`,
    'g:shop', `c:${id('api')}`, `c:${id('db')}`,
    'g:', `c:${id('cache')}`, `c:${id('cron')}`,
  ]);
  const head = page.locator('#rows tr[data-key="g:shop"]');
  await expect(head).toContainText('compose · 2 de 3 rodando');
  await expect(head).toContainText('1 na faixa de atenção ↑');
  await expect(page.locator('#rows tr[data-key="g:"]')).toContainText('Sem projeto compose');
});

test('contagem por estado e título da aba', async ({ page, gui }) => {
  await gui.open({ containers: [...shop, ...loose] });
  const pills = page.locator('#count button[data-a="filter"]');
  await expect(pills).toHaveText(['2 com problema', '3 rodando bem', '1 parado']);
  await expect(page).toHaveTitle('Docker GUI · 4 rodando · 2 com problema');
});

test('lista só de containers soltos dispensa cabeçalho', async ({ page, gui }) => {
  await gui.open({ containers: [ctr('a'), ctr('b')] });
  await expect(row(page, 'b')).toBeVisible();
  expect(await rowKeys(page)).toEqual([`c:${id('a')}`, `c:${id('b')}`]);
});

test('status do docker vem traduzido, com o original no title', async ({ page, gui }) => {
  await gui.open({
    containers: [
      ...shop, ...loose,
      ctr('loop', { State: 'restarting', Status: 'Restarting (1) 5 seconds ago' }),
      ctr('novo', { State: 'created', Status: 'Created' }),
      ctr('zumbi', { State: 'dead', Status: 'Dead' }),
      ctr('parado', { State: 'paused', Status: 'Up 3 minutes (Paused)' }),
    ],
  });
  const cases: [string, string][] = [
    ['worker', 'Saiu com código 137 há 2 minmorto à força ou sem memória (OOM)'],
    ['db', 'Rodando há 2 h · saudável'],
    ['flaky', 'Rodando há ~1 h · healthcheck falhando'],
    ['cron', 'Parado há 3 d'],
    ['loop', 'Reiniciando em loop · saiu com código 1erro da aplicação'],
    ['novo', 'Criado, nunca iniciado'],
    ['zumbi', 'Morto · só dá para remover'],
    ['parado', 'Pausado'],
  ];
  for (const [name, text] of cases) await expect(page.locator(`#st-${id(name)}`)).toHaveText(text);
  await expect(page.locator(`td[title="Exited (137) 2 minutes ago"]`)).toHaveCount(1);
});

test('botão principal depende do estado e Logs fica sempre no mesmo lugar', async ({ page, gui }) => {
  await gui.open({
    containers: [
      ctr('on'), ctr('off', { State: 'exited', Status: 'Exited (0) 1 hour ago' }),
      ctr('pausado', { State: 'paused', Status: 'Up 3 minutes (Paused)' }),
      ctr('zumbi', { State: 'dead', Status: 'Dead' }),
    ],
  });
  const actions = async (name: string) =>
    row(page, name).locator('button[data-a]:not([data-a^="m-"])').evaluateAll(bs => bs.map(b => b.textContent!.trim()));
  expect(await actions('on')).toEqual(['Parar', 'Logs']);
  expect(await actions('off')).toEqual(['Iniciar', 'Logs']);
  expect(await actions('pausado')).toEqual(['Retomar', 'Logs']);
  expect(await actions('zumbi')).toEqual(['Logs']);  // dead não inicia: só remove, pelo menu
});

test('imagem sem o host do registry, completa no title', async ({ page, gui }) => {
  await gui.open({ containers: [ctr('api', { Image: 'ghcr.io/acme/api:1.4' })] });
  const img = row(page, 'api').locator('div[title="ghcr.io/acme/api:1.4"]');
  await expect(img).toHaveText('acme/api:1.4');
});

test('porta HTTP abre no navegador; as outras copiam o endereço', async ({ page, context, gui }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await gui.open({
    containers: [
      ctr('web', { Ports: '0.0.0.0:8080->80/tcp, [::]:8080->80/tcp' }),
      ctr('pg', { Ports: '0.0.0.0:5432->5432/tcp' }),
      ctr('desligado', { State: 'exited', Status: 'Exited (0) 1 hour ago', Ports: '' }),
    ],
  });
  const link = row(page, 'web').locator('a[href^="http://localhost"]');
  await expect(link).toHaveCount(1);  // IPv4 e IPv6 da mesma porta viram um chip só
  await expect(link).toHaveAttribute('href', 'http://localhost:8080');
  await expect(link).toHaveAttribute('target', '_blank');

  await row(page, 'pg').getByRole('button', { name: 'Copiar localhost:5432 (porta 5432/tcp do container)' }).click();
  await expect(page.locator('#toast')).toHaveText('Copiado: localhost:5432');
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('localhost:5432');
});

test('porta HTTP de container parado não vira link', async ({ page, gui }) => {
  await gui.open({ containers: [ctr('web', { State: 'exited', Status: 'Exited (0) 1 hour ago', Ports: '0.0.0.0:8080->80/tcp' })] });
  await expect(row(page, 'web').getByRole('button', { name: /Copiar localhost:8080/ })).toBeVisible();
  await expect(row(page, 'web').locator('a')).toHaveCount(0);
});

test('faixa curta de portas vira um chip por porta; faixa longa vira um chip só, sem ação', async ({ page, gui }) => {
  await gui.open({
    containers: [
      ctr('front', { Ports: '0.0.0.0:4000-4003->4000-4003/tcp, [::]:4000-4003->4000-4003/tcp' }),
      ctr('media', { Ports: '0.0.0.0:20000-20099->20000-20099/udp' }),
    ],
  });
  const hrefs = await row(page, 'front').locator('a').evaluateAll(as => as.map(a => a.getAttribute('href')));
  expect(hrefs).toEqual(['http://localhost:4000', 'http://localhost:4001', 'http://localhost:4002', 'http://localhost:4003']);
  const media = row(page, 'media');
  await expect(media.locator('span[title^="Faixa de portas"]')).toHaveText('20000-20099→20000-20099/udp');
  await expect(media.locator('a, button[onclick^="copyAddr"]')).toHaveCount(0);
});

test('lista vazia explica como começar', async ({ page, gui }) => {
  await gui.open({ containers: [] });
  await expect(page.locator('#rows')).toHaveText('Nenhum container ainda. Crie um com docker run.');
  await expect(page.locator('#count')).toHaveText('0 containers');
});

test('no celular vira cards, sem rolagem horizontal', async ({ page, gui }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await gui.open({ containers: [...shop, ...loose] });
  await expect(row(page, 'api')).toBeVisible();
  await expect(page.locator('thead')).toBeHidden();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBe(0);
});

test('CPU e memória do docker stats aparecem só nos containers rodando, e atualizam sozinhos', async ({ page, gui }) => {
  const stats = { CPUPerc: '1.50%', MemUsage: '20MiB / 1.944GiB', MemPerc: '1.00%' };
  await gui.open({
    containers: [ctr('web', { stats }), ctr('pausado', { State: 'paused', Status: 'Up 3 minutes (Paused)', stats })],
  });
  const us = page.locator(`#us-${id('web')}`);
  await expect(us).toHaveText('CPU 1.50% · RAM 20MiB');
  await expect(us).toHaveAttribute('title', 'Memória: 20MiB / 1.944GiB (1.00%)');
  await expect(page.locator(`#st-${id('web')}`)).toHaveText('Rodando há 5 min');  // o status não muda
  await expect(page.locator(`#us-${id('pausado')}`)).toHaveCount(0);

  gui.update(s => { s.containers[0].stats = { ...stats, CPUPerc: '42.00%' }; });
  await expect(us).toHaveText('CPU 42.00% · RAM 20MiB', { timeout: 12_000 });  // o stats consulta a cada 5 s
});
