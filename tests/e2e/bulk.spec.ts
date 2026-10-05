// Seleção múltipla e ações em lote: a seleção vive em IDs (não no DOM), então tem que sobreviver ao poll
// de 2 s e sair sozinha quando o container some.
import { test, expect, ctr, id, row } from './fixtures';
import type { Page } from '@playwright/test';

const poll = 2_500;  // um ciclo de consulta com folga
const stopped = (name: string, rest = {}) => ctr(name, { State: 'exited', Status: 'Exited (0) 3 days ago', ...rest });
const check = (page: Page, name: string) => page.getByRole('checkbox', { name: `Selecionar ${name}`, exact: true });
const all = (page: Page) => page.getByRole('checkbox', { name: 'Selecionar todos os visíveis' });
const bar = (page: Page) => page.getByRole('region', { name: 'Ações em lote' });
const toast = (page: Page) => page.locator('#toast');

test('marcar mostra a barra com a contagem e só as ações que fazem sentido', async ({ page, gui }) => {
  await gui.open({ containers: [ctr('web'), ctr('api'), stopped('cron')] });
  await expect(bar(page)).toBeHidden();

  await check(page, 'web').check();
  await expect(bar(page)).toBeVisible();
  await expect(bar(page)).toContainText('1 selecionado');
  await expect(page.locator('#sel-live')).toHaveText('1 container selecionado');  // anúncio para leitor de tela
  await expect(bar(page).getByRole('button', { name: 'Parar 1 selecionado' })).toHaveText('Parar (1)');
  await expect(bar(page).getByRole('button', { name: 'Reiniciar 1 selecionado' })).toBeVisible();
  await expect(bar(page).getByRole('button', { name: /^(Iniciar|Remover)/ })).toHaveCount(0);  // web está rodando

  await check(page, 'cron').check();
  await expect(page.locator('#sel-live')).toHaveText('2 containers selecionados');
  await expect(bar(page).getByRole('button', { name: 'Iniciar 1 selecionado', exact: true })).toBeVisible();
  await expect(bar(page).getByRole('button', { name: 'Remover 1 selecionado' })).toHaveText('Remover… (1)');
  await expect(all(page)).toHaveJSProperty('indeterminate', true);

  await bar(page).getByRole('button', { name: 'Limpar seleção' }).click();
  await expect(bar(page)).toBeHidden();
  await expect(check(page, 'web')).not.toBeChecked();
  await expect(all(page)).toBeFocused();  // o foco não se perde com a barra sumindo
  await expect(page.locator('#sel-live')).toHaveText('Nenhum container selecionado');
});

test('selecionar todos pega só o que está visível; atalhos x e a', async ({ page, gui }) => {
  await gui.open({ containers: [ctr('cache'), ctr('api'), ctr('db')] });
  await page.locator('#q').fill('ca');
  await all(page).check();
  await page.locator('#q').fill('');
  await expect(check(page, 'cache')).toBeChecked();
  await expect(check(page, 'api')).not.toBeChecked();
  await expect(all(page)).toHaveJSProperty('indeterminate', true);

  // filtrado para outro container: a barra avisa que há selecionado fora da tela
  await page.locator('#q').fill('api');
  await expect(bar(page)).toContainText('1 selecionado · 1 fora do filtro');
  await page.locator('#q').fill('');

  // ↓ anda entre as linhas e x marca a linha em foco
  await page.locator('[data-id="' + id('api') + '"][data-a="logs"]').focus();
  await page.keyboard.press('x');
  await expect(check(page, 'api')).toBeChecked();
  await expect(page.getByRole('button', { name: 'Logs api' })).toBeFocused();  // o redesenho devolve o foco
  await page.keyboard.press('x');
  await expect(check(page, 'api')).not.toBeChecked();

  await page.keyboard.press('a');
  for (const n of ['cache', 'api', 'db']) await expect(check(page, n)).toBeChecked();
  await expect(all(page)).toBeChecked();
  await page.keyboard.press('a');  // tudo marcado: a desmarca
  await expect(bar(page)).toBeHidden();
});

