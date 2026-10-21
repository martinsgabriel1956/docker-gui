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
  await expect(head).toContainText('1 na faixa de atenção, acima');
  await expect(page.locator('#rows tr[data-key="g:"]')).toContainText('Sem projeto compose');
});

test('o cabeçalho diz em qual daemon a página age, em âmbar quando é remoto', async ({ page, gui }) => {
  await gui.open({ containers: [ctr('web')] });
  const where = page.locator('#where');
  await expect(where).toHaveText('docker · default');
  await expect(where).toHaveClass(/text-muted/);
  await expect(page).toHaveTitle('Stivo · 1 rodando bem');  // o default não entra no título
  await gui.stop();

  await gui.open({
    containers: [ctr('web', { Ports: '0.0.0.0:8080->80/tcp, :::8080->80/tcp, 127.0.0.1:5432->5432/tcp' })],
    context: { Name: 'producao', Host: 'tcp://10.0.0.5:2376' },
  });
  await expect(page.locator('#remote')).toContainText('Daemon remoto producao (tcp://10.0.0.5:2376)');
  // a porta abre pelo host do daemon; a que está no loopback de lá não abre daqui, então o chip só informa
  await expect(row(page, 'web').getByRole('link')).toHaveAttribute('href', 'http://10.0.0.5:8080');
  await expect(row(page, 'web').locator('span[title^="Só no loopback do daemon remoto producao"]')).toHaveText('5432→5432');
  await expect(where).toHaveText('docker · producao, daemon remoto em tcp://10.0.0.5:2376');  // o sr-only conta
  await expect(where).toHaveClass(/text-warn-fg/);
  await expect(where).toHaveAttribute('title', 'Daemon em tcp://10.0.0.5:2376');
  await expect(page).toHaveTitle('Stivo · producao · 1 rodando bem');
  // o aviso e a confirmação também dizem onde
  await page.getByRole('button', { name: 'Parar web' }).click();
  await expect(page.locator('#toast')).toContainText('producao · web parado.');
  await page.locator('summary[aria-label="Mais ações para web"]').click();
  await page.getByRole('button', { name: 'Remover…' }).click();
  await expect(page.locator('#armdock')).toContainText('producao · Remover web de vez?');
  await expect(page.locator('#shown')).toContainText('No daemon remoto producao: Clique em Remover para apagar web de vez.');
});

test('quem caiu mostra a última linha do log na faixa de atenção', async ({ page, gui }) => {
  // stdout e stderr chegam separados: a ordem certa vem do timestamp, não da posição
  const logs = '2026-10-05T12:00:01.000000000Z booting\n2026-10-05T12:00:03.000000000Z FATAL: out of memory\n'
    + '2026-10-05T12:00:02.000000000Z loading cache\n';
  await gui.open({ containers: [ctr('web', { State: 'exited', Status: 'Exited (137) 2 minutes ago', logs }), ctr('ok', { logs })] });
  await expect(row(page, 'web')).toContainText('Abrir os logs. Última linha: FATAL: out of memory');
  await expect(row(page, 'ok')).not.toContainText('Última linha do log');  // quem está de pé não precisa
});

test('? mostra a lista de atalhos', async ({ page, gui }) => {
  await gui.open({ containers: [ctr('web')] });
  await page.locator('body').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('?');
  await expect(page.locator('#hint')).toBeVisible();
  await expect(page.locator('#hint')).toContainText('desfaz a última ação');
  await page.keyboard.press('Escape');
  await expect(page.locator('#hint')).toBeHidden();
});

test('contagem por estado e título da aba', async ({ page, gui }) => {
  await gui.open({ containers: [...shop, ...loose] });
  const pills = page.locator('#count button[data-a="filter"]');
  await expect(pills).toHaveText(['2 com problema', '3 rodando bem', '1 parado']);
  await expect(page).toHaveTitle('Stivo · 3 rodando bem · 2 com problema');  // as palavras das contagens
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
    // com o inspect de quem caiu, o 137 diz a causa (o docker falso não marca OOMKilled)
    ['worker', 'Saiu com código 137 há 2 minmorto à força (SIGKILL), não por falta de memória'],
    ['db', 'Rodando há 2 h · saudável'],
    ['flaky', 'Rodando há ~1 h · healthcheck falhando'],
    ['cron', 'Parado há 3 d'],
    ['loop', 'Reiniciando em loop · saiu com código 1erro da aplicação (veja o log)'],
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
    row(page, name).locator('button[data-a]:not([data-a^="m-"])').evaluateAll(bs => bs.map(b => b.textContent!.trim() || b.getAttribute('aria-label')));
  expect(await actions('on')).toEqual(['Parar', 'Reiniciar on', 'Logs']);  // o Reiniciar é um ícone, à vista só rodando
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
  await expect(page.locator('#rows')).toHaveText('Nenhum container ainda. Crie um em “Novo container” ou com docker run.');
  await expect(page.locator('#count')).toHaveText('0 containers');
});

