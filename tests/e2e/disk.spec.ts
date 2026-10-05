import { createHash } from 'node:crypto';
import { test, expect, ctr, type DiskUsage, type DockerState } from './fixtures';

// linhas reais do `docker system df --format '{{json .}}'`
const DF: DiskUsage[] = [
  { Type: 'Images', TotalCount: '10', Active: '7', Size: '4.01GB', Reclaimable: '1.2GB (29%)' },
  { Type: 'Containers', TotalCount: '10', Active: '6', Size: '643.1kB', Reclaimable: '53.25kB (8%)' },
  { Type: 'Local Volumes', TotalCount: '14', Active: '10', Size: '1.147GB', Reclaimable: '165MB (14%)' },
  { Type: 'Build Cache', TotalCount: '2', Active: '0', Size: '16.38kB', Reclaimable: '16.38kB' },
];

// a aba abre e a lista dela chega (o df chega junto, nas abas que têm)
const openTab = async (page: import('@playwright/test').Page, k: 'images' | 'volumes' | 'networks') => {
  await page.locator(`#tab-${k}`).click();
  await expect(page.locator(`#obj-${k}-list`)).not.toHaveText('Carregando…');
};

test('cada aba mostra o uso de disco dela: build cache junto das imagens', async ({ page, gui }) => {
  await gui.open({ containers: [ctr('web')], df: DF });
  await openTab(page, 'images');
  const df = page.locator('#df-images');
  await expect(df).toContainText('4.01GB no total · 1.2GB (29%) liberável · 10 itens, 7 em uso');
  await expect(df).toContainText('Build cache');
  await expect(df).not.toContainText('Volumes');
  await openTab(page, 'volumes');
  await expect(page.locator('#df-volumes')).toContainText('1.147GB no total');
  await expect(page.locator('#df-volumes')).not.toContainText('Build cache');
  await expect(page.locator('main')).not.toContainText('643.1kB');  // containers ficam na lista, não aqui
});

test('limpar imagens usa a confirmação em 2 passos', async ({ page, gui }) => {
  await gui.open({ containers: [], df: DF });
  await openTab(page, 'images');
  await page.getByRole('button', { name: 'Limpar imagens' }).click();
  const confirm = page.getByRole('button', { name: 'Confirmar limpeza de imagens' });
  await expect(page.getByRole('button', { name: 'Cancelar limpeza de imagens' })).toBeFocused();
  await expect(page.locator('#df-images')).toContainText('Apagar as imagens que nenhum container usa? Libera até 1.2GB, de 3 itens sem uso. Dá para baixar de novo. Esc cancela.');

  await confirm.click();  // logo em seguida, < 600 ms: duplo clique não confirma
  await page.getByRole('button', { name: 'Cancelar limpeza de imagens' }).click();
  await expect(confirm).toBeHidden();
  expect(gui.read().pruned).toBeUndefined();

  await page.getByRole('button', { name: 'Limpar imagens' }).click();
  await page.waitForTimeout(700);  // passado o intervalo anti duplo clique
  await confirm.click();
  await expect(page.locator('#toast')).toHaveText('Imagens: 1.2GB liberados.');
  await expect(page.locator('#df-images')).toContainText('4.01GB no total · 0B liberável');
  expect(gui.read().pruned).toEqual(['image prune -a -f']);
});

test('trocar de aba desarma a remoção de um container', async ({ page, gui }) => {
  await gui.open({ containers: [ctr('cron', { State: 'exited', Status: 'Exited (0) 3 days ago' })], df: DF });
  await page.locator('summary[aria-label="Mais ações para cron"]').click();
  await page.getByRole('button', { name: 'Remover…' }).click();
  await expect(page.getByRole('button', { name: 'Confirmar remoção de cron' })).toBeVisible();
  await openTab(page, 'images');
  await page.locator('#tab-containers').click();
  await expect(page.getByRole('button', { name: 'Confirmar remoção de cron' })).toHaveCount(0);
  await openTab(page, 'images');
  await page.getByRole('button', { name: 'Limpar build cache' }).click();
  await page.waitForTimeout(700);
  await page.getByRole('button', { name: 'Confirmar limpeza de build cache' }).click();
  await expect(page.locator('#toast')).toHaveText('Build cache: 16.38kB liberados.');
  expect(gui.read().pruned).toEqual(['builder prune -a -f']);
  expect(gui.container('cron')).toBeDefined();
});

// imagens, volumes e redes um a um: ID inteiro (64 hex) por nome, como o --no-trunc do docker
const sha = (name: string) => createHash('sha256').update(name).digest('hex');
const created = (daysAgo: number) =>  // CreatedAt do docker: "2026-09-18 00:00:00 +0000 UTC"
  new Date(Date.now() - daysAgo * 86400_000).toISOString().replace('T', ' ').slice(0, 19) + ' +0000 UTC';
