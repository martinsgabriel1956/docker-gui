import { test, expect, ctr, id, row } from './fixtures';

const unhealthy = ctr('api', {
  Status: 'Up 10 minutes (unhealthy)',
  logs: 'GET /health 500\n',
  health: { Status: 'unhealthy', Log: [{ ExitCode: 1, Output: 'curl: (7) Failed to connect to localhost port 3000\n' }] },
});

test('Logs abre o modal com a saída do container', async ({ page, gui }) => {
  await gui.open({ containers: [ctr('web', { logs: 'listening on :80\nGET / 200\n' })] });
  await page.getByRole('button', { name: 'Logs web' }).click();
  await expect(page.locator('#dlg')).toBeVisible();
  await expect(page.locator('#lt')).toHaveText('web');
  await expect(page.locator('#lb')).toHaveText('listening on :80\nGET / 200\n');
  await expect(page.locator('#dlg-status')).toHaveText('Rodando há 5 min');
});

test('Baixar .log salva o que está na tela com o nome do container', async ({ page, gui }) => {
  const text = '2026-10-03T12:00:00.000000000Z listening on :80\n';
  await gui.open({ containers: [ctr('web', { logs: text })] });
  await page.getByRole('button', { name: 'Logs web' }).click();
  await expect(page.locator('#lb')).toHaveText(text);
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Baixar .log' }).click()]);
  expect(download.suggestedFilename()).toBe('web.log');
  const chunks: Buffer[] = [];
  for await (const chunk of await download.createReadStream()) chunks.push(chunk as Buffer);
  expect(Buffer.concat(chunks).toString()).toBe(text);
});

test('container sem logs diz isso em vez de ficar em branco', async ({ page, gui }) => {
  await gui.open({ containers: [ctr('web')] });
  await page.getByRole('button', { name: 'Logs web' }).click();
  await expect(page.locator('#lb')).toHaveText('(sem logs)');
});

test('Acompanhar ao vivo traz as linhas novas e para ao fechar', async ({ page, gui }) => {
  await gui.open({ containers: [ctr('web', { logs: 'linha 1\n' })] });
  await page.getByRole('button', { name: 'Logs web' }).click();
  await page.locator('#follow').click();
  await expect(page.locator('#follow')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#refresh')).toHaveAttribute('aria-disabled', 'true');
  gui.update(s => { s.containers[0].logs = 'linha 1\nlinha 2\n'; });
  await expect(page.locator('#lb')).toHaveText('linha 1\nlinha 2\n');

  await page.keyboard.press('Escape');
  await expect(page.locator('#dlg')).toBeHidden();
  await expect(page.locator('#follow')).toHaveAttribute('aria-pressed', 'false');
});

test('ao vivo para sozinho quando o container para', async ({ page, gui }) => {
  await gui.open({ containers: [ctr('web', { logs: 'linha 1\n' })] });
  await page.getByRole('button', { name: 'Logs web' }).click();
  await page.locator('#follow').click();
  await expect(page.locator('#lmeta')).toHaveText('Ao vivo · últimas 500 linhas e as novas');
  gui.update(s => { Object.assign(s.containers[0], { logs: 'linha 1\nsaindo\n', State: 'exited', Status: 'Exited (0) 1 second ago' }); });
  await expect(page.locator('#follow')).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('#lb')).toHaveText('linha 1\nsaindo\n');
  await expect(page.locator('#lmeta')).toContainText('o container parou');
});

test('ao vivo guarda no máximo 5000 linhas', async ({ page, gui }) => {
  await gui.open({ containers: [ctr('web', { logs: 'linha 0\n' })] });
  await page.getByRole('button', { name: 'Logs web' }).click();
  await page.locator('#follow').click();
  await expect(page.locator('#lb')).toHaveText('linha 0\n');
  gui.update(s => { s.containers[0].logs = Array.from({ length: 6000 }, (_, i) => `linha ${i}\n`).join(''); });
  await expect(page.locator('#lb')).toContainText('linha 5999');
  await expect.poll(() => page.locator('#lb').evaluate(lb => [lb.childNodes.length, lb.textContent!.split('\n')[0]]))
    .toEqual([5000, 'linha 1000']);
});

