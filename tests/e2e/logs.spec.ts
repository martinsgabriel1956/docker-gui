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