test('seleção sobrevive ao redesenho e sai junto com o container que sumiu', async ({ page, gui }) => {
  await gui.open({ containers: [ctr('a'), ctr('b'), ctr('c')] });
  await check(page, 'a').check();
  await check(page, 'b').check();
  await row(page, 'a').evaluate(tr => { (tr as any).marca = 1; });

  // outra linha muda: a marcada não é recriada
  gui.update(s => { s.containers[2].Status = 'Up 6 minutes'; });
  await expect(page.locator(`#st-${id('c')}`)).toHaveText('Rodando há 6 min');
  expect(await row(page, 'a').evaluate(tr => (tr as any).marca)).toBe(1);
  await expect(check(page, 'a')).toBeChecked();

  // a própria linha muda: é redesenhada, mas continua marcada
  gui.update(s => { s.containers[0].Status = 'Up 6 minutes'; });
  await expect(page.locator(`#st-${id('a')}`)).toHaveText('Rodando há 6 min');
  await expect(check(page, 'a')).toBeChecked();

  // b some por fora (docker rm no terminal): sai da seleção
  gui.update(s => { s.containers.splice(1, 1); });
  await expect(row(page, 'b')).toHaveCount(0);
  await expect(bar(page)).toContainText('1 selecionado');
  await expect(page.locator('#sel-live')).toHaveText('1 container selecionado');
  await page.waitForTimeout(poll);
  await expect(check(page, 'a')).toBeChecked();
});

test('falha parcial: aviso agregado, erro na linha e "Iniciar de novo" com Z', async ({ page, gui }) => {
  const err = 'Error response from daemon: cannot stop container: permission denied';
  await gui.open({ containers: [ctr('api'), ctr('web'), ctr('worker', { fail: { stop: err } }), stopped('cron')] });
  await page.locator('body').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('a');
  await bar(page).getByRole('button', { name: 'Parar 3 selecionados' }).click();  // cron já está parado: fica de fora
  await expect(toast(page)).toContainText(`2 parados, 1 falhou: worker: ${err}.`);
  await expect(toast(page).getByRole('button', { name: 'Iniciar de novo' })).toBeVisible();
  await expect(row(page, 'worker').locator('details[data-keep="err"] summary')).toHaveText('Falhou ao parar · ver erro');
  expect(gui.read().containers.filter(c => c.State === 'running').map(c => c.Names)).toEqual(['worker']);

  await page.keyboard.press('z');
  await expect(toast(page)).toHaveText('Os 2 containers estão de pé.');
  expect(gui.container('api')!.State).toBe('running');
  expect(gui.container('web')!.State).toBe('running');
  expect(gui.container('cron')!.State).toBe('exited');  // não estava no Parar: não entra no desfazer
});

test('Remover em lote em 2 passos, com quantos vão ser apagados', async ({ page, gui }) => {
  await gui.open({ containers: [stopped('cron'), stopped('velho'), ctr('web')] });
  await page.locator('body').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('a');
  const remove = bar(page).getByRole('button', { name: 'Remover 2 selecionados' });
  const confirm = bar(page).getByRole('button', { name: 'Confirmar remoção de 2 containers' });
  await expect(remove).toHaveText('Remover… (2)');  // web está rodando: não entra

  await remove.click();
  await expect(confirm).toHaveText('Confirmar remoção (2)');
  await expect(bar(page)).toContainText('Apagar 2 containers de vez? Os volumes ficam. Esc cancela.');
  await expect(page.locator('#shown')).toContainText('Clique em Confirmar para apagar 2 containers de vez.');
  await page.keyboard.press('Escape');
  await expect(confirm).toBeHidden();

  await remove.dblclick();  // duplo clique arma mas não confirma
  await expect(confirm).toBeVisible();
  expect(gui.read().containers).toHaveLength(3);
  await page.waitForTimeout(700);
  await confirm.click();
  await expect(toast(page)).toHaveText('2 removidos.');
  expect(gui.read().containers.map(c => c.Names)).toEqual(['web']);
  await expect(bar(page)).toContainText('1 selecionado');  // os removidos saem da seleção
});

test('roda no máximo 4 ações ao mesmo tempo', async ({ page, gui }) => {
  const names = ['a', 'b', 'c', 'd', 'e', 'f'];
  await gui.open({ containers: names.map(n => ctr(n)) });
  let inflight = 0, max = 0;
  await page.route('**/api/stop/*', async route => {
    max = Math.max(max, ++inflight);
    const res = await route.fetch();
    await new Promise(r => setTimeout(r, 800));
    inflight--;
    await route.fulfill({ response: res });
  });
  await all(page).check();
  await bar(page).getByRole('button', { name: 'Parar 6 selecionados' }).click();
  // a fila inteira aparece ocupada, inclusive quem ainda espera a vez (f só começa depois que um dos 4 primeiros acaba)
  await expect(page.locator(`#st-${id('f')}`)).toHaveText('Parando…');
  await expect(page.getByRole('button', { name: 'Parar f' })).toHaveAttribute('aria-disabled', 'true');
  await expect(toast(page)).toContainText('6 parados.');
  expect(max).toBe(4);
});
