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
// o que não é a ação principal nem Logs fica no "⋯" do projeto
const projectMenu = (page: import('@playwright/test').Page) => page.locator('summary[aria-label="Mais ações do projeto shop"]');

test('cabeçalho do projeto mostra só a ação principal, Logs e o ⋯', async ({ page, gui }) => {
  await gui.open({ containers: containers() });
  const head = page.locator('#rows [data-key="g:shop"]');
  // api parado: a principal é Iniciar (com um só, diz qual); Reiniciar, Parar e os comandos do compose ficam no menu
  await expect(head.getByRole('button').filter({ visible: true })).toHaveText(['Iniciar api', 'Logs']);
  await expect(page.getByRole('button', { name: 'compose up do projeto shop', exact: true })).toBeHidden();
  await projectMenu(page).click();
  await expect(head.getByRole('button').filter({ visible: true }))
    .toHaveText(['Iniciar api', 'Logs', 'Reiniciar db', 'Parar db', 'compose up', 'compose up --build', 'compose pull', 'compose down…']);
  await page.keyboard.press('Escape');

  // tudo rodando: a principal vira Parar tudo
  gui.update(s => { s.containers[0].State = 'running'; s.containers[0].Status = 'Up 1 second'; });
  await expect(head.getByRole('button').filter({ visible: true })).toHaveText(['Parar tudo (2)', 'Logs']);
});

test('serviço do arquivo sem container aparece no cabeçalho e sobe pelo menu', async ({ page, gui }) => {
  await gui.open({ containers: containers(), compose_services: { shop: ['api', 'db', 'worker'] } });
  const head = page.locator('#rows [data-key="g:shop"]');
  await expect(head).toContainText('sem container: worker');
  await projectMenu(page).click();
  await page.getByRole('button', { name: 'compose up worker do projeto shop' }).click();
  await expect(page.locator('#toast')).toHaveText('shop-worker-1 está de pé.');
  expect(gui.read().compose_calls).toEqual([[...PREFIX, 'up', '-d', '--', 'worker']]);
  await expect(head).not.toContainText('sem container');
  await expect(page.locator('#rows')).toContainText('shop-worker-1');
});

test('serviço que nasce pelo terminal sai da lista dos sem container', async ({ page, gui }) => {
  await gui.open({ containers: containers(), compose_services: { shop: ['api', 'db', 'worker'] } });
  const head = page.locator('#rows [data-key="g:shop"]');
  await expect(head).toContainText('sem container: worker');
  // um compose up worker pelo terminal: o container novo muda os serviços do projeto, e a lista é relida
  gui.update(s => { s.containers.push(ctr('shop-worker-1', { Labels: shop('worker') })); });
  await expect(page.locator('#rows')).toContainText('shop-worker-1');
  await expect(head).not.toContainText('sem container');
});

test('compose up sobe o projeto a partir dos labels', async ({ page, gui }) => {
  await gui.open({ containers: containers() });
  await projectMenu(page).click();
  await page.getByRole('button', { name: 'compose up do projeto shop', exact: true }).click();
  await expect(page.locator('#toast')).toHaveText('shop: compose up concluído.');
  expect(gui.read().compose_calls).toEqual([[...PREFIX, 'up', '-d']]);
  expect(gui.container('api')!.State).toBe('running');
});

