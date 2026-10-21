import { test, expect, ctr, compose, type Gui } from './fixtures';
import type { Page } from '@playwright/test';

// Notification falsa: guarda o que seria mostrado e aceita o pedido de permissão; a página "sem foco" é o
// caso em que a notificação aparece (com a página em foco a lista e o favicon já avisam)
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const w = window as unknown as { notes: string[][] };
    w.notes = [];
    window.Notification = class {
      static permission = 'default';
      static async requestPermission() { this.permission = 'granted'; return 'granted'; }
      onclick = null;
      constructor(title: string, opts?: NotificationOptions) { w.notes.push([title, opts?.body ?? '']); }
      close() {}
    } as unknown as typeof Notification;
    document.hasFocus = () => false;
  });
});

const notes = (page: Page) => page.evaluate(() => (window as unknown as { notes: string[][] }).notes);
// número desenhado no favicon ('' = sem selo)
const badge = (page: Page) => page.locator('link[rel="icon"]').evaluate(l =>
  decodeURIComponent(l.getAttribute('href')!).match(/<text[^>]*>([^<]*)</)?.[1] ?? '');
// espera um poll que com certeza aconteceu: um container novo aparecendo na lista
const nextPoll = async (page: Page, gui: Gui, name: string) => {
  gui.update(s => { s.containers.push(ctr(name)); });
  await expect(page.getByRole('button', { name: `Logs ${name}` })).toBeVisible();
};

test('favicon conta a faixa de atenção e a notificação sai só na entrada', async ({ page, gui }) => {
  await gui.open({ containers: [ctr('web'), ctr('db', { State: 'exited', Status: 'Exited (1) 3 minutes ago' })] });
  await expect.poll(() => badge(page)).toBe('1');

  await page.getByRole('button', { name: 'Notificar quando algo der problema' }).click();
  await expect(page.locator('#toast')).toContainText('Pronto: aviso quando um container entrar na faixa de atenção');
  await expect(page.locator('#notify')).toBeHidden();
  expect(await notes(page)).toEqual([]);  // db já estava com problema ao abrir: não é novidade

  gui.update(s => { Object.assign(s.containers[0], { State: 'exited', Status: 'Exited (137) 2 seconds ago' }); });
  await expect.poll(() => badge(page)).toBe('2');
  await expect.poll(() => notes(page)).toEqual([['web precisa de atenção', 'Saiu com código 137 há 2 s']]);
  await nextPoll(page, gui, 'api');
  expect(await notes(page)).toHaveLength(1);  // continua na faixa: não repete a cada poll

  gui.update(s => { Object.assign(s.containers[0], { State: 'running', Status: 'Up 1 second' }); });
  await expect.poll(() => badge(page)).toBe('1');
  gui.update(s => { Object.assign(s.containers[0], { State: 'running', Status: 'Up 1 minute (unhealthy)' }); });
  await expect.poll(() => notes(page)).toHaveLength(2);  // saiu e voltou: é uma entrada nova
  expect((await notes(page))[1]).toEqual(['web precisa de atenção', 'Rodando há 1 min · healthcheck falhando']);
});

test('sem pedir permissão não notifica', async ({ page, gui }) => {
  await gui.open({ containers: [ctr('web')] });
  await expect(page.locator('#notify')).toBeVisible();
  gui.update(s => { Object.assign(s.containers[0], { State: 'exited', Status: 'Exited (1) 1 second ago' }); });
  await expect.poll(() => badge(page)).toBe('1');
  await nextPoll(page, gui, 'api');
  expect(await notes(page)).toEqual([]);
});

test('raiz e dependente entram juntos: uma notificação, com a raiz primeiro', async ({ page, gui }) => {
  await gui.open({ containers: [ctr('db', { Labels: compose('shop', 'db') })] });
  await page.getByRole('button', { name: 'Notificar quando algo der problema' }).click();
  await expect(page.locator('#notify')).toBeHidden();
  gui.update(s => {
    s.containers[0].Status = 'Up 1 minute (unhealthy)';
    s.containers.push(ctr('api', { Labels: compose('shop', 'api', 'db:service_healthy:false'), State: 'created', Status: 'Created' }));
  });
  await expect.poll(() => notes(page)).toEqual([['2 containers precisam de atenção', 'db, api']]);
});

test('memória perto do limite notifica, e a queda depois notifica de novo', async ({ page, gui }) => {
  const memAt = (p: number) => ({ CPUPerc: '1.00%', MemUsage: `${Math.round(p * 5.12)}MiB / 512MiB`, MemPerc: `${p.toFixed(2)}%` });
  await gui.open({ containers: [ctr('api', { stats: [memAt(50), memAt(50), memAt(95), memAt(96)] })] });
  await page.getByRole('button', { name: 'Notificar quando algo der problema' }).click();
  await expect(page.locator('#notify')).toBeHidden();
  await expect.poll(() => notes(page), { timeout: 30_000 })
    .toEqual([['api precisa de atenção', 'Memória em 96% do limite (492 MiB de 512 MiB)']]);

  // caiu por falta de memória: a causa mudou, então avisa de novo
  gui.update(s => { Object.assign(s.containers[0], { State: 'exited', Status: 'Exited (137) 1 second ago' }); });
  await expect.poll(() => notes(page)).toHaveLength(2);
  expect((await notes(page))[1]).toEqual(['api precisa de atenção', 'Saiu com código 137 há 1 s']);
});
