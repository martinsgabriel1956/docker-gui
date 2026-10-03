// A página consulta o docker a cada 2 s e redesenha só as linhas que mudaram. Estes testes travam o que
// esse redesenho preserva: foco, <details> abertos, seleção de texto e os próprios nós do DOM.
import { test, expect, ctr, id, row } from './fixtures';

const poll = 2_500;  // um ciclo de consulta com folga

test('linha que não mudou não é recriada', async ({ page, gui }) => {
  await gui.open({ containers: [ctr('a'), ctr('b')] });
  await row(page, 'a').evaluate(tr => { (tr as any).marca = 1; });
  gui.update(s => { s.containers[1].Status = 'Up 6 minutes'; });
  await expect(page.locator(`#st-${id('b')}`)).toHaveText('Rodando há 6 min');
  expect(await row(page, 'a').evaluate(tr => (tr as any).marca)).toBe(1);
});

test('foco do teclado sobrevive quando a própria linha é redesenhada', async ({ page, gui }) => {
  await gui.open({ containers: [ctr('a'), ctr('b')] });
  await page.getByRole('button', { name: 'Logs a' }).focus();
  gui.update(s => { s.containers[0].Status = 'Up 6 minutes'; });
  await expect(page.locator(`#st-${id('a')}`)).toHaveText('Rodando há 6 min');
  await expect(page.getByRole('button', { name: 'Logs a' })).toBeFocused();
});

test('details aberto continua aberto depois do redesenho', async ({ page, gui }) => {
  const health = { Status: 'unhealthy', Log: [{ ExitCode: 1, Output: 'falhou' }] };
  await gui.open({ containers: [ctr('api', { Status: 'Up 5 minutes (unhealthy)', health })] });
  const details = row(page, 'api').locator('details[data-keep="health"]');
  await details.locator('summary').click();
  await expect(details).toHaveAttribute('open', '');
  gui.update(s => { s.containers[0].Status = 'Up 6 minutes (unhealthy)'; });
  await expect(page.locator(`#st-${id('api')}`)).toHaveText('Rodando há 6 min · healthcheck falhando');
  await expect(details).toHaveAttribute('open', '');
});

test('seleção de texto segura o redesenho até acabar', async ({ page, gui }) => {
  await gui.open({ containers: [ctr('a', { Image: 'registro/imagem-para-copiar:1.0' })] });
  // seleciona o nome da imagem, como quem vai copiar
  await row(page, 'a').locator('bdi').evaluate(el => {
    const r = document.createRange();
    r.selectNodeContents(el);
    getSelection()!.removeAllRanges();
    getSelection()!.addRange(r);
  });
  gui.update(s => { s.containers[0].Status = 'Up 6 minutes'; });
  await page.waitForTimeout(poll);
  await expect(page.locator(`#st-${id('a')}`)).toHaveText('Rodando há 5 min');  // dado novo chegou, mas segurou
  expect(await page.evaluate(() => getSelection()!.toString())).toBe('registro/imagem-para-copiar:1.0');

  await page.evaluate(() => getSelection()!.removeAllRanges());
  await expect(page.locator(`#st-${id('a')}`)).toHaveText('Rodando há 6 min');
});

test('menu "⋯" aberto não fecha sozinho com o poll', async ({ page, gui }) => {
  await gui.open({ containers: [ctr('a'), ctr('b')] });
  const menu = row(page, 'a').locator('details[data-keep="menu"]');
  await menu.locator('summary').click();
  gui.update(s => { s.containers[1].Status = 'Up 6 minutes'; });
  await expect(page.locator(`#st-${id('b')}`)).toHaveText('Rodando há 6 min');
  await expect(menu).toHaveAttribute('open', '');
  await page.keyboard.press('Escape');
  await expect(menu).not.toHaveAttribute('open', '');
});

test('aba escondida não consulta o docker', async ({ page, gui }) => {
  await gui.open({ containers: [ctr('a')] });
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
  });
  gui.update(s => { s.containers[0].Status = 'Up 6 minutes'; });
  await page.waitForTimeout(poll);
  await expect(page.locator(`#st-${id('a')}`)).toHaveText('Rodando há 5 min');
  // ao voltar, atualiza na hora
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect(page.locator(`#st-${id('a')}`)).toHaveText('Rodando há 6 min');
});