const ANON = sha('anonimo');
const OBJECTS = (): DockerState => ({
  containers: [
    ctr('db', { inspect: { Image: `sha256:${sha('postgres')}`, Mounts: [{ Type: 'volume', Name: 'pgdata', Destination: '/data' }],
                           NetworkSettings: { Networks: { loja_default: { IPAddress: '172.18.0.2' } } } } }),
    ctr('web', { State: 'exited', Status: 'Exited (0) 2 days ago', inspect: { Image: `sha256:${sha('nginx')}` } }),
  ],
  df: DF,
  images: [
    { ID: `sha256:${sha('postgres')}`, Repository: 'postgres', Tag: '16', Size: '412MB', CreatedAt: created(20) },
    { ID: `sha256:${sha('nginx')}`, Repository: 'nginx', Tag: 'latest', Size: '187MB', CreatedAt: created(3) },
    { ID: `sha256:${sha('app')}`, Repository: 'app', Tag: 'latest', Size: '90MB', CreatedAt: created(1) },
    { ID: `sha256:${sha('app')}`, Repository: 'app', Tag: '1.0', Size: '90MB', CreatedAt: created(1) },
    { ID: `sha256:${sha('old')}`, Repository: '<none>', Tag: '<none>', Size: '12MB', CreatedAt: created(100) },
  ],
  volumes: [{ Name: 'cache', Driver: 'local' }, { Name: 'pgdata', Driver: 'local' }, { Name: ANON, Driver: 'local' }],
  networks: [
    { ID: sha('bridge'), Name: 'bridge', Driver: 'bridge', Scope: 'local' },
    { ID: sha('host'), Name: 'host', Driver: 'host', Scope: 'local' },
    { ID: sha('loja'), Name: 'loja_default', Driver: 'bridge', Scope: 'local' },
    { ID: sha('none'), Name: 'none', Driver: 'null', Scope: 'local' },
    { ID: sha('velha'), Name: 'velha', Driver: 'bridge', Scope: 'local' },
  ],
});
const item = (page: import('@playwright/test').Page, k: string, text: string) =>
  page.locator(`#obj-${k}-list li`).filter({ hasText: text });