test('fechar o modal devolve o foco ao botão Logs da linha', async ({ page, gui }) => {
  await gui.open({ containers: [ctr('a'), ctr('web')] });
  await page.getByRole('button', { name: 'Logs web' }).click();
  await expect(page.locator('#dlg')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'Logs web' })).toBeFocused();

  await page.getByRole('button', { name: 'Logs web' }).click();
  await page.getByRole('button', { name: 'Fechar logs' }).click();
  await expect(page.getByRole('button', { name: 'Logs web' })).toBeFocused();
});

test('dá para agir no container sem sair dos logs', async ({ page, gui }) => {
  await gui.open({ containers: [ctr('web')] });
  await page.getByRole('button', { name: 'Logs web' }).click();
  const acts = page.locator('#dlg-acts');
  await expect(acts.getByRole('button')).toHaveText(['Parar', 'Reiniciar', 'Copiar docker exec']);
  await acts.getByRole('button', { name: 'Parar web' }).click();
  await expect(page.locator('#dlg-status')).toHaveText('Parado há <1 s');
  await expect(acts.getByRole('button')).toHaveText(['Iniciar']);
  // com o modal aberto, o aviso aparece dentro dele (fora, ficaria atrás do backdrop)
  await expect(page.locator('#dlg-msg')).toHaveText('web parado.');
});

test('modal avisa se o container deixou de existir', async ({ page, gui }) => {
  await gui.open({ containers: [ctr('web')] });
  await page.getByRole('button', { name: 'Logs web' }).click();
  gui.update(s => { s.containers = []; });
  await expect(page.locator('#dlg-status')).toHaveText('Este container não existe mais.');
  await expect(page.locator('#dlg-acts')).toBeEmpty();
});

test('saída do último healthcheck na linha e no modal', async ({ page, gui }) => {
  await gui.open({ containers: [unhealthy] });
  const details = row(page, 'api').locator('details[data-keep="health"]');
  await details.locator('summary', { hasText: 'Ver último healthcheck' }).click();
  await expect(details.locator('pre')).toHaveText('código 1 · curl: (7) Failed to connect to localhost port 3000');

  await page.getByRole('button', { name: 'Logs api' }).click();
  await expect(page.locator('#dlg-status')).toContainText(
    'Último healthcheck: código 1 · curl: (7) Failed to connect to localhost port 3000');
});

test('healthcheck que ainda não rodou', async ({ page, gui }) => {
  await gui.open({ containers: [ctr('api', { Status: 'Up 2 seconds (health: starting)', health: { Status: 'starting', Log: [] } })] });
  await row(page, 'api').locator('summary', { hasText: 'Ver último healthcheck' }).click();
  await expect(row(page, 'api').locator('details[data-keep="health"] pre')).toHaveText('Nenhum probe rodou ainda.');
  await expect(page.locator(`#st-${id('api')}`)).toHaveText('Rodando há 2 s · verificando saúde');
});

const lines = (from: number, to: number) => Array.from({ length: to - from }, (_, i) => `linha ${from + i}\n`).join('');

test('filtro mostra só as linhas que casam, marca o trecho e conta', async ({ page, gui }) => {
  await gui.open({ containers: [ctr('web', { logs: 'GET / 200\nPOST /api 500\nget /health 200 GET\nerro: falhou\n' })] });
  await page.getByRole('button', { name: 'Logs web' }).click();
  await expect(page.locator('#lb')).toContainText('erro: falhou');
  const filter = page.getByRole('searchbox', { name: 'Filtrar linhas dos logs' });
  await filter.fill('get');
  await expect(page.locator('#lb')).toHaveText('GET / 200\nget /health 200 GET\n');
  await expect(page.locator('#lb mark')).toHaveText(['GET', 'get', 'GET']);
  await expect(page.locator('#lcount')).toHaveText('3 ocorrências em 2 linhas');
  await expect(page.locator('#lcount')).toHaveAttribute('aria-live', 'polite');

  await filter.fill('[x]');  // texto literal, não regex
  await expect(page.locator('#lcount')).toHaveText('Nenhuma ocorrência');
  await expect(page.locator('#lb')).toHaveText('');

  // Esc com texto limpa o filtro sem fechar o modal; de novo, fecha
  await filter.press('Escape');
  await expect(filter).toHaveValue('');
  await expect(page.locator('#dlg')).toBeVisible();
  await expect(page.locator('#lb')).toHaveText('GET / 200\nPOST /api 500\nget /health 200 GET\nerro: falhou\n');
  await expect(page.locator('#lcount')).toHaveText('');
  await filter.press('Escape');
  await expect(page.locator('#dlg')).toBeHidden();

  // reabrir começa sem filtro
  await page.getByRole('button', { name: 'Logs web' }).click();
  await filter.fill('get');
  await page.getByRole('button', { name: 'Fechar logs' }).click();
  await page.getByRole('button', { name: 'Logs web' }).click();
  await expect(filter).toHaveValue('');
  await expect(page.locator('#lcount')).toHaveText('');
});

