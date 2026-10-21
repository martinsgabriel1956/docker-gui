import { test, expect, ctr } from './fixtures';

const DAEMON_DOWN = 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?';
const NO_PERMISSION = 'permission denied while trying to connect to the Docker daemon socket at unix:///var/run/docker.sock';

test('aba sem token explica onde achar o link', async ({ page, gui }) => {
  await gui.open({ containers: [ctr('web')] }, { token: false });
  await expect(page.locator('#banner')).toContainText('Esta aba não tem o token do Stivo.');
  await expect(page.locator('#banner')).toContainText('#t=…');
  await expect(page).toHaveTitle('Stivo · sem token');
  await expect(page.locator('#rows')).toHaveText('Sem dados ainda.');
});

test('daemon fora do ar: aviso com o detalhe técnico, e volta sozinho', async ({ page, gui }) => {
  await gui.open({ containers: [ctr('web')], ps_error: DAEMON_DOWN });
  const banner = page.locator('#banner');
  await expect(banner).toContainText('Não consegui falar com o Docker.');
  await expect(banner).toContainText('systemctl status docker');
  await banner.locator('summary', { hasText: 'Detalhes técnicos' }).click();
  await expect(banner.locator('pre')).toHaveText(DAEMON_DOWN);
  await expect(page).toHaveTitle('Stivo · Docker fora do ar');

  gui.update(s => { delete s.ps_error; });
  await expect(banner).toBeHidden();
  await expect(page.getByRole('button', { name: 'Logs web' })).toBeVisible();
});

test('sem permissão no socket: mostra o comando que resolve', async ({ page, gui }) => {
  await gui.open({ containers: [], ps_error: NO_PERMISSION });
  await expect(page.locator('#banner')).toContainText('Seu usuário não tem acesso ao Docker.');
  await expect(page.locator('#banner')).toContainText('sudo usermod -aG docker $USER');
  await expect(page).toHaveTitle('Stivo · sem acesso ao Docker');
});

test('dados velhos ficam visíveis mas não aceitam clique', async ({ page, gui }) => {
  await gui.open({ containers: [ctr('web')] });
  await expect(page.getByRole('button', { name: 'Parar web' })).toBeVisible();
  gui.update(s => { s.ps_error = DAEMON_DOWN; });
  await expect(page.locator('#banner')).toBeVisible();
  await expect(page.locator('#table')).toHaveJSProperty('inert', true);
  await expect(page.locator('#count')).toHaveText(/^Desatualizado · dados de \d\d:\d\d$/);
  await expect(page.locator(`#rows`)).toContainText('web');  // a lista continua lá, só esmaecida

  gui.update(s => { delete s.ps_error; });
  await expect(page.locator('#table')).toHaveJSProperty('inert', false);
});

test('servidor do Stivo caiu', async ({ page, gui }) => {
  await gui.open({ containers: [ctr('web')] });
  await expect(page.getByRole('button', { name: 'Logs web' })).toBeVisible();
  await gui.stop();
  await expect(page.locator('#banner')).toContainText('O servidor do Stivo parou de responder.');
  await expect(page).toHaveTitle('Stivo · sem conexão');
});

test('ação sem resposta do servidor fica registrada na linha', async ({ page, gui }) => {
  await gui.open({ containers: [ctr('web')] });
  await expect(page.getByRole('button', { name: 'Parar web' })).toBeVisible();
  await gui.stop();
  await page.getByRole('button', { name: 'Parar web' }).click();
  await expect(page.locator('#toast')).toHaveText('Não deu para parar web. O erro ficou na linha.');
});
