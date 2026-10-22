import { test, expect, ctr, compose, id, row } from './fixtures';

const stopped = (name: string, rest = {}) => ctr(name, { State: 'exited', Status: 'Exited (0) 3 days ago', ...rest });
const toast = (page: import('@playwright/test').Page) => page.locator('#toast');
// o "⋯" é um <summary> com aria-label
const menu = (page: import('@playwright/test').Page, name: string) => page.locator(`summary[aria-label="Mais ações para ${name}"]`);

test('Parar avisa, a linha passa para o novo estado e dá para iniciar de novo', async ({ page, gui }) => {
  await gui.open({ containers: [ctr('web')] });
  await page.getByRole('button', { name: 'Parar web' }).click();
  await expect(toast(page)).toContainText('web parado.');
  await expect(page.locator(`#st-${id('web')}`)).toHaveText('Parado há <1 s');
  await expect(page.getByRole('button', { name: 'Iniciar web' })).toBeVisible();
  expect(gui.container('web')!.State).toBe('exited');
  // como no Parar tudo e no lote: o aviso desfaz
  await toast(page).getByRole('button', { name: 'Iniciar de novo' }).click();
  await expect(toast(page)).toHaveText('web está de pé.');
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
  await expect(toast(page)).toContainText('web parado.');
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
  test('armar não mexe na tabela, e o × cancela', async ({ page, gui }) => {
    await gui.open({ containers: [stopped('cron'), ctr('web', { Status: 'Restarting (1) 4 seconds ago', State: 'restarting' })] });
    // posição das colunas pela linha vizinha: o Confirmar e o aviso não podem alargar a coluna de ações
    const cols = () => row(page, 'web').locator('td').evaluateAll(tds => tds.map(td => Math.round(td.getBoundingClientRect().left)));
    const before = await cols(), height = () => row(page, 'cron').evaluate(tr => tr.getBoundingClientRect().height), h = await height();
    await menu(page, 'cron').click();
    await page.getByRole('button', { name: 'Remover…' }).click();
    await expect(page.getByRole('button', { name: 'Cancelar remoção de cron' })).toBeFocused();
    expect(await cols()).toEqual(before);
    // o Confirmar, o × e o aviso ficam no pé da tela: a linha armada não cresce nem empurra as de baixo
    expect(await height()).toBe(h);
    await expect(page.locator('#armdock').getByRole('button', { name: 'Confirmar remoção de cron' })).toBeVisible();

    await page.getByRole('button', { name: 'Cancelar remoção de cron' }).click();
    await expect(page.getByRole('button', { name: 'Confirmar remoção de cron' })).toBeHidden();
    await expect(menu(page, 'cron')).toBeFocused();
    expect(gui.container('cron')).toBeDefined();
  });

  test('primeiro clique arma, Esc cancela e o segundo clique remove', async ({ page, gui }) => {
    await gui.open({ containers: [stopped('cron'), stopped('velho')] });
    await menu(page, 'cron').click();
    await page.getByRole('button', { name: 'Remover…' }).click();
    const confirm = page.getByRole('button', { name: 'Confirmar remoção de cron' });
    await expect(confirm).toBeVisible();
    await expect(page.locator('#armdock')).toContainText('Remover cron de vez? Os volumes ficam. Esc cancela.');

    await page.keyboard.press('Escape');
    await expect(confirm).toBeHidden();
    expect(gui.container('cron')).toBeDefined();
    await expect(menu(page, 'cron')).toBeFocused();  // volta para o "⋯" de onde veio o Remover

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
    // o foco vai para o ×, o botão seguro; com ele (ou o Confirmar) em foco, a confirmação espera (WCAG 2.2.1)
    await expect(page.getByRole('button', { name: 'Cancelar remoção de cron' })).toBeFocused();
    await page.clock.runFor(15_000);
    await expect(confirm).toBeVisible();
    await page.keyboard.press('Shift+Tab');  // o Confirmar está a um Tab, na linha própria da confirmação
    await expect(confirm).toBeFocused();
    await page.clock.runFor(15_000);
    await expect(confirm).toBeVisible();

    await page.locator('#q').focus();
    await page.mouse.move(0, 0);
    await page.clock.runFor(1_500);
    await expect(confirm).toBeHidden();
    expect(gui.container('cron')).toBeDefined();
  });

  test.describe('no toque', () => {
    test.use({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } });
    test('cancela sozinho em 8 s mesmo com o foco nos botões, como o aviso promete', async ({ page, gui }) => {
      await page.clock.install();
      await gui.open({ containers: [stopped('cron')] });
      await menu(page, 'cron').click();
      await page.getByRole('button', { name: 'Remover…' }).click();
      const confirm = page.getByRole('button', { name: 'Confirmar remoção de cron' });
      await expect(page.locator('#armdock')).toContainText('Cancela sozinho em 8 s.');
      await expect(page.getByRole('button', { name: 'Cancelar remoção de cron' })).toBeFocused();
      await page.clock.runFor(9_000);
      await expect(confirm).toBeHidden();
      expect(gui.container('cron')).toBeDefined();
    });
  });

  test('com a remoção armada, a principal fica inerte: clicar nela por hábito só cancela', async ({ page, gui }) => {
    await gui.open({ containers: [stopped('cron')] });
    await menu(page, 'cron').click();
    await page.getByRole('button', { name: 'Remover…' }).click();
    const start = page.getByRole('button', { name: 'Iniciar cron' });
    await expect(start).toHaveAttribute('aria-disabled', 'true');
    await start.click({ force: true });  // o clique por hábito, que o aria-disabled não impede
    await expect(page.getByRole('button', { name: 'Confirmar remoção de cron' })).toBeHidden();
    expect(gui.container('cron')!.State).toBe('exited');  // não iniciou nem removeu
  });

  test('container rodando não tem Remover no menu', async ({ page, gui }) => {
    await gui.open({ containers: [ctr('web')] });
    await menu(page, 'web').click();
    await expect(page.getByRole('button', { name: 'Pausar' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Reiniciar', exact: true })).toHaveCount(0);  // fica à vista na linha
    await expect(page.getByRole('button', { name: 'Remover…' })).toHaveCount(0);
    // no lugar, o porquê, desabilitado: o docker só remove container parado
    await expect(page.getByRole('button', { name: 'Remover (indisponível: pare o container antes)' })).toHaveAttribute('aria-disabled', 'true');
  });
});

test('Reiniciar fica à vista na linha, e r reinicia a linha em foco', async ({ page, gui }) => {
  await gui.open({ containers: [ctr('web'), stopped('cron')] });
  await expect(row(page, 'cron').getByRole('button', { name: 'Reiniciar cron' })).toHaveCount(0);  // só quem está rodando
  await row(page, 'web').getByRole('button', { name: 'Reiniciar web' }).click();
  await expect(toast(page)).toHaveText('web reiniciado, conferindo se ficou de pé…');
  await expect(toast(page)).toHaveText('web está de pé.');

  await page.getByRole('button', { name: 'Logs web' }).focus();
  await page.keyboard.press('r');
  await expect(toast(page)).toHaveText('web reiniciado, conferindo se ficou de pé…');
  await page.getByRole('button', { name: 'Logs cron' }).focus();
  await page.keyboard.press('r');  // parado: r não faz nada
  await expect(page.locator(`#st-${id('cron')}`)).toHaveText('Parado há 3 d');
});

test('l abre os logs da linha em foco, de qualquer botão dela', async ({ page, gui }) => {
  await gui.open({ containers: [ctr('web', { logs: 'oi do web\n' }), stopped('cron', { logs: 'oi do cron\n' })] });
  await row(page, 'cron').getByRole('checkbox').focus();  // a caixa da seleção não é digitação
  await page.keyboard.press('l');
  await expect(page.locator('#lt')).toHaveText('cron');
  await expect(page.locator('#lb')).toHaveText('oi do cron\n');
  await page.keyboard.press('Escape');
  await expect(page.locator('#dlg')).toBeHidden();
  await expect(page.getByRole('button', { name: 'Logs cron' })).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('l');
  await expect(page.locator('#lt')).toHaveText('web');
  await page.keyboard.press('Escape');
  // na busca, l é letra
  await page.locator('#q').fill('');
  await page.locator('#q').press('l');
  await expect(page.locator('#dlg')).toBeHidden();
  await expect(page.locator('#q')).toHaveValue('l');
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
  await page.locator('summary[aria-label="Mais ações do projeto shop"]').click();  // migrate parado: a principal é Iniciar tudo
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
  await page.getByRole('button', { name: 'Iniciar db do projeto shop', exact: true }).click();
  await expect(toast(page)).toHaveText('db está de pé.');
  expect(gui.container('outro')!.State).toBe('exited');
});

test('Iniciar que falha por porta ocupada diz a causa no aviso e na linha', async ({ page, gui }) => {
  const err = 'Error response from daemon: driver failed programming external connectivity on endpoint web: Bind for 0.0.0.0:8080 failed: port is already allocated';
  await gui.open({ containers: [stopped('web', { fail: { start: err } })] });
  await page.getByRole('button', { name: 'Iniciar web' }).click();
  const hint = 'A porta do host já está em uso: pare o que usa ela ou troque a porta.';
  await expect(toast(page)).toHaveText(`Não deu para iniciar web. ${hint}`);
  await expect(row(page, 'web')).toContainText(hint);  // à vista; o erro do docker fica no "ver erro"
  await expect(row(page, 'web').locator('pre')).toHaveText(err);
});

test('s faz a ação principal da linha em foco', async ({ page, gui }) => {
  await gui.open({ containers: [ctr('web')] });
  await page.getByRole('button', { name: 'Logs web' }).focus();
  await page.keyboard.press('s');
  await expect(toast(page)).toContainText('web parado.');
  await expect(page.getByRole('button', { name: 'Iniciar web' })).toBeVisible();
});

const downloaded = async (d: import('@playwright/test').Download) => {
  const chunks: Buffer[] = [];
  for await (const chunk of await d.createReadStream()) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
};
const openCp = async (page: import('@playwright/test').Page, name: string) => {
  await menu(page, name).click();
  await page.getByRole('button', { name: 'Baixar arquivo…' }).click();
  return page.getByLabel('Caminho no container');
};

test('Baixar arquivo: um arquivo de container parado, com o nome dele, e o caminho fica para a próxima', async ({ page, gui }) => {
  await gui.open({ containers: [stopped('web', { files: { '/var/log/nginx/error.log': 'upstream timed out\n' } })] });
  const field = await openCp(page, 'web');
  await field.fill('/var/log/nginx/error.log');
  const [d] = await Promise.all([page.waitForEvent('download'), field.press('Enter')]);
  expect(d.suggestedFilename()).toBe('error.log');
  expect((await downloaded(d)).toString()).toBe('upstream timed out\n');
  await expect(toast(page)).toHaveText('Baixado: error.log');
  await expect(page.locator('#cp')).toBeHidden();
  await expect(await openCp(page, 'web')).toHaveValue('/var/log/nginx/error.log');
  await expect(page.locator('#cp-recent option')).toHaveCount(1);
});

test('Baixar arquivo: uma pasta chega como .tar', async ({ page, gui }) => {
  await gui.open({ containers: [ctr('api', { files: { '/app/reports/a.txt': 'a', '/app/reports/b.txt': 'b' } })] });
  const field = await openCp(page, 'api');
  await field.fill('/app/reports/');
  const [d] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Baixar arquivo', exact: true }).click()]);
  expect(d.suggestedFilename()).toBe('reports.tar');
  expect((await downloaded(d)).includes('reports/a.txt')).toBe(true);
});

test('Baixar arquivo: caminho relativo é recusado no campo, e o que não existe diz que não existe', async ({ page, gui }) => {
  await gui.open({ containers: [ctr('api', { files: { '/app/x': 'x' } })] });
  const field = await openCp(page, 'api');
  await field.fill('app/x');
  await field.press('Enter');
  await expect(field).toHaveAttribute('aria-invalid', 'true');
  await expect(page.locator('#cp-err')).toHaveText('Use o caminho absoluto, começando com /.');
  await field.fill('/nao/existe');
  await field.press('Enter');
  await expect(page.locator('#cp-msg')).toHaveText('/nao/existe não existe no container');
  await expect(field).not.toHaveAttribute('aria-invalid', 'true');
  await page.keyboard.press('Escape');
  await expect(page.locator('#cp')).toBeHidden();
});
