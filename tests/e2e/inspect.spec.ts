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
    'unless-stopped',
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

test('container sem mounts, redes nem env', async ({ page, gui }) => {
  await gui.open({ containers: [ctr('web')] });
  await page.getByRole('button', { name: 'Logs web' }).click();
  await page.locator('#insp summary').click();
  await expect(page.locator('#insp-body dd')).toHaveText(['no', 'nenhuma', 'nenhum', 'nenhuma']);
  await expect(page.getByRole('button', { name: 'Revelar valores' })).toHaveCount(0);
});
