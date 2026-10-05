// Histórico do docker stats: sparkline de CPU e memória por container e rede/disco fora da tabela.
// O stats é consultado a cada 5 s, então cada leitura nova custa uns 5 s de teste.
import { test, expect, ctr, id, row, type Stats } from './fixtures';

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
  expect(overflow).toBe(0);
});
