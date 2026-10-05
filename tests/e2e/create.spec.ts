import type { Page } from '@playwright/test';
import { test, expect, ctr, row } from './fixtures';

const toast = (page: Page) => page.locator('#toast');
const dialog = (page: Page) => page.locator('#create');
const go = (page: Page) => dialog(page).locator('#create-go');

async function openForm(page: Page) {
  await page.getByRole('button', { name: 'Novo container' }).click();
  await expect(dialog(page)).toBeVisible();
  await expect(dialog(page).getByLabel('Imagem')).toBeFocused();
}

test('Novo container roda o docker run com as opções e confere se ficou de pé', async ({ page, gui }) => {
  await gui.open({ containers: [ctr('db')] });
  await openForm(page);
  await dialog(page).getByLabel('Imagem').fill('nginx:1.27');
  await dialog(page).getByLabel('Nome').fill('web');
  await dialog(page).getByLabel('Portas').fill('8080:80, 5353:53/udp');
  await dialog(page).getByLabel('Variáveis de ambiente').fill('A=1\n# comentário\nMSG=olá; $(id)');
  await dialog(page).getByLabel('Restart').selectOption('unless-stopped');
  await dialog(page).getByLabel('Volume').fill('dados:/data');
  await go(page).click();

  await expect(toast(page)).toHaveText('web criado, conferindo se ficou de pé…');
  await expect(dialog(page)).toBeHidden();
  await expect(page.getByRole('button', { name: 'Novo container' })).toBeFocused();
  await expect(toast(page)).toHaveText('web está de pé.');
  expect(gui.read().run_calls).toEqual([[
    'run', '-d', '--restart=unless-stopped', '--name=web', '-p', '127.0.0.1:8080:80/tcp', '-p', '127.0.0.1:5353:53/udp',
    '-e', 'A=1', '-e', 'MSG=olá; $(id)', '--mount=type=volume,source=dados,target=/data', '--', 'nginx:1.27',
  ]]);
  await expect(row(page, 'web')).toContainText('nginx:1.27');
  await expect(row(page, 'web').getByRole('link', { name: /Abrir localhost:8080/ })).toBeVisible();

  // o formulário volta limpo para o próximo
  await openForm(page);
  await expect(dialog(page).getByLabel('Imagem')).toHaveValue('');
  await expect(dialog(page).getByLabel('Restart')).toHaveValue('no');
  await page.keyboard.press('Escape');
  await expect(dialog(page)).toBeHidden();
});

test('erro aparece no campo antes de enviar e nada chega ao docker', async ({ page, gui }) => {
  await gui.open({ containers: [] });
  await openForm(page);
  await dialog(page).getByLabel('Imagem').fill('--privileged');
  await dialog(page).getByLabel('Portas').fill('0.0.0.0:8080:80');
  await dialog(page).getByLabel('Variáveis de ambiente').fill('1A=x');
  await dialog(page).getByLabel('Volume').fill('/etc:/host');
  await go(page).click();

  await expect(dialog(page).getByLabel('Imagem')).toBeFocused();
  for (const k of ['image', 'ports', 'env', 'volume']) await expect(page.locator(`#run-${k}`)).toHaveAttribute('aria-invalid', 'true');
  await expect(page.locator('#run-name')).not.toHaveAttribute('aria-invalid');
  await expect(page.locator('#run-image-err')).toContainText('Imagem inválida');
  await expect(page.locator('#run-volume-err')).toContainText('Pasta do host (bind mount) não é aceita.');
  expect(gui.read().run_calls).toBeUndefined();

  await dialog(page).getByLabel('Imagem').fill('redis:7');
  await dialog(page).getByLabel('Portas').fill('6379:6379');
  await dialog(page).getByLabel('Variáveis de ambiente').fill('');
  await dialog(page).getByLabel('Volume').fill('');
  await go(page).click();
  await expect(dialog(page)).toBeHidden();
  expect(gui.read().run_calls).toEqual([['run', '-d', '--restart=no', '-p', '127.0.0.1:6379:6379/tcp', '--', 'redis:7']]);
});

test('0.0.0.0 só com o aviso explícito', async ({ page, gui }) => {
  await gui.open({ containers: [] });
  await openForm(page);
  const warn = page.locator('#run-public-warn');
  await expect(warn).toBeHidden();
  await expect(go(page)).toHaveText('Criar e iniciar');

  await dialog(page).getByLabel('Publicar em todas as interfaces').check();
  await expect(warn).toBeVisible();
  await expect(warn).toContainText('passa a acessar essas portas');
  await expect(go(page)).toHaveText('Criar e expor na rede');

  await dialog(page).getByLabel('Imagem').fill('nginx');
  await dialog(page).getByLabel('Portas').fill('8080:80');
  await go(page).click();
  await expect(dialog(page)).toBeHidden();
  expect(gui.read().run_calls![0]).toContain('0.0.0.0:8080:80/tcp');
});

test('erro do docker fica no modal, com o formulário preenchido', async ({ page, gui }) => {
  await gui.open({
    containers: [],
    run_fail: "Unable to find image 'nao-existe:latest' locally\ndocker: Error response from daemon: pull access denied for nao-existe",
  });
  await openForm(page);
  await dialog(page).getByLabel('Imagem').fill('nao-existe');
  await go(page).click();
  const msg = page.locator('#create-msg');
  await expect(msg).toContainText('Não deu para criar nao-existe.');
  await expect(msg).toContainText('pull access denied for nao-existe');
  await expect(dialog(page)).toBeVisible();
  await expect(dialog(page).getByLabel('Imagem')).toHaveValue('nao-existe');
  await expect(go(page)).toBeFocused();
});

test('durante o envio o botão mostra o andamento', async ({ page, gui }) => {
  await gui.open({ containers: [], run_delay: 2 });
  await openForm(page);
  await dialog(page).getByLabel('Imagem').fill('nginx');
  await dialog(page).getByLabel('Nome').fill('web');
  await go(page).click();
  await expect(go(page)).toHaveText('Criando… (baixa a imagem se faltar)');
  await expect(go(page)).toHaveAttribute('aria-disabled', 'true');
  await expect(dialog(page).getByLabel('Imagem')).toBeDisabled();
  await expect(toast(page)).toHaveText('web criado, conferindo se ficou de pé…');
});

test('container que sobe e cai avisa, com atalho para os logs', async ({ page, gui }) => {
  await gui.open({ containers: [], run_after: { State: 'exited', Status: 'Exited (1) Less than a second ago' } });
  await openForm(page);
  await dialog(page).getByLabel('Imagem').fill('nginx');
  await dialog(page).getByLabel('Nome').fill('web');
  await go(page).click();
  await expect(toast(page)).toContainText('web subiu mas não ficou bem: Saiu com código 1 há <1 s.');
  await toast(page).getByRole('button', { name: 'Ver logs' }).click();
  await expect(page.locator('#dlg')).toBeVisible();
});
