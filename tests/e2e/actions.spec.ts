import { test, expect, ctr, compose, id, row } from './fixtures';

const stopped = (name: string, rest = {}) => ctr(name, { State: 'exited', Status: 'Exited (0) 3 days ago', ...rest });
const toast = (page: import('@playwright/test').Page) => page.locator('#toast');
// o "⋯" é um <summary> com aria-label
const menu = (page: import('@playwright/test').Page, name: string) => page.locator(`summary[aria-label="Mais ações para ${name}"]`);

test('Parar avisa e a linha passa para o novo estado', async ({ page, gui }) => {
  await gui.open({ containers: [ctr('web')] });
  await page.getByRole('button', { name: 'Parar web' }).click();
  await expect(toast(page)).toHaveText('web parado.');
  await expect(page.locator(`#st-${id('web')}`)).toHaveText('Parado há <1 s');
  await expect(page.getByRole('button', { name: 'Iniciar web' })).toBeVisible();
  expect(gui.container('web')!.State).toBe('exited');
});

test('Iniciar confere depois de uns segundos se o container ficou de pé', async ({ page, gui }) => {
  await gui.open({ containers: [stopped('cron')] });
  await page.getByRole('button', { name: 'Iniciar cron' }).click();
  await expect(toast(page)).toHaveText('cron iniciado, conferindo se ficou de pé…');
  await expect(toast(page)).toHaveText('cron está de pé.');
});

test('Iniciar avisa quando o container sobe e cai, com atalho para os logs', async ({ page, gui }) => {
  await gui.open({
    containers: [stopped('cron', {
      logs: 'Error: variável DATABASE_URL ausente\n',
      after: { start: { State: 'exited', Status: 'Exited (1) Less than a second ago' } },
    })],
  });
  await page.getByRole('button', { name: 'Iniciar cron' }).click();
  await expect(toast(page)).toContainText('cron subiu mas não ficou bem: Saiu com código 1 há <1 s.');
  await toast(page).getByRole('button', { name: 'Ver logs' }).click();
  await expect(page.locator('#dlg')).toBeVisible();
  await expect(page.locator('#lb')).toHaveText('Error: variável DATABASE_URL ausente\n');
});

test('ação que falha deixa o erro do docker na linha', async ({ page, gui }) => {
  const err = 'Error response from daemon: cannot stop container: permission denied';
  await gui.open({ containers: [ctr('web', { fail: { stop: err } })] });
  await page.getByRole('button', { name: 'Parar web' }).click();
  await expect(toast(page)).toHaveText('Não deu para parar web. O erro ficou na linha.');
  const details = row(page, 'web').locator('details[data-keep="err"]');
  await expect(details.locator('summary')).toHaveText('Falhou ao parar · ver erro');
  await details.locator('summary').click();
  await expect(details.locator('pre')).toHaveText(err);
});

test('durante a ação a linha mostra o andamento e trava os botões', async ({ page, gui }) => {
  await gui.open({ containers: [ctr('web', { delay: { stop: 2 } })] });
  await page.getByRole('button', { name: 'Parar web' }).click();
  await expect(page.locator(`#st-${id('web')}`)).toHaveText('Parando…');
  await expect(page.getByRole('button', { name: 'Parar web' })).toHaveAttribute('aria-disabled', 'true');
  await expect(page.getByRole('button', { name: 'Logs web' })).not.toHaveAttribute('aria-disabled');  // Logs nunca trava
  await expect(toast(page)).toHaveText('web parado.');
  await expect(page.getByRole('button', { name: 'Iniciar web' })).not.toHaveAttribute('aria-disabled');
});

test('Pausar pelo menu e desfazer com Z', async ({ page, gui }) => {
  await gui.open({ containers: [ctr('web')] });
  await menu(page, 'web').click();
  await page.getByRole('button', { name: 'Pausar' }).click();
  await expect(toast(page)).toContainText('web pausado.');
  await expect(page.locator(`#st-${id('web')}`)).toHaveText('Pausado');
  await page.keyboard.press('z');
  await expect(toast(page)).toHaveText('web está de pé.');
  expect(gui.container('web')!.State).toBe('running');
});

test('Copiar docker exec pelo menu', async ({ page, context, gui }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await gui.open({ containers: [ctr('web')] });
  await menu(page, 'web').click();
  await page.getByRole('button', { name: 'Copiar docker exec' }).click();
  await expect(toast(page)).toHaveText('Copiado: docker exec -it web sh');
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('docker exec -it web sh');
});

