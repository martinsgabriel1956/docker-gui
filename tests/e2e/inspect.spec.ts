import { test, expect, ctr } from './fixtures';

const db = ctr('db', {
  inspect: {
    HostConfig: { RestartPolicy: { Name: 'unless-stopped', MaximumRetryCount: 0 } },
    NetworkSettings: { Networks: { app_default: { IPAddress: '172.18.0.2' } } },
    Mounts: [{ Type: 'volume', Name: 'pgdata', Source: '/var/lib/docker/volumes/pgdata/_data', Destination: '/var/lib/postgresql/data', RW: true },
             { Type: 'bind', Source: '/home/eu/init.sql', Destination: '/docker-entrypoint-initdb.d/init.sql', RW: false }],
    Config: { Env: ['POSTGRES_PASSWORD=s3cr3t', 'PGDATA=/var/lib/postgresql/data'] },
  },
});

test('Configuração mostra o inspect resumido com o env mascarado', async ({ page, gui }) => {
  await gui.open({ containers: [db] });
  await page.getByRole('button', { name: 'Logs db' }).click();
  await page.locator('#insp summary').click();
  const body = page.locator('#insp-body');
  await expect(body.locator('dd')).toHaveText([
    'unless-stopped · sempre, menos se você parar',
    'app_default · 172.18.0.2',
    'volume pgdata → /var/lib/postgresql/databind /home/eu/init.sql → /docker-entrypoint-initdb.d/init.sql (somente leitura)',
    /^POSTGRES_PASSWORD=••••••\(oculto\)PGDATA=••••••\(oculto\)Revelar valores$/,
  ]);
  await expect(body).not.toContainText('s3cr3t');

  await page.getByRole('button', { name: 'Revelar valores' }).click();
  await expect(body).toContainText('POSTGRES_PASSWORD=s3cr3t');
  await expect(page.getByRole('button', { name: 'Ocultar valores' })).toBeFocused();
  await page.getByRole('button', { name: 'Ocultar valores' }).click();
  await expect(body).not.toContainText('s3cr3t');
  await page.getByRole('button', { name: 'Revelar valores' }).click();
  await expect(body).toContainText('POSTGRES_PASSWORD=s3cr3t');

  // fechar o modal apaga o que foi revelado; reabrir volta mascarado
  await page.keyboard.press('Escape');
  await expect(page.locator('#dlg')).toBeHidden();
  await expect(page.locator('#insp')).not.toHaveAttribute('open');
  await expect(body).not.toContainText('s3cr3t');
  await page.getByRole('button', { name: 'Logs db' }).click();
  await page.locator('#insp summary').click();
  await expect(body).toContainText('POSTGRES_PASSWORD=••••••');
});

test('Histórico mostra quando o container subiu, caiu e mudou de saúde', async ({ page, gui }) => {
  const at = (h: number, m: number) => new Date(2026, 9, 6, h, m).getTime() / 1000;  // hoje no fuso local, como o docker manda
  await page.clock.setFixedTime(new Date(2026, 9, 6, 18, 0));
  await gui.open({ containers: [ctr('api', { events: [
    { Type: 'container', Action: 'start', time: at(14, 0) },
    { Type: 'container', Action: 'die', Actor: { Attributes: { exitCode: '137' } }, time: at(14, 2) },
    { Type: 'container', Action: 'exec_start: sh -c curl', time: at(14, 2) },  // healthcheck: fica de fora
    { Type: 'container', Action: 'start', time: at(14, 3) },
    { Type: 'container', Action: 'health_status: unhealthy', time: at(14, 5) },
  ] })] });
  await page.getByRole('button', { name: 'Logs api' }).click();
  await page.locator('#hist summary').click();
  const body = page.locator('#hist-body');
  await expect(body.locator('p')).toHaveText('Desde 14:00:00: subiu 2× · caiu 1×');
  // do mais novo para o mais velho
  await expect(body.locator('li')).toHaveText([
    '14:05:00 healthcheck começou a falhar', '14:03:00 subiu',
    '14:02:00 saiu com código 137 · morto à força ou sem memória (OOM)', '14:00:00 subiu']);
  // fechar o modal fecha o histórico
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Logs api' }).click();
  await expect(page.locator('#hist')).not.toHaveAttribute('open');
});

test('Histórico vazio diz por quê', async ({ page, gui }) => {
  await gui.open({ containers: [ctr('web')] });
  await page.getByRole('button', { name: 'Logs web' }).click();
  await page.locator('#hist summary').click();
  await expect(page.locator('#hist-body')).toHaveText('Nada nas últimas 24 h. O docker guarda só os eventos mais recentes.');
});

test('Processos mostra o docker top, só com o container de pé', async ({ page, gui }) => {
  await gui.open({ containers: [ctr('db', { top: 'UID  PID   CMD\n70   104   postgres\n70   105   postgres: checkpointer' }),
                               ctr('cron', { State: 'exited', Status: 'Exited (0) 3 days ago' })] });
  await page.getByRole('button', { name: 'Logs db' }).click();
  await page.locator('#procs summary').click();
  await expect(page.locator('#procs-body tr')).toHaveText(['UIDPIDCMD', '70104postgres', '70105postgres: checkpointer']);
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Logs cron' }).click();
  await expect(page.locator('#procs')).toBeHidden();
  await expect(page.locator('#hist')).toBeVisible();
});

test('container sem mounts, redes nem env', async ({ page, gui }) => {
  await gui.open({ containers: [ctr('web')] });
  await page.getByRole('button', { name: 'Logs web' }).click();
  await page.locator('#insp summary').click();
  await expect(page.locator('#insp-body dd')).toHaveText(['no · não reinicia', 'nenhuma', 'nenhum', 'nenhuma']);
  await expect(page.getByRole('button', { name: 'Revelar valores' })).toHaveCount(0);
});