test('/ dentro do modal vai para o filtro das linhas', async ({ page, gui }) => {
  await gui.open({ containers: [ctr('web', { logs: 'a/b\n' })] });
  await page.getByRole('button', { name: 'Logs web' }).click();
  await expect(page.locator('#lb')).toHaveText('a/b\n');
  await page.keyboard.press('/');
  await expect(page.locator('#lf')).toBeFocused();
  await expect(page.locator('#q')).not.toBeFocused();
  await page.keyboard.type('a/b');  // dentro do campo, / é texto
  await expect(page.locator('#lf')).toHaveValue('a/b');
  await expect(page.locator('#lcount')).toHaveText('1 ocorrência em 1 linha');
});

test('filtro vale para as linhas que chegam ao vivo', async ({ page, gui }) => {
  await gui.open({ containers: [ctr('web', { logs: 'ok 1\nERRO 1\n' })] });
  await page.getByRole('button', { name: 'Logs web' }).click();
  await page.locator('#lf').fill('erro');
  await page.locator('#follow').click();
  // o lmeta muda quando o stream abre (e limpa a caixa): o que aparecer depois veio dele, não do fetch de antes
  await expect(page.locator('#lmeta')).toHaveText('Ao vivo · últimas 500 linhas e as novas');
  await expect(page.locator('#lb')).toHaveText('ERRO 1\n');
  gui.update(s => { s.containers[0].logs += 'ok 2\nerro 2 e Erro 3\n'; });
  await expect(page.locator('#lb')).toHaveText('ERRO 1\nerro 2 e Erro 3\n');
  await expect(page.locator('#lcount')).toHaveText('3 ocorrências em 2 linhas');
  // limpar o filtro ao vivo traz tudo de volta, e as novas continuam chegando
  await page.locator('#lf').fill('');
  await expect(page.locator('#lb')).toHaveText('ok 1\nERRO 1\nok 2\nerro 2 e Erro 3\n');
  gui.update(s => { s.containers[0].logs += 'ok 3\n'; });
  await expect(page.locator('#lb')).toHaveText('ok 1\nERRO 1\nok 2\nerro 2 e Erro 3\nok 3\n');
});

test('ao vivo com filtro: o teto tira as linhas antigas e o contador acompanha', async ({ page, gui }) => {
  await gui.open({ containers: [ctr('web', { logs: 'alvo 0\n' })] });
  await page.getByRole('button', { name: 'Logs web' }).click();
  await page.locator('#lf').fill('alvo');
  await page.locator('#follow').click();
  await expect(page.locator('#lmeta')).toHaveText('Ao vivo · últimas 500 linhas e as novas');
  await expect(page.locator('#lb')).toHaveText('alvo 0\n');
  await expect(page.locator('#lcount')).toHaveText('1 ocorrência em 1 linha');
  // 5999 linhas novas, uma "alvo" a cada 1000: o teto de 5000 derruba a "alvo 0"
  gui.update(s => {
    s.containers[0].logs += Array.from({ length: 5999 }, (_, i) => (i + 1) % 1000 ? `x ${i + 1}\n` : `alvo ${i + 1}\n`).join('');
  });
  await expect(page.locator('#lb')).toHaveText('alvo 1000\nalvo 2000\nalvo 3000\nalvo 4000\nalvo 5000\n');
  await expect(page.locator('#lcount')).toHaveText('5 ocorrências em 5 linhas');
  await page.locator('#lf').fill('');
  await expect.poll(() => page.locator('#lb').evaluate(lb => [lb.childNodes.length, lb.textContent!.split('\n')[0]]))
    .toEqual([5000, 'alvo 1000']);
});

