import { defineConfig, devices } from '@playwright/test';

// Testes de UI: cada teste sobe o próprio docker_gui.py contra um docker falso (tests/e2e/fake-docker).
export default defineConfig({
  testDir: 'tests/e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,  // teste instável se conserta, não se repete
  expect: { timeout: 7_000 },  // a página consulta o docker a cada 2 s
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    ...devices['Desktop Chrome'],
    locale: 'pt-BR',
    trace: 'retain-on-failure',
    // opcional: usar um Chromium já instalado em vez do baixado pelo `npx playwright install`
    launchOptions: process.env.PW_CHROMIUM_PATH ? { executablePath: process.env.PW_CHROMIUM_PATH } : {},
  },
});
