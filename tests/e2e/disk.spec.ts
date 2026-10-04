import { test, expect, ctr, type DiskUsage } from './fixtures';

// linhas reais do `docker system df --format '{{json .}}'`
const DF: DiskUsage[] = [
  { Type: 'Images', TotalCount: '10', Active: '7', Size: '4.01GB', Reclaimable: '1.2GB (29%)' },
  { Type: 'Containers', TotalCount: '10', Active: '6', Size: '643.1kB', Reclaimable: '53.25kB (8%)' },
  { Type: 'Local Volumes', TotalCount: '14', Active: '10', Size: '1.147GB', Reclaimable: '165MB (14%)' },
  { Type: 'Build Cache', TotalCount: '2', Active: '0', Size: '16.38kB', Reclaimable: '16.38kB' },
];

const openDisk = async (page: import('@playwright/test').Page) => {
  await page.locator('#disk summary').click();
  await expect(page.locator('#df')).toContainText('Imagens');
};

test('Uso de disco mostra imagens, volumes e build cache', async ({ page, gui }) => {
  await gui.open({ containers: [ctr('web')], df: DF });
  await openDisk(page);
  const df = page.locator('#df');
  await expect(df).toContainText('4.01GB no total · 1.2GB (29%) liberável · 10 itens, 7 em uso');
  await expect(df).toContainText('Volumes');
  await expect(df).toContainText('Build cache');
  await expect(df).not.toContainText('643.1kB');  // containers ficam na lista, não aqui
});

test('limpar imagens usa a confirmação em 2 passos', async ({ page, gui }) => {
  await gui.open({ containers: [], df: DF });
  await openDisk(page);
  await page.getByRole('button', { name: 'Limpar imagens' }).click();
  const confirm = page.getByRole('button', { name: 'Confirmar limpeza de imagens' });
  await expect(confirm).toBeFocused();
  await expect(page.locator('#df')).toContainText('Apagar as imagens que nenhum container usa? Dá para baixar de novo. Esc cancela.');

  await confirm.click();  // logo em seguida, < 600 ms: duplo clique não confirma
  await page.keyboard.press('Escape');
  await expect(confirm).toBeHidden();
  expect(gui.read().pruned).toBeUndefined();

  await page.getByRole('button', { name: 'Limpar imagens' }).click();
  await page.waitForTimeout(700);  // passado o intervalo anti duplo clique
  await confirm.click();
  await expect(page.locator('#toast')).toHaveText('Imagens: 1.2GB liberados.');
  await expect(page.locator('#df')).toContainText('4.01GB no total · 0B liberável');
  expect(gui.read().pruned).toEqual(['image prune -a -f']);
});

test('armar a limpeza desarma a remoção de um container (e vice-versa)', async ({ page, gui }) => {
  await gui.open({ containers: [ctr('cron', { State: 'exited', Status: 'Exited (0) 3 days ago' })], df: DF });
  await openDisk(page);
  await page.locator('summary[aria-label="Mais ações para cron"]').click();
  await page.getByRole('button', { name: 'Remover…' }).click();
  await expect(page.getByRole('button', { name: 'Confirmar remoção de cron' })).toBeVisible();
  await page.getByRole('button', { name: 'Limpar build cache' }).click();
  await expect(page.getByRole('button', { name: 'Confirmar remoção de cron' })).toBeHidden();
  await page.waitForTimeout(700);
  await page.getByRole('button', { name: 'Confirmar limpeza de build cache' }).click();
  await expect(page.locator('#toast')).toHaveText('Build cache: 16.38kB liberados.');
  expect(gui.read().pruned).toEqual(['builder prune -a -f']);
  expect(gui.container('cron')).toBeDefined();
});