test('compose down em 2 passos: Esc cancela, duplo clique não confirma', async ({ page, gui }) => {
  await gui.open({ containers: containers() });
  const down = page.getByRole('button', { name: 'compose down do projeto shop', exact: true });
  const confirm = page.getByRole('button', { name: 'Confirmar compose down do projeto shop' });

  await projectMenu(page).click();
  await down.click();
  await expect(confirm).toBeVisible();
  await expect(page.getByRole('button', { name: 'Cancelar compose down do projeto shop' })).toBeFocused();
  await expect(page.locator('#armdock')).toContainText('Derrubar shop? Remove api e db e as redes do projeto. Os volumes ficam; para subir de novo, use compose up no terminal.');
  await page.keyboard.press('Escape');
  await expect(confirm).toBeHidden();
  // o × também cancela (no toque não há Esc)
  await projectMenu(page).click();
  await down.click();
  await page.getByRole('button', { name: 'Cancelar compose down do projeto shop' }).click();
  await expect(confirm).toBeHidden();
  await expect(projectMenu(page)).toBeFocused();

  await projectMenu(page).click();
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

test('o compose down diz primeiro os containers da faixa de atenção', async ({ page, gui }) => {
  await gui.open({ containers: [
    ctr('api', { Labels: shop('api') }), ctr('db', { Labels: shop('db') }), ctr('cache', { Labels: shop('cache') }),
    ctr('web', { Labels: shop('web'), State: 'exited', Status: 'Exited (137) 2 minutes ago' }),
  ] });
  await projectMenu(page).click();
  await page.getByRole('button', { name: 'compose down do projeto shop', exact: true }).click();
  // todos pelo nome (até 10), o que caiu primeiro
  await expect(page.locator('#armdock')).toContainText('Remove web, api, db e cache');
});

test('compose que falha mostra a última linha do stderr', async ({ page, gui }) => {
  await gui.open({
    containers: containers(),
    // um erro sem explicação conhecida (os conhecidos viram a causa traduzida: errHint)
    compose_fail: ' api Pulling\nError response from daemon: Get "https://registry.acme/v2/": net/http: TLS handshake timeout',
  });
  await projectMenu(page).click();
  await page.getByRole('button', { name: 'compose pull do projeto shop', exact: true }).click();
  await expect(page.locator('#toast')).toHaveText('shop: compose pull falhou. Error response from daemon: Get "https://registry.acme/v2/": net/http: TLS handshake timeout');
  expect(gui.read().compose_calls).toEqual([[...PREFIX, 'pull']]);
});

test('compose up --build reconstrói o projeto', async ({ page, gui }) => {
  await gui.open({ containers: containers() });
  await projectMenu(page).click();
  await page.getByRole('button', { name: 'compose up --build do projeto shop', exact: true }).click();
  await expect(page.locator('#toast')).toHaveText('shop: compose up --build concluído.');
  expect(gui.read().compose_calls).toEqual([[...PREFIX, 'up', '-d', '--build']]);
  expect(gui.container('api')!.State).toBe('running');
});

test('Reiniciar serviço pelo menu roda compose restart só daquele serviço', async ({ page, gui }) => {
  // duas réplicas do db: as duas passam pelo "conferindo se ficou de pé"
  await gui.open({ containers: [...containers(), ctr('db-2', { Labels: shop('db') })] });
  await page.locator('summary[aria-label="Mais ações para solto"]').click();
  await expect(page.getByRole('button', { name: 'Pausar' })).toBeVisible();
  await expect(page.getByRole('button', { name: /Reiniciar serviço/ })).toHaveCount(0);  // sem compose, sem o item
  await page.keyboard.press('Escape');

  await page.locator('summary[aria-label="Mais ações para db"]').click();
  await page.getByRole('button', { name: 'Reiniciar serviço db' }).click();
  await expect(page.locator('#toast')).toHaveText('Os 2 containers estão de pé.');
  expect(gui.read().compose_calls).toEqual([[...PREFIX, 'restart', '--', 'db']]);
  expect(gui.container('api')!.State).toBe('exited');  // outro serviço: fica como estava
});

test('Reconstruir serviço roda compose up --build --no-deps só daquele serviço', async ({ page, gui }) => {
  await gui.open({ containers: [ctr('api', { Labels: shop('api') }), ctr('db', { Labels: shop('db'), State: 'exited', Status: 'Exited (0) 1 hour ago' })] });
  await page.locator('summary[aria-label="Mais ações para api"]').click();
  await page.getByRole('button', { name: 'Reconstruir serviço api' }).click();
  await expect(page.locator('#toast')).toHaveText('api está de pé.');
  expect(gui.read().compose_calls).toEqual([[...PREFIX, 'up', '-d', '--build', '--no-deps', '--', 'api']]);
  expect(gui.container('db')!.State).toBe('exited');  // --no-deps: a dependência fica como estava
});

test('Reconstruir serviço que recria o container confere o container novo', async ({ page, gui }) => {
  // imagem nova: o compose troca o container por outro (outro ID), que sobe e cai
  await gui.open({ containers: [ctr('api', { Labels: shop('api') })],
                   compose_recreate: { State: 'exited', Status: 'Exited (1) Less than a second ago' } });
  await page.locator('summary[aria-label="Mais ações para api"]').click();
  await page.getByRole('button', { name: 'Reconstruir serviço api' }).click();
  await expect(page.locator('#toast')).toContainText('api subiu mas não ficou bem: Saiu com código 1');
});

test('b reconstrói o serviço da linha em foco; nos logs, o dos logs, que seguem o container novo', async ({ page, gui }) => {
  await gui.open({ containers: [ctr('api', { Labels: shop('api'), logs: '2026-01-01T00:00:01Z velho\n' }), ctr('solto')] });
  await page.getByRole('button', { name: 'Logs solto' }).focus();
  await page.keyboard.press('b');  // sem compose: nada
  await page.getByRole('button', { name: 'Logs api' }).focus();
  await page.keyboard.press('b');
  await expect(page.locator('#toast')).toHaveText('api está de pé.');
  expect(gui.read().compose_calls).toEqual([[...PREFIX, 'up', '-d', '--build', '--no-deps', '--', 'api']]);

  // nos logs: o build troca o container (outro ID); a caixa passa a seguir o novo, ao vivo
  gui.update(s => { s.compose_recreate = { State: 'running', Status: 'Up Less than a second' }; });
  await page.getByRole('button', { name: 'Logs api' }).click();
  await expect(page.locator('#lb')).toContainText('velho');
  await page.keyboard.press('b');
  await expect(page.locator('#follow')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#dlg-status')).toContainText('reconstruído às');
  await expect(page.locator('#dlg-status')).not.toContainText('não existe mais');
});

test('Reiniciar serviço que falha mostra a última linha do stderr', async ({ page, gui }) => {
  await gui.open({ containers: containers(), compose_fail: 'no such service: db' });
  await page.locator('summary[aria-label="Mais ações para db"]').click();
  await page.getByRole('button', { name: 'Reiniciar serviço db' }).click();
  await expect(page.locator('#toast')).toHaveText('shop: compose restart db falhou. no such service: db');
});

test('Logs do projeto juntam os serviços em ordem, com o prefixo de cada um', async ({ page, gui }) => {
  const cs = containers();
  cs[0].logs = '2026-10-05T10:00:02Z api pronto\n';
  cs[1].logs = '2026-10-05T10:00:01Z db pronto\n';
  await gui.open({ containers: cs });
  await page.getByRole('button', { name: 'Logs do projeto shop' }).click();
  await expect(page.locator('#lt')).toHaveText('shop');
  await expect(page.locator('#lb')).toHaveText('db-1  | 2026-10-05T10:00:01Z db pronto\napi-1  | 2026-10-05T10:00:02Z api pronto\n');
  await expect(page.locator('#dlg-status')).toHaveText('Projeto compose · 1 de 2 rodando · todos os serviços');
  await expect(page.locator('#lmeta')).toContainText('Últimas 500 linhas de cada container');
  await expect(page.locator('#insp')).toBeHidden();  // o inspect é de um container só
  expect(gui.read().compose_calls).toEqual([[...PREFIX, 'logs', '--no-color', '--timestamps', '--tail', '500']]);

  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'Logs do projeto shop' })).toBeFocused();

  // cada serviço com a sua cor no prefixo, como no docker compose logs
  await page.getByRole('button', { name: 'Logs do projeto shop' }).click();
  const prefixes = page.locator('#lb > span > span');
  await expect(prefixes.first()).toHaveClass(/text-svc-\d/);
  expect(await prefixes.nth(0).getAttribute('class')).not.toBe(await prefixes.nth(1).getAttribute('class'));  // db e api
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Logs db' }).click();
  await expect(page.locator('#insp')).toBeVisible();
  await expect(page.locator('#lb')).toHaveText('2026-10-05T10:00:01Z db pronto\n');
});

