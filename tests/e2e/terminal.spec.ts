import { test, expect, ctr } from './fixtures';

// o docker falso troca o `docker exec -it` por um sh local (fake-docker/docker)
test('Abrir terminal roda comandos, Esc não fecha e exit encerra a sessão', async ({ page, gui }) => {
  await gui.open({ containers: [ctr('web')] });
  await page.locator('summary[aria-label="Mais ações para web"]').click();
  await page.getByRole('button', { name: 'Abrir terminal' }).click();

  const dlg = page.locator('#shell'), screen = dlg.locator('.xterm-rows');
  await expect(dlg).toBeVisible();
  await expect(page.locator('#shell-name')).toHaveText('web');
  await expect(page.locator('#shell-status')).toContainText('Conectado');
  await expect(screen).toContainText('$');  // prompt: o sh já está lendo

  await page.keyboard.type('echo $((6*7))\n');
  await expect(screen).toContainText('42');

  // dois seguidos (vim): sem ativação do usuário entre eles, o Chrome pode ignorar o preventDefault do `cancel`
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await expect(dlg).toBeVisible();
  await page.keyboard.press('Backspace');  // os Esc foram para a linha do sh como caracteres: apaga
  await page.keyboard.press('Backspace');

  await page.keyboard.type('exit\n');
  await expect(page.locator('#shell-status')).toHaveText('Sessão encerrada.');

  await dlg.getByRole('button', { name: 'Fechar terminal' }).click();
  await expect(dlg).toBeHidden();
});
