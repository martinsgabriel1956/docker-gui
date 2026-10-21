// docker pull pela aba Imagens: baixar pelo nome e Atualizar cada tag. O "registry" do docker falso diz o ID que
// cada ref tem lá; fora dele, o pull falha como uma imagem que não existe (ou pede login)
import { createHash } from 'node:crypto';
import { test, expect, ctr, type ImageRow } from './fixtures';
import type { Page } from '@playwright/test';

const sha = (name: string) => `sha256:${createHash('sha256').update(name).digest('hex')}`;
const img = (Repository: string, Tag: string, id = sha(`${Repository}:${Tag}`)): ImageRow =>
  ({ ID: id, Repository, Tag, Size: '100MB', CreatedAt: '2026-10-01 00:00:00 +0000 UTC' });
const openImages = async (page: Page) => {
  await page.locator('#tab-images').click();
  await expect(page.locator('#obj-images-list')).not.toHaveText('Carregando…');
};
const item = (page: Page, text: string) => page.locator('#obj-images-list tbody tr').filter({ hasText: text });

test('Baixar imagem pelo nome mostra a saída ao vivo e põe a imagem na lista', async ({ page, gui }) => {
  await gui.open({ containers: [ctr('web')], images: [], registry: { 'postgres:17': sha('pg17') }, pull_delay: 3 });
  await openImages(page);
  await page.locator('#pull-q').fill('postgres:17');
  await page.getByRole('button', { name: 'Baixar', exact: true }).click();
  await expect(page.locator('#pulls')).toContainText('docker pull postgres:17 · baixando…');
  await expect(page.locator('#pulls pre')).toContainText('Pulling from library/postgres');
  await expect(page.locator('#toast')).toHaveText('Baixada: postgres:17.', { timeout: 10_000 });
  await expect(page.locator('#pulls')).toBeEmpty();
  await expect(item(page, 'postgres:17')).toBeVisible();
  await expect(page.locator('#pull-q')).toHaveValue('');
});

test('sem tag, a dica diz latest; nome inválido não vai ao docker', async ({ page, gui }) => {
  const asked: string[] = [];
  page.on('request', r => asked.push(new URL(r.url()).pathname));
  await gui.open({ containers: [], images: [] });
  await openImages(page);
  await page.locator('#pull-q').fill('redis');
  await expect(page.locator('#pull-hint')).toHaveText('(tag latest)');
  await page.locator('#pull-q').fill('Postgres');
  await expect(page.locator('#pull-hint')).toHaveText('Imagem inválida: use repo[:tag] ou repo@sha256:…, com o caminho em minúsculas.');
  await page.locator('#pull-q').press('Enter');
  await expect(page.locator('#pulls')).toBeEmpty();
  expect(asked).not.toContain('/api/pull');
});

test('Atualizar diz quando a tag já estava em dia', async ({ page, gui }) => {
  await gui.open({ containers: [], images: [img('nginx', '1.27')], registry: { 'nginx:1.27': sha('nginx:1.27') } });
  await openImages(page);
  await item(page, 'nginx:1.27').getByRole('button', { name: 'Atualizar nginx:1.27' }).click();
  await expect(page.locator('#toast')).toHaveText('nginx:1.27 já estava em dia.');
  await expect(page.locator('#obj-images-list tbody tr')).toHaveCount(1);
});

test('Atualizar com versão nova deixa a anterior sem tag', async ({ page, gui }) => {
  await gui.open({ containers: [], images: [img('node', '22')], registry: { 'node:22': sha('node:22 nova') } });
  await openImages(page);
  await item(page, 'node:22').getByRole('button', { name: 'Atualizar node:22' }).click();
  await expect(page.locator('#toast')).toHaveText('Atualizada: node:22. A versão anterior ficou sem tag.');
  await expect(item(page, 'sem tag')).toContainText('dangling');
  await expect(item(page, 'node:22')).toContainText(sha('node:22 nova').slice(7, 19));
});

test('pull que falha traz a causa e deixa a saída aberta até o ×', async ({ page, gui }) => {
  await gui.open({ containers: [], images: [] });
  await openImages(page);
  await page.locator('#pull-q').fill('acme/privada:1');
  await page.locator('#pull-q').press('Enter');
  await expect(page.locator('#toast')).toContainText(
    'Não deu para baixar acme/privada:1. A imagem não existe no registry, ou falta login: confira o nome, a tag e o docker login.');
  await expect(page.locator('#pulls')).toContainText('docker pull acme/privada:1 · falhou (código 1)');
  await expect(page.locator('#pulls pre')).toContainText('pull access denied for acme/privada');
  await page.getByRole('button', { name: 'Fechar a saída do docker pull acme/privada:1' }).click();
  await expect(page.locator('#pulls')).toBeEmpty();
});

test('imagem sem tag não tem Atualizar; com duas tags, um por tag', async ({ page, gui }) => {
  const id = sha('app');
  await gui.open({ containers: [], images: [img('<none>', '<none>', sha('velha')), img('app', 'latest', id), img('app', '1.0', id)] });
  await openImages(page);
  await expect(item(page, 'sem tag').getByRole('button', { name: /^Atualizar/ })).toHaveCount(0);
  await expect(item(page, 'app:latest').getByRole('button', { name: /^Atualizar/ })).toHaveText(['Atualizar app:latest', 'Atualizar app:1.0']);
});