test('Logs do projeto também têm filtro e Carregar mais (o --tail vale por container)', async ({ page, gui }) => {
  const cs = containers();
  cs[0].logs = Array.from({ length: 600 }, (_, i) => `api ${i}\n`).join('');
  cs[1].logs = 'db 0\ndb 1\ndb 2\n';
  await gui.open({ containers: cs });
  await page.getByRole('button', { name: 'Logs do projeto shop' }).click();
  const lb = page.locator('#lb'), more = page.locator('#more');
  await expect(lb).toContainText('db-1  | db 2');
  await expect(lb).not.toContainText('api-1  | api 99\n');  // 500 do api: do 100 ao 599
  await expect(more).toHaveText('Carregar 2.000 linhas');

  await more.click();
  await expect(lb).toContainText('api-1  | api 0\n');
  await expect(page.locator('#lmeta')).toContainText('Últimas 2.000 linhas de cada container');
  await expect(more).toHaveText('Tudo carregado');  // 603 linhas no total, menos que o pedido
  expect(gui.read().compose_calls).toEqual([[...PREFIX, 'logs', '--no-color', '--timestamps', '--tail', '500'],
                                            [...PREFIX, 'logs', '--no-color', '--timestamps', '--tail', '2000']]);

  await page.locator('#lf').fill('DB-1');
  await expect(page.locator('#lcount')).toHaveText('3 ocorrências em 3 linhas');
  await expect(lb).toHaveText('db-1  | db 0\ndb-1  | db 1\ndb-1  | db 2\n');
});

