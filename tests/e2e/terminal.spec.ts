import type { Locator } from '@playwright/test';
import { test, expect, ctr, BACKEND } from './fixtures';

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

// terminal do Windows (sem PTY no host), forçado em Linux: o docker falso roda o comando do container aqui, com o script
const sizeOnScreen = async (screen: Locator) => [...(await screen.innerText()).matchAll(/tam=(\d+ \d+)/g)].at(-1)?.[1];

test('Sem PTY no host (Windows), o TTY nasce no container e acompanha o tamanho da janela', async ({ page, gui }) => {
  test.skip(BACKEND === 'rust', 'modo pipe só existe no Python (o desktop usa ConPTY no Windows)');
  await gui.open({ containers: [ctr('web')] }, { env: { DOCKER_GUI_TERMINAL: 'pipe' } });
  await page.locator('summary[aria-label="Mais ações para web"]').click();
  await page.getByRole('button', { name: 'Abrir terminal' }).click();

  const screen = page.locator('#shell .xterm-rows');
  await expect(page.locator('#shell-status')).toContainText('Conectado. Esc vai para o terminal');
  await page.keyboard.type('echo $((6*7)) tam=$(stty size)\n');
  await expect(screen).toContainText('42 tam=');
  await expect(screen).not.toContainText('docker-gui:');  // a marca do servidor não aparece
  const before = await sizeOnScreen(screen);

  // o tamanho novo vai por um docker exec à parte (stty no TTY do container)
  await page.setViewportSize({ width: 640, height: 480 });
  await expect(async () => {
    await page.keyboard.type('echo tam=$(stty size)\n');
    expect(await sizeOnScreen(screen)).not.toBe(before);
  }).toPass({ timeout: 7_000 });

  await page.keyboard.type('exit\n');
  await expect(page.locator('#shell-status')).toHaveText('Sessão encerrada.');
});

test('Imagem sem script no Windows: o status avisa que não há TTY e o eco vem do servidor', async ({ page, gui }) => {
  test.skip(BACKEND === 'rust', 'modo pipe só existe no Python (o desktop usa ConPTY no Windows)');
  await gui.open({ containers: [ctr('web', { noscript: true })] }, { env: { DOCKER_GUI_TERMINAL: 'pipe' } });
  await page.locator('summary[aria-label="Mais ações para web"]').click();
  await page.getByRole('button', { name: 'Abrir terminal' }).click();

  const screen = page.locator('#shell .xterm-rows');
  await expect(page.locator('#shell-status')).toContainText('sem TTY');
  await expect(page.locator('#shell-status')).toContainText('vim, less, Tab e Ctrl+C não');
  await page.keyboard.type('echo $((6*7))x');
  await page.keyboard.press('Backspace');
  await expect(screen).toContainText('echo $((6*7))');  // o que foi digitado aparece: o eco é do servidor
  await page.keyboard.press('Enter');
  await expect(screen).toContainText('42');

  await page.keyboard.type('exit\n');
  await expect(page.locator('#shell-status')).toHaveText('Sessão encerrada.');
});