test('imagens, volumes e redes só vão ao docker quando a aba abre', async ({ page, gui }) => {
  const asked: string[] = [];
  page.on('request', r => asked.push(new URL(r.url()).pathname));
  await gui.open(OBJECTS());
  await expect(page.locator('#count')).not.toHaveText('Carregando…');
  expect(asked.filter(p => /images|volumes|networks|df/.test(p))).toEqual([]);

  await openTab(page, 'images');
  await expect(page.locator('#tab-images')).toHaveText('Imagens · 4');
  await expect(item(page, 'images', 'postgres:16'))
    .toContainText(`${sha('postgres').slice(0, 12)} · 412MB · criada há 2 sem · em uso por db`);
  await expect(item(page, 'images', 'nginx:latest')).toContainText('em uso por web');  // parado também conta
  await expect(item(page, 'images', 'app:latest, app:1.0')).toContainText('sem uso');  // duas tags, uma imagem
  await expect(item(page, 'images', 'sem tag')).toContainText('dangling');
  await expect(item(page, 'images', 'sem tag')).toContainText(`${sha('old').slice(0, 12)} · 12MB`);
  expect(asked.filter(p => /volumes|networks/.test(p))).toEqual([]);

  await openTab(page, 'volumes');
  await expect(item(page, 'volumes', 'pgdata')).toContainText('local · em uso por db');
  await expect(item(page, 'volumes', 'cache')).toContainText('sem uso');
  await expect(item(page, 'volumes', 'anônimo')).toContainText(ANON.slice(0, 12));

  await openTab(page, 'networks');
  await expect(item(page, 'networks', 'loja_default')).toContainText('bridge · local · em uso por db');
  await expect(item(page, 'networks', 'padrão')).toContainText(['bridge', 'host', 'none']);
  for (const builtin of ['bridge', 'host', 'none'])
    await expect(page.getByRole('button', { name: `Remover a rede ${builtin}` })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Remover a rede velha' })).toBeVisible();
});

test('remover um volume usa a confirmação em 2 passos', async ({ page, gui }) => {
  await gui.open(OBJECTS());
  await openTab(page, 'volumes');
  await page.getByRole('button', { name: 'Remover o volume cache' }).click();
  const confirm = page.getByRole('button', { name: 'Confirmar remoção de o volume cache' });
  await expect(page.getByRole('button', { name: 'Cancelar remoção de o volume cache' })).toBeFocused();
  await expect(item(page, 'volumes', 'cache')).toContainText('Apagar o volume cache? Os dados dele se perdem. Esc cancela.');

  await page.keyboard.press('Escape');
  await expect(confirm).toBeHidden();
  expect(gui.read().removed).toBeUndefined();

  await page.getByRole('button', { name: 'Remover o volume cache' }).click();
  await page.waitForTimeout(700);
  await confirm.click();
  await expect(page.locator('#toast')).toHaveText('Volume cache removido.');
  await expect(item(page, 'volumes', 'cache')).toHaveCount(0);
  await expect(page.locator('#tab-volumes')).toHaveText('Volumes · 2');
  expect(gui.read().removed).toEqual(['volume rm cache']);
  // o foco vai para o próximo item, não se perde no body
  await expect(page.getByRole('button', { name: 'Remover o volume pgdata' })).toBeFocused();
});

test('em uso: o erro do docker aparece explicado e o item fica', async ({ page, gui }) => {
  await gui.open(OBJECTS());
  await openTab(page, 'volumes');
  await page.getByRole('button', { name: 'Remover o volume pgdata' }).click();
  await page.waitForTimeout(700);
  await page.getByRole('button', { name: 'Confirmar remoção de o volume pgdata' }).click();
  await expect(page.locator('#toast')).toHaveText(
    'Não deu para remover o volume pgdata. Em uso: remova o container que usa (ou tire ele da rede) antes.');
  const pg = item(page, 'volumes', 'pgdata');
  await expect(pg).toContainText(`Error response from daemon: remove pgdata: volume is in use - [${gui.container('db')!.ID}]`);
  await expect(page.getByRole('button', { name: 'Remover o volume pgdata' })).toBeFocused();
  expect(gui.read().volumes!.map(v => v.Name)).toContain('pgdata');

  // imagem com duas tags: o docker exige -f, e a página diz o que fazer
  await openTab(page, 'images');
  await page.getByRole('button', { name: 'Remover a imagem app:latest, app:1.0' }).click();
  await page.waitForTimeout(700);
  await page.getByRole('button', { name: 'Confirmar remoção de a imagem app:latest, app:1.0' }).click();
  await expect(item(page, 'images', 'app:latest')).toContainText('A imagem tem mais de uma tag');
  await expect(item(page, 'images', 'app:latest')).toContainText('image is referenced in multiple repositories');
  expect(gui.read().removed).toBeUndefined();
});

test('remover uma imagem atualiza a lista e o uso de disco', async ({ page, gui }) => {
  await gui.open(OBJECTS());
  await openTab(page, 'images');
  await page.getByRole('button', { name: `Remover a imagem sem tag ${sha('old').slice(0, 12)}` }).click();
  await page.waitForTimeout(700);
  gui.update(s => { s.df![0].Size = '3.99GB'; });  // o que o docker system df diria depois
  await page.getByRole('button', { name: `Confirmar remoção de a imagem sem tag ${sha('old').slice(0, 12)}` }).click();
  await expect(page.locator('#toast')).toHaveText(`Imagem sem tag ${sha('old').slice(0, 12)} removida.`);
  await expect(item(page, 'images', 'sem tag')).toHaveCount(0);
  await expect(page.locator('#df-images')).toContainText('3.99GB no total');
  expect(gui.read().removed).toEqual([`image rm ${sha('old')}`]);
});

test('remover uma rede criada; as padrão não têm botão', async ({ page, gui }) => {
  await gui.open(OBJECTS());
  await openTab(page, 'networks');
  await page.getByRole('button', { name: 'Remover a rede velha' }).click();
  await expect(item(page, 'networks', 'velha')).toContainText('Apagar a rede velha? Esc cancela.');
  await page.waitForTimeout(700);
  await page.getByRole('button', { name: 'Confirmar remoção de a rede velha' }).click();
  await expect(page.locator('#toast')).toHaveText('Rede velha removida.');
  await expect(item(page, 'networks', 'velha')).toHaveCount(0);
  expect(gui.read().removed).toEqual([`network rm ${sha('velha')}`]);
});

test('a aba fica na URL, o voltar do navegador volta de aba e as setas andam entre elas', async ({ page, gui }) => {
  await gui.open(OBJECTS());
  await openTab(page, 'volumes');
  await expect(page).toHaveURL(/#aba=volumes$/);
  await expect(page.locator('#panel-containers')).toBeHidden();
  await page.reload();  // o token já está no localStorage desta aba
  await expect(page.getByRole('tab', { name: 'Volumes' })).toHaveAttribute('aria-selected', 'true');
  await expect(item(page, 'volumes', 'pgdata')).toBeVisible();

  await page.goBack();  // o reload não cria entrada: volta para a aba Containers de antes
  await expect(page.locator('#panel-containers')).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Containers' })).toHaveAttribute('aria-selected', 'true');

  await page.getByRole('tab', { name: 'Containers' }).focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('tab', { name: 'Imagens' })).toBeFocused();
  await expect(page.locator('#panel-images')).toBeVisible();
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowLeft');  // dá a volta
  await expect(page.getByRole('tab', { name: 'Redes' })).toBeFocused();
  await expect(item(page, 'networks', 'velha')).toBeVisible();

  // os atalhos da lista não mexem nos containers escondidos; / volta para a busca
  await page.keyboard.press('a');
  await expect(page.locator('#bulk')).toBeHidden();
  await page.keyboard.press('/');
  await expect(page.locator('#q')).toBeFocused();
  await expect(page.locator('#panel-containers')).toBeVisible();
});
