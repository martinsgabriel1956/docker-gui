import { test, expect, ctr, compose, id, row } from './fixtures';

const containers = [
  ctr('api', { Labels: compose('shop', 'api'), Image: 'acme/api:1.4' }),
  ctr('db', { Labels: compose('shop', 'db'), Image: 'postgres:16' }),
  ctr('cache', { Image: 'redis:7' }),
  ctr('cron', { State: 'exited', Status: 'Exited (0) 3 days ago' }),
  ctr('flaky', { Status: 'Up About an hour (unhealthy)' }),
];
const visible = (page: import('@playwright/test').Page) =>
  page.locator('#rows tr[data-row] th div.font-medium').allTextContents();

test('busca por nome, imagem e projeto', async ({ page, gui }) => {
  await gui.open({ containers });
  await page.locator('#q').fill('postgres');
  expect(await visible(page)).toEqual(['db']);
  await page.locator('#q').fill('shop');
  expect(await visible(page)).toEqual(['api', 'db']);
  await expect(page.locator('#shown')).toHaveText('2 de 5 containers');  // anúncio para leitor de tela
  await page.locator('#q').fill('nada-disso');
  await expect(page.locator('#rows')).toHaveText('Nenhum container corresponde a “nada-disso”.');
});

test('contagem por estado funciona como filtro liga/desliga', async ({ page, gui }) => {
  await gui.open({ containers });
  const parado = page.getByRole('button', { name: '1 parado' });
  await parado.click();
  await expect(parado).toHaveAttribute('aria-pressed', 'true');
  expect(await visible(page)).toEqual(['cron']);
  await parado.click();
  await expect(parado).toHaveAttribute('aria-pressed', 'false');
  expect(await visible(page)).toHaveLength(5);
});

test('filtros ficam na URL e sobrevivem ao recarregar', async ({ page, gui }) => {
  await gui.open({ containers });
  await page.getByRole('button', { name: '3 rodando bem' }).click();
  await page.locator('#q').fill('ca');
  await expect(page).toHaveURL(/#estado=rodando&q=ca$/);
  await page.reload();  // o token já está no localStorage desta aba
  await expect(page.locator('#q')).toHaveValue('ca');
  await expect(page.getByRole('button', { name: '3 rodando bem' })).toHaveAttribute('aria-pressed', 'true');
  expect(await visible(page)).toEqual(['cache']);
});

test('Limpar filtros zera tudo e volta o foco para a busca', async ({ page, gui }) => {
  await gui.open({ containers });
  await page.getByRole('button', { name: '1 parado' }).click();
  await page.locator('#q').fill('cr');
  await page.getByRole('button', { name: 'Limpar filtros' }).click();
  await expect(page.locator('#q')).toHaveValue('');
  await expect(page.locator('#q')).toBeFocused();
  expect(await visible(page)).toHaveLength(5);
  await expect(page).toHaveURL(/\/$/);
});

test('/ vai para a busca e as setas andam entre os botões Logs', async ({ page, gui }) => {
  await gui.open({ containers });
  await page.locator('body').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('/');
  await expect(page.locator('#q')).toBeFocused();
  // da busca, ↓ vai para a primeira linha (a faixa de atenção vem antes: flaky)
  const logs = (name: string) => page.locator(`[data-id="${id(name)}"][data-a="logs"]`);
  await page.keyboard.press('ArrowDown');
  await expect(logs('flaky')).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(logs('api')).toBeFocused();
  await page.keyboard.press('ArrowUp');
  await expect(logs('flaky')).toBeFocused();
  // Enter num Logs só abre o modal: as setas nunca levam a uma ação que muda estado
  await page.keyboard.press('Enter');
  await expect(page.locator('#dlg')).toBeVisible();
});

test('/ não rouba a digitação na busca', async ({ page, gui }) => {
  await gui.open({ containers });
  await page.locator('#q').click();
  await page.keyboard.type('a/b');
  await expect(page.locator('#q')).toHaveValue('a/b');
  await expect(row(page, 'api')).toBeHidden();
});
