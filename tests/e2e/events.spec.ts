import { test, expect, ctr, id, type Gui, type DockerState } from './fixtures';
import type { Page } from '@playwright/test';

// conta as consultas à lista (/api/containers) feitas pela página
const countList = (page: Page) => {
  const n = { count: 0 };
  page.on('request', r => { if (new URL(r.url()).pathname === '/api/containers') n.count++; });
  return n;
};

// abre a página e espera o stream de eventos responder
const openLive = async (page: Page, gui: Gui, state: DockerState) => {
  const sse = page.waitForResponse(r => new URL(r.url()).pathname === '/api/events/stream');
  await gui.open(state);
  return (await sse).status();
};

test('com o stream de eventos, a lista muda na hora e o poll espaça', async ({ page, gui }) => {
  const list = countList(page);
  expect(await openLive(page, gui, { containers: [ctr('web')] })).toBe(200);
  await page.waitForTimeout(500);  // a consulta de quando o stream abre
  const before = list.count;
  await page.waitForTimeout(4_500);  // com o poll de 2 s seriam 2 consultas
  expect(list.count).toBe(before);

  gui.update(s => { Object.assign(s.containers[0], { State: 'exited', Status: 'Exited (137) 1 second ago' }); });
  await expect(page.locator(`#st-${id('web')}`)).toContainText('Saiu com código 137', { timeout: 2_000 });
});

test('rajada de eventos vira poucas consultas', async ({ page, gui }) => {
  const list = countList(page);
  await openLive(page, gui, { containers: [ctr('web')] });
  await page.waitForTimeout(500);
  const before = list.count;
  // 6 mudanças em ~200 ms, como um compose up: o docker falso olha o estado a cada 50 ms, então são uns 4 eventos
  for (let i = 1; i <= 6; i++) {
    gui.update(s => { s.containers.push(ctr(`svc${i}`)); });
    await new Promise(r => setTimeout(r, 35));
  }
  await expect(page.getByRole('button', { name: 'Logs svc6' })).toBeVisible();
  await page.waitForTimeout(500);
  expect(list.count - before).toBeLessThanOrEqual(3);
});

test('sem docker events (recusado ou terminou), volta ao poll de 2 s', async ({ page, gui }) => {
  const list = countList(page);
  await gui.open({ containers: [ctr('web')], events_error: 'Error: unknown command "events" for "podman"' });
  const before = list.count;
  await page.waitForTimeout(5_500);  // com o poll de 30 s seria no máximo 1 (a de quando o stream abriu)
  expect(list.count - before).toBeGreaterThanOrEqual(2);
  gui.update(s => { s.containers[0].Status = 'Up 6 minutes'; });
  await expect(page.locator(`#st-${id('web')}`)).toHaveText('Rodando há 6 min');
});

test('aba escondida fecha o stream e volta a abrir ao reaparecer', async ({ page, gui }) => {
  await openLive(page, gui, { containers: [ctr('web')] });
  const setHidden = (hidden: boolean) => page.evaluate(h => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => h });
    document.dispatchEvent(new Event('visibilitychange'));
  }, hidden);
  const reopened = page.waitForResponse(r => new URL(r.url()).pathname === '/api/events/stream');
  await setHidden(true);
  await setHidden(false);
  expect((await reopened).status()).toBe(200);
  gui.update(s => { s.containers[0].Status = 'Up 6 minutes'; });
  await expect(page.locator(`#st-${id('web')}`)).toHaveText('Rodando há 6 min');
});
