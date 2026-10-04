import { test, expect, ctr, compose } from './fixtures';

// labels de um projeto compose de verdade: pasta e arquivos (config_files tem vírgula no valor)
const FILES = '/srv/shop/compose.yml,/srv/shop/compose.override.yml';
const shop = (service: string) =>
  `${compose('shop', service)},com.docker.compose.project.working_dir=/srv/shop,com.docker.compose.project.config_files=${FILES}`;
const PREFIX = ['compose', '-p', 'shop', '--project-directory', '/srv/shop',
                '-f', '/srv/shop/compose.yml', '-f', '/srv/shop/compose.override.yml'];
const containers = () => [
  ctr('api', { Labels: shop('api'), State: 'exited', Status: 'Exited (0) 3 days ago' }),
  ctr('db', { Labels: shop('db') }),
  ctr('solto'),
];

test('compose up sobe o projeto a partir dos labels', async ({ page, gui }) => {
  await gui.open({ containers: containers() });
  await page.getByRole('button', { name: 'compose up do projeto shop', exact: true }).click();
  await expect(page.locator('#toast')).toHaveText('shop: compose up concluído.');
  expect(gui.read().compose_calls).toEqual([[...PREFIX, 'up', '-d']]);
  expect(gui.container('api')!.State).toBe('running');
});

test('compose down em 2 passos: Esc cancela, duplo clique não confirma', async ({ page, gui }) => {
  await gui.open({ containers: containers() });
  const down = page.getByRole('button', { name: 'compose down do projeto shop', exact: true });
  const confirm = page.getByRole('button', { name: 'Confirmar compose down do projeto shop' });

  await down.click();
  await expect(confirm).toBeVisible();
  await expect(page.locator('#rows [data-key="g:shop"]')).toContainText('Os volumes ficam; o projeto some da lista e só volta com up.');
  await page.keyboard.press('Escape');
  await expect(confirm).toBeHidden();

  await down.click();
  await confirm.click();  // logo em seguida, < 600 ms: não vale
  await expect(confirm).toBeVisible();
  expect(gui.read().compose_calls).toBeUndefined();

  await page.waitForTimeout(700);  // passado o intervalo anti duplo clique
  await confirm.click();
  await expect(page.locator('#toast')).toHaveText('shop: compose down concluído.');
  expect(gui.read().compose_calls).toEqual([[...PREFIX, 'down']]);
  await expect(page.locator('#rows [data-key="g:shop"]')).toHaveCount(0);
  expect(gui.read().containers.map(c => c.Names)).toEqual(['solto']);
  await expect(page.locator('#q')).toBeFocused();
});

test('compose que falha mostra a última linha do stderr', async ({ page, gui }) => {
  await gui.open({
    containers: containers(),
    compose_fail: ' api Pulling\nError response from daemon: pull access denied for acme/api',
  });
  await page.getByRole('button', { name: 'compose pull do projeto shop', exact: true }).click();
  await expect(page.locator('#toast')).toHaveText('shop: compose pull falhou. Error response from daemon: pull access denied for acme/api');
  expect(gui.read().compose_calls).toEqual([[...PREFIX, 'pull']]);
});
