// Histórico do docker stats: sparkline de CPU e memória por container e rede/disco fora da tabela.
// O stats é consultado a cada 5 s, então cada leitura nova custa uns 5 s de teste.
import { test, expect, ctr, id, row, rowKeys, type Stats } from './fixtures';

const reading = (cpu: number, memMiB: number): Stats =>
  ({ CPUPerc: `${cpu.toFixed(2)}%`, MemUsage: `${memMiB}MiB / 1.944GiB`, MemPerc: '1.00%' });
const slow = { timeout: 15_000 };

test('sparkline de CPU e memória aparece com a segunda leitura, com mín, máx e agora no texto alternativo', async ({ page, gui }) => {
  await gui.open({ containers: [ctr('web', { stats: [reading(10, 100), reading(30, 200), reading(20, 150)] }), ctr('quieto')] });
  const us = page.locator(`#us-${id('web')}`), cpu = us.locator('[data-spark="cpu"]'), mem = us.locator('[data-spark="mem"]');
  await expect(us).toHaveText('CPU 10.00% · RAM 100MiB');
  await expect(cpu).toHaveCount(0);  // uma leitura só não é linha

  await expect(us).toHaveText('CPU 20.00% · RAM 150MiB', slow);  // terceira leitura
  await expect(cpu).toHaveAttribute('role', 'img');
  await expect(cpu).toHaveAttribute('aria-label', /^CPU nos últimos \d+ s: mín 10\.00%, máx 30\.00%, agora 20\.00%$/);
  await expect(mem).toHaveAttribute('aria-label', /^Memória nos últimos \d+ s: mín 100 MiB, máx 200 MiB, agora 150 MiB$/);
  // uma amostra por ponto, alinhadas à direita; o pico de CPU encosta no topo (y = 1, com a margem do traço)
  const pts = (await cpu.locator('polyline').getAttribute('points'))!.split(' ');
  expect(pts).toHaveLength(3);
  expect(pts[1].split(',')[1]).toBe('1');
  expect(pts[2].split(',')[0]).toBe('48');
  // o SVG em si fica fora da árvore de acessibilidade: quem fala é o role="img" em volta
  await expect(cpu.locator('svg')).toHaveAttribute('aria-hidden', 'true');
  await expect(page.locator(`#us-${id('quieto')}`)).toHaveCount(0);
});

test('rede e disco ficam no title da linha e no modal de logs, não na tabela', async ({ page, gui }) => {
  const s = { ...reading(1.5, 20), NetIO: '1.2kB / 648B', BlockIO: '0B / 4.1kB' };
  await gui.open({ containers: [ctr('web', { stats: s, logs: 'oi\n' })] });
  const us = page.locator(`#us-${id('web')}`);
  await expect(us).toHaveAttribute('title',
    'Memória: 20MiB / 1.944GiB (1.00%)\nRede: 1.2kB recebidos · 648B enviados\nDisco: 0B lidos · 4.1kB gravados');
  await expect(row(page, 'web')).not.toContainText('Rede');

  await page.getByRole('button', { name: 'Logs web' }).click();
  const usage = page.locator('#dlg-usage');
  await expect(usage).toContainText('CPU 1.50% · RAM 20MiB');
  await expect(usage).toContainText('Rede: 1.2kB recebidos · 648B enviados · Disco: 0B lidos · 4.1kB gravados');
  await expect(usage.locator('[data-spark="cpu"]')).toHaveAttribute('aria-label', /^CPU nos últimos/, slow);
});

test('no celular o sparkline cabe no card, sem rolagem horizontal', async ({ page, gui }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const name = 'um-container-com-nome-bem-comprido-de-verdade';
  await gui.open({ containers: [ctr(name, { stats: [reading(5, 900), reading(80, 1500)] })] });
  await expect(page.locator(`#us-${id(name)} [data-spark="mem"]`)).toBeVisible(slow);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);  // negativo: o espaço reservado da barra de rolagem
});

// memória perto do limite: p% de um limite de 512 MiB (com o MemPerc coerente, como o docker manda)
const memAt = (p: number, cpu = 1): Stats =>
  ({ CPUPerc: `${cpu.toFixed(2)}%`, MemUsage: `${Math.round(p * 5.12)}MiB / 512MiB`, MemPerc: `${p.toFixed(2)}%` });
const memSlow = { timeout: 25_000 };  // a entrada pede 2 leituras seguidas, uns 5 s cada

test('memória perto do limite entra na faixa na 2ª leitura alta e sai abaixo de 85%', async ({ page, gui }) => {
  await gui.open({ containers: [ctr('api', { stats: [memAt(50), memAt(95), memAt(96)] })] });
  const line = row(page, 'api').getByText('Memória em 96% do limite (492 MiB de 512 MiB)');
  await expect(line).toBeVisible(memSlow);
  expect(await rowKeys(page)).toContain('h:attn');
  await expect(page.locator('#count button[data-a="filter"]', { hasText: 'com problema' })).toHaveText('1 com problema');
  // de pé, mas no tom de aviso: a bolinha e o status em âmbar, não em verde
  await expect(page.locator(`#st-${id('api')}`)).toHaveClass(/text-warn-fg/);

  // o atalho abre os logs com os Processos abertos
  await row(page, 'api').getByRole('button', { name: 'Ver os processos de api' }).click();
  await expect(page.locator('#dlg')).toBeVisible();
  await expect(page.locator('#procs')).toHaveAttribute('open', '');
  await expect(page.locator('#dlg-status')).toContainText('Memória em 96% do limite');
  await page.keyboard.press('Escape');

  gui.update(s => { s.containers[0].stats = memAt(80); });
  await expect(line).toBeHidden(memSlow);
  await expect.poll(() => rowKeys(page), memSlow).not.toContain('h:attn');
});

test('container sem limite de memória nunca entra na faixa por memória', async ({ page, gui }) => {
  // sem limite, o docker põe a RAM toda como limite (aqui 15.6 GiB de 16 GiB)
  const full = (cpu: number): Stats => ({ CPUPerc: `${cpu.toFixed(2)}%`, MemUsage: '15.5GiB / 15.6GiB', MemPerc: '99.36%' });
  await gui.open({ containers: [ctr('web', { stats: [full(1), full(2), full(3)] })] });
  await expect(page.locator(`#us-${id('web')}`)).toContainText('CPU 3.00%', memSlow);  // a 3ª leitura chegou
  expect(await rowKeys(page)).not.toContain('h:attn');
  await expect(row(page, 'web')).not.toContainText('Memória em');
});

test('quem já estava perto do limite ao abrir entra na faixa na primeira leitura', async ({ page, gui }) => {
  await gui.open({ containers: [ctr('api', { stats: memAt(95) })] });
  await expect(row(page, 'api').getByText('Memória em 95% do limite')).toBeVisible(slow);
  expect(await rowKeys(page)).toContain('h:attn');
});