test('Carregar mais pede mais histórico até ter tudo', async ({ page, gui }) => {
  await gui.open({ containers: [ctr('web', { logs: lines(0, 3000) })] });
  await page.getByRole('button', { name: 'Logs web' }).click();
  const lb = page.locator('#lb'), more = page.locator('#more');
  const first = () => lb.evaluate(el => el.textContent!.split('\n')[0]);
  await expect(lb).toContainText('linha 2999');
  expect(await first()).toBe('linha 2500');
  await expect(page.locator('#lmeta')).toContainText('Últimas 500 linhas · atualizado às');

  await expect(more).toHaveText('Carregar 2.000 linhas');
  await more.click();
  await expect.poll(first).toBe('linha 1000');
  await expect(page.locator('#lmeta')).toContainText('Últimas 2.000 linhas');

  // 3000 < 10000: veio o log inteiro, não há mais o que pedir
  await expect(more).toHaveText('Carregar 10.000 linhas');
  await more.click();
  await expect.poll(first).toBe('linha 0');
  await expect(more).toHaveText('Tudo carregado');
  await expect(more).toHaveAttribute('aria-disabled', 'true');

  // o filtro vale para o histórico carregado
  await page.locator('#lf').fill('linha 12');
  await expect(page.locator('#lcount')).toHaveText('111 ocorrências em 111 linhas');

  // reabrir volta para as últimas 500
  await page.locator('#lf').press('Escape');
  await page.locator('#lf').press('Escape');
  await expect(page.locator('#dlg')).toBeHidden();
  await page.getByRole('button', { name: 'Logs web' }).click();
  await expect(more).toHaveText('Carregar 2.000 linhas');
  await expect.poll(first).toBe('linha 2500');
});

test('log curto já diz que está tudo carregado', async ({ page, gui }) => {
  await gui.open({ containers: [ctr('web', { logs: 'só uma\n' })] });
  await page.getByRole('button', { name: 'Logs web' }).click();
  await expect(page.locator('#lb')).toHaveText('só uma\n');
  await expect(page.locator('#more')).toHaveText('Tudo carregado');
  await expect(page.locator('#more')).toHaveAttribute('aria-disabled', 'true');
});

test('Carregar tudo traz o log inteiro', async ({ page, gui }) => {
  await gui.open({ containers: [ctr('web', { logs: lines(0, 10500) })] });
  await page.getByRole('button', { name: 'Logs web' }).click();
  const more = page.locator('#more');
  await expect(more).toHaveText('Carregar 2.000 linhas');
  await more.click();
  await expect(more).toHaveText('Carregar 10.000 linhas');
  await more.click();
  await expect(more).toHaveText('Carregar tudo');
  await more.click();
  await expect(more).toHaveText('Tudo carregado');
  await expect(page.locator('#lmeta')).toContainText('Todas as linhas · atualizado às');
  expect(await page.locator('#lb').evaluate(el => el.textContent!.split('\n')[0])).toBe('linha 0');
});

test('ao vivo, Carregar mais reconecta com mais histórico (até 10.000)', async ({ page, gui }) => {
  await gui.open({ containers: [ctr('web', { logs: lines(0, 12000) })] });
  await page.getByRole('button', { name: 'Logs web' }).click();
  await page.locator('#follow').click();
  const lb = page.locator('#lb'), more = page.locator('#more');
  const box = () => lb.evaluate(el => [el.childNodes.length, el.textContent!.split('\n')[0]]);
  await expect(page.locator('#lmeta')).toHaveText('Ao vivo · últimas 500 linhas e as novas');
  await expect.poll(box).toEqual([500, 'linha 11500']);

  await more.click();
  await expect(page.locator('#lmeta')).toHaveText('Ao vivo · últimas 2.000 linhas e as novas');
  await expect.poll(box).toEqual([2000, 'linha 10000']);

  // o teto sobe junto com o histórico pedido
  await more.click();
  await expect(page.locator('#lmeta')).toHaveText('Ao vivo · últimas 10.000 linhas e as novas');
  await expect.poll(box).toEqual([10000, 'linha 2000']);
  await expect(page.locator('#follow')).toHaveAttribute('aria-pressed', 'true');

  // "tudo" ao vivo não teria teto: só com o ao vivo desligado
  await expect(more).toHaveText('Carregar tudo');
  await expect(more).toHaveAttribute('aria-disabled', 'true');
  await more.click({ force: true });  // aria-disabled continua clicável (e no Tab): o clique explica o porquê
  await expect(page.locator('#dlg-msg')).toContainText('desligue o ao vivo');
  await page.locator('#follow').click();
  await expect(more).toHaveAttribute('aria-disabled', 'false');
  await more.click();
  await expect(more).toHaveText('Tudo carregado');
  await expect.poll(() => lb.evaluate(el => el.textContent!.split('\n')[0])).toBe('linha 0');
});
