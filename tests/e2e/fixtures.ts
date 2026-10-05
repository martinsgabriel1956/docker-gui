import { test as base, expect, type Page } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const FAKE_BIN = path.join(HERE, 'fake-docker');

type Action = 'start' | 'stop' | 'restart' | 'pause' | 'unpause' | 'remove';

// linha do `docker stats`; sem NetIO e BlockIO, a página não mostra rede e disco
export type Stats = { CPUPerc: string; MemUsage: string; MemPerc: string; NetIO?: string; BlockIO?: string };

// campos do `docker ps` que a página lê, mais os extras que o docker falso entende (ver fake-docker/docker)
export type Container = {
  ID: string; Names: string; Image: string; State: string; Status: string; Ports: string; Labels: string;
  logs?: string;
  health?: { Status: string; Log: { ExitCode: number; Output: string }[] } | null;
  inspect?: Record<string, unknown>;
  fail?: Partial<Record<Action, string>>;
  delay?: Partial<Record<Action, number>>;
  after?: Partial<Record<Action, { State: string; Status: string }>>;
  stats?: Stats | Stats[];  // lista: uma leitura por `docker stats`, a última se repete
};
export type DiskUsage = { Type: string; TotalCount: string; Active: string; Size: string; Reclaimable: string };
export type DockerState = {
  containers: Container[]; ps_error?: string; df?: DiskUsage[]; pruned?: string[];
  compose_fail?: string; compose_calls?: string[][];
};

// ID estável por nome: o mesmo container tem o mesmo ID em todo teste
export const id = (name: string) => createHash('sha256').update(name).digest('hex').slice(0, 12);

export const ctr = (Names: string, rest: Partial<Container> = {}): Container => ({
  ID: id(Names), Names, Image: `${Names}:latest`, State: 'running', Status: 'Up 5 minutes', Ports: '', Labels: '', ...rest,
});

export const compose = (project: string, service: string) =>
  `com.docker.compose.project=${project},com.docker.compose.service=${service}`;

export const row = (page: Page, name: string) => page.locator(`#rows tr[data-key="c:${id(name)}"]`);

// ordem das linhas na tabela: "h:attn" (faixa de atenção), "g:<projeto>" (cabeçalho) e "c:<ID>" (container)
export const rowKeys = (page: Page) =>
  page.locator('#rows > tr').evaluateAll(trs => trs.map(tr => (tr as HTMLElement).dataset.key));

export class Gui {
  url = '';
  private proc?: ChildProcess;
  private readonly file: string;

  constructor(private readonly page: Page, dir: string) {
    mkdirSync(dir, { recursive: true });
    this.file = path.join(dir, 'docker-state.json');
  }

  read(): DockerState {
    return JSON.parse(readFileSync(this.file, 'utf8'));
  }

  // escrita atômica: o docker falso pode estar lendo o arquivo no mesmo instante
  write(state: DockerState) {
    writeFileSync(this.file + '.tmp', JSON.stringify(state));
    renameSync(this.file + '.tmp', this.file);
  }

  // muda o "mundo" por fora da página (um container que cai, o daemon que some...)
  update(fn: (state: DockerState) => void) {
    const state = this.read();
    fn(state);
    this.write(state);
  }

  container(name: string) {
    return this.read().containers.find(c => c.Names === name);
  }

  async start(state: DockerState) {
    this.write(state);
    const proc = spawn('python3', ['-u', 'docker_gui.py', '--port', '0'], {
      cwd: ROOT,
      env: { ...process.env, PATH: FAKE_BIN + path.delimiter + process.env.PATH, FAKE_DOCKER_STATE: this.file, BROWSER: 'true' },
    });
    this.proc = proc;
    this.url = await new Promise<string>((resolve, reject) => {
      let out = '';
      const timer = setTimeout(() => reject(new Error(`servidor não subiu: ${out}`)), 10_000);
      const onData = (d: Buffer) => {
        out += d;
        const m = out.match(/Docker GUI em (http:\S+)/);
        if (m) { clearTimeout(timer); resolve(m[1]); }
      };
      proc.stdout!.on('data', onData);
      proc.stderr!.on('data', onData);
      proc.on('exit', code => reject(new Error(`servidor saiu com ${code}: ${out}`)));
    });
  }

  // sobe o servidor e abre a página; sem token = link sem o #t=..., como uma aba aberta à mão
  async open(state: DockerState, { token = true } = {}) {
    await this.start(state);
    await this.page.goto(token ? this.url : this.url.split('#')[0]);
    // a primeira consulta ao docker é assíncrona: sem esperar, um teste que lê o DOM direto (evaluateAll)
    // pode pegar a tabela ainda vazia. "Carregando…" só aparece antes da primeira resposta.
    await expect(this.page.locator('#rows')).not.toHaveText('Carregando…');
  }

  async stop() {
    const proc = this.proc;
    this.proc = undefined;
    if (!proc || proc.exitCode !== null) return;
    const exited = new Promise(resolve => proc.on('exit', resolve));
    proc.kill();
    await exited;
  }
}

export const test = base.extend<{ gui: Gui }>({
  gui: async ({ page }, use, testInfo) => {
    const gui = new Gui(page, testInfo.outputPath());
    await use(gui);
    await gui.stop();
  },
});

export { expect };