test('no celular vira cards, sem rolagem horizontal', async ({ page, gui }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await gui.open({ containers: [...shop, ...loose] });
  await expect(row(page, 'api')).toBeVisible();
  // do cabeçalho da tabela só fica o "selecionar todos"; os nomes das colunas somem
  await expect(page.locator('thead th').filter({ visible: true })).toHaveCount(1);
  await expect(page.getByRole('checkbox', { name: 'Selecionar todos os visíveis' })).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);  // negativo: o espaço reservado da barra de rolagem
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

test('quem saiu com 137 diz se foi falta de memória, pelo inspect, e quantas vezes reiniciou', async ({ page, gui }) => {
  await gui.open({ containers: [
    ctr('api', { State: 'exited', Status: 'Exited (137) 2 minutes ago', inspect: { State: { OOMKilled: true }, RestartCount: 2 } }),
    ctr('worker', { State: 'exited', Status: 'Exited (137) 2 minutes ago', inspect: { State: { OOMKilled: false } } }),
  ] });
  await expect(row(page, 'api')).toContainText('sem memória (OOM) · reiniciou 2 vezes');
  await expect(row(page, 'worker')).toContainText('morto à força (SIGKILL), não por falta de memória');
  await page.getByRole('button', { name: 'Logs api' }).click();
  await expect(page.locator('#dlg-status')).toContainText('sem memória (OOM) · reiniciou 2 vezes');
});

test('queda antiga marcada como vista sai da faixa de atenção, e o Desfazer devolve', async ({ page, gui }) => {
  const job = ctr('migrate', { State: 'exited', Status: 'Exited (1) 2 days ago', logs: 'erro: tabela já existe\n',
                               inspect: { State: { FinishedAt: '2026-10-04T10:00:00Z' } } });
  await gui.open({ containers: [ctr('web'), job] });
  const band = page.locator('#rows tr[data-key="h:attn"]');
  await expect(band).toContainText('Precisa de atenção · 1');
  await expect(page).toHaveTitle('Stivo · 1 rodando bem · 1 com problema');
  await row(page, 'migrate').getByRole('button', { name: 'Marcar a queda de migrate como vista: sai da faixa de atenção' }).click();
  await expect(band).toHaveCount(0);
  // continua vermelho e contado como problema: só não grita mais na faixa
  await expect(page.locator(`#st-${id('migrate')}`)).toContainText('Saiu com código 1');
  await expect(page).toHaveTitle('Stivo · 1 rodando bem · 1 com problema');
  await expect(page.locator('#toast')).toContainText('migrate saiu da faixa de atenção. Volta para lá se cair de novo.');
  await page.locator('#toast').getByRole('button', { name: 'Desfazer' }).click();
  await expect(band).toContainText('Precisa de atenção · 1');
});

test('na faixa, a última linha do log abre os logs e o Logs tem contorno', async ({ page, gui }) => {
  await gui.open({ containers: [ctr('web', { State: 'exited', Status: 'Exited (137) 1 minute ago', logs: 'FATAL: out of memory\n' })] });
  const logs = row(page, 'web').getByRole('button', { name: 'Logs web' });
  await expect(logs).toHaveClass(/ring-accent\/40/);
  await row(page, 'web').getByRole('button', { name: 'Abrir os logs. Última linha: FATAL: out of memory' }).click();
  await expect(page.locator('#dlg')).toBeVisible();
  await expect(page.locator('#lt')).toHaveText('web');
});

test('janela estreita (760px, ao lado do editor) com mouse: tabela compacta, sem virar card', async ({ page, gui }) => {
  await page.setViewportSize({ width: 760, height: 800 });
  await gui.open({ containers: [...shop, ...loose, ctr('site', { Ports: '0.0.0.0:8080->80/tcp' })] });
  // o cabeçalho continua (Nome, Status e as ações); imagem e portas descem para baixo do nome
  await expect(page.locator('thead th').filter({ visible: true })).toHaveCount(3);
  await expect(row(page, 'site').getByRole('link', { name: /Abrir localhost:8080/ })).toHaveCount(1);
  await expect(row(page, 'site').getByRole('rowheader')).toContainText('site:latest');
  // alvo de toque só no toque: com mouse, o botão fica baixo
  const h = await row(page, 'api').getByRole('button', { name: 'Logs api' }).evaluate(b => b.getBoundingClientRect().height);
  expect(h).toBeLessThan(30);
  await expect(page.getByRole('button', { name: /Atalhos/ })).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);  // negativo: o espaço reservado da barra de rolagem
});

test('o cabeçalho do projeto conta quem está pausado ou reiniciando, e a aba Containers tem a contagem', async ({ page, gui }) => {
  await gui.open({ containers: [
    ctr('a', { Labels: compose('p', 'a') }), ctr('b', { Labels: compose('p', 'b'), State: 'paused', Status: 'Up 1 hour (Paused)' })] });
  await expect(page.locator('#rows tr[data-key="g:p"]')).toContainText('compose · 1 de 2 rodando · 1 pausado');
  await expect(page.locator('#tab-containers')).toHaveText('Containers · 2');
});