test.describe('remover em 2 passos', () => {
  test('primeiro clique arma, Esc cancela e o segundo clique remove', async ({ page, gui }) => {
    await gui.open({ containers: [stopped('cron'), stopped('velho')] });
    await menu(page, 'cron').click();
    await page.getByRole('button', { name: 'Remover…' }).click();
    const confirm = page.getByRole('button', { name: 'Confirmar remoção de cron' });
    await expect(confirm).toBeVisible();
    await expect(row(page, 'cron')).toContainText('Apagar de vez? Os volumes ficam. Esc cancela.');

    await page.keyboard.press('Escape');
    await expect(confirm).toBeHidden();
    expect(gui.container('cron')).toBeDefined();

    await menu(page, 'cron').click();
    await page.getByRole('button', { name: 'Remover…' }).click();
    await page.waitForTimeout(700);  // passado o intervalo anti duplo clique
    await confirm.click();
    await expect(toast(page)).toHaveText('cron removido.');
    await expect(row(page, 'cron')).toHaveCount(0);
    expect(gui.container('cron')).toBeUndefined();
    // o foco cai num lugar seguro: o Logs da linha vizinha, nunca uma ação destrutiva
    await expect(page.getByRole('button', { name: 'Logs velho' })).toBeFocused();
  });

  test('duplo clique não vira confirmação', async ({ page, gui }) => {
    await gui.open({ containers: [stopped('cron')] });
    await menu(page, 'cron').click();
    await page.getByRole('button', { name: 'Remover…' }).click();
    await page.getByRole('button', { name: 'Confirmar remoção de cron' }).click();  // logo em seguida, < 600 ms
    await expect(page.getByRole('button', { name: 'Confirmar remoção de cron' })).toBeVisible();
    expect(gui.container('cron')).toBeDefined();
  });

  test('desarma sozinho em 8 s, mas não com o foco no botão', async ({ page, gui }) => {
    await page.clock.install();
    await gui.open({ containers: [stopped('cron')] });
    await menu(page, 'cron').click();
    await page.getByRole('button', { name: 'Remover…' }).click();
    const confirm = page.getByRole('button', { name: 'Confirmar remoção de cron' });
    await expect(confirm).toBeFocused();  // o foco vai para o Confirmar, então ele espera (WCAG 2.2.1)
    await page.clock.runFor(15_000);
    await expect(confirm).toBeVisible();

    await page.locator('#q').focus();
    await page.mouse.move(0, 0);
    await page.clock.runFor(1_500);
    await expect(confirm).toBeHidden();
    expect(gui.container('cron')).toBeDefined();
  });

  test('container rodando não tem Remover no menu', async ({ page, gui }) => {
    await gui.open({ containers: [ctr('web')] });
    await menu(page, 'web').click();
    await expect(page.getByRole('button', { name: 'Reiniciar' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Remover…' })).toHaveCount(0);
  });
});

test('Parar tudo do projeto, com "Iniciar de novo" para desfazer', async ({ page, gui }) => {
  await gui.open({
    containers: [
      ctr('api', { Labels: compose('shop', 'api') }),
      ctr('db', { Labels: compose('shop', 'db') }),
      stopped('migrate', { Labels: compose('shop', 'migrate') }),  // já parado: fica de fora do desfazer
      ctr('solto'),
    ],
  });
  await page.getByRole('button', { name: 'Parar tudo do projeto shop (2)', exact: true }).click();
  await expect(toast(page)).toContainText('shop: 2 parados.');
  expect(gui.read().containers.filter(c => c.State === 'running').map(c => c.Names)).toEqual(['solto']);

  await toast(page).getByRole('button', { name: 'Iniciar de novo' }).click();
  await expect(toast(page)).toHaveText('Os 2 containers estão de pé.');
  expect(gui.container('migrate')!.State).toBe('exited');
  expect(gui.container('api')!.State).toBe('running');
});

test('Iniciar tudo só mexe nos parados do projeto', async ({ page, gui }) => {
  await gui.open({
    containers: [
      ctr('api', { Labels: compose('shop', 'api') }),
      stopped('db', { Labels: compose('shop', 'db') }),
      stopped('outro', { Labels: compose('blog', 'web') }),
    ],
  });
  await page.getByRole('button', { name: 'Iniciar tudo do projeto shop (1)', exact: true }).click();
  await expect(toast(page)).toHaveText('db está de pé.');
  expect(gui.container('outro')!.State).toBe('exited');
});
