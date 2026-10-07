import { test, expect, ctr } from './fixtures';

// a língua vem do servidor (DOCKER_GUI_LANG, --lang ou o locale): o HTML estático e o que o app.ts desenha trocam juntos
test('em inglês, a página inteira troca de língua', async ({ page, gui }) => {
  await gui.open({ containers: [ctr('web', { logs: 'GET / 200\n' }), ctr('cron', { State: 'exited', Status: 'Exited (137) 2 minutes ago', inspect: { State: { OOMKilled: true } } })] },
                 { env: { DOCKER_GUI_LANG: 'en' } });
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(page.getByRole('tab', { name: 'Networks' })).toBeVisible();  // do page.html
  await expect(page.locator('#count')).toHaveText('1 with problems1 running fine');  // do app.ts
  await expect(page.locator('#rows')).toContainText('Exited with code 137 2 min ago');  // do format.ts
  await expect(page.locator('#rows')).toContainText('out of memory (OOM)');
  await expect(page).toHaveTitle('Docker GUI · 1 running fine · 1 with problems');

  await page.getByRole('button', { name: 'Logs web' }).click();
  await expect(page.locator('#lmeta')).toContainText('Last 500 lines · updated at');
  await expect(page.getByLabel('Line level')).toHaveValue('');
  await page.keyboard.press('Escape');

  await page.getByRole('button', { name: '+ New container' }).click();
  await page.getByRole('button', { name: 'Create and start' }).click();
  await expect(page.locator('#run-image-err')).toHaveText('Enter the image, e.g. nginx:1.27 or ghcr.io/acme/api:1.4.');
});