test('Logs do projeto ao vivo trazem as linhas novas e param quando tudo para', async ({ page, gui }) => {
  const cs = containers();
  cs[1].logs = 'db 1\n';
  await gui.open({ containers: cs });
  await page.getByRole('button', { name: 'Logs do projeto shop' }).click();
  await page.locator('#follow').click();
  await expect(page.locator('#lmeta')).toHaveText('Ao vivo · últimas 500 linhas de cada container e as novas');
  await expect(page.locator('#lb')).toHaveText('db-1  | db 1\n');
  gui.update(s => { s.containers[1].logs = 'db 1\ndb 2\n'; });
  await expect(page.locator('#lb')).toHaveText('db-1  | db 1\ndb-1  | db 2\n');
  expect(gui.read().compose_calls).toContainEqual([...PREFIX, 'logs', '--no-color', '--timestamps', '--tail', '500', '--follow']);

  gui.update(s => { Object.assign(s.containers[1], { State: 'exited', Status: 'Exited (0) 1 second ago' }); });
  await expect(page.locator('#follow')).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('#lmeta')).toContainText('os containers pararam');
});

test('a faixa de estado do projeto tem um bloco por container, na cor do estado', async ({ page, gui }) => {
  await gui.open({ containers: containers() });
  const blocks = page.locator('#rows [data-key="g:shop"] [data-strip] > span');
  await expect(blocks).toHaveCount(2);  // api e db; o solto não é do projeto
  await expect(blocks.first()).toHaveAttribute('title', /^api: /);
});

test('logs do projeto depois de um log ao vivo: nada do anterior vaza e a caixa não fica em Carregando…', async ({ page, gui }) => {
  const cs = containers();
  cs[1].logs = 'db 1\n';
  await gui.open({ containers: cs });
  await page.getByRole('button', { name: 'Logs db' }).click();
  await page.locator('#follow').click();  // fica lembrado: os logs do projeto abrem ao vivo
  await expect(page.locator('#lmeta')).toHaveText('Ao vivo · últimas 500 linhas e as novas');
  await page.getByRole('button', { name: 'Fechar logs' }).click();
  await page.getByRole('button', { name: 'Logs do projeto shop' }).click();
  await expect(page.locator('#lb')).toHaveText('db-1  | db 1\n');
  await expect(page.locator('#lmeta')).not.toContainText('parado');
});

test('cada serviço guarda a sua cor nos logs do projeto, de uma abertura para a outra', async ({ page, gui }) => {
  const cs = containers();
  cs[0].logs = 'api 1\n'; cs[1].logs = 'db 1\n';
  await gui.open({ containers: cs });
  const tone = async (svc: string) => (await page.locator('#lb span[class^="text-svc"]').filter({ hasText: svc }).first().getAttribute('class'))!;
  await page.getByRole('button', { name: 'Logs do projeto shop' }).click();
  await expect(page.locator('#lb')).toContainText('db 1');
  const db = await tone('db-1'), api = await tone('api-1');
  expect(db).not.toBe(api);
  await page.getByRole('button', { name: 'Fechar logs' }).click();
  gui.update(s => { s.containers[1].logs = 'db 1\ndb 2\n'; });
  await page.getByRole('button', { name: 'Logs do projeto shop' }).click();
  await expect(page.locator('#lb')).toContainText('db 2');
  expect(await tone('db-1')).toBe(db);
  expect(await tone('api-1')).toBe(api);
});
