# Techspec: Histórico do healthcheck

## Resumo executivo

Mudança só no front. A rota `/api/health/<id>` já devolve o objeto `State.Health` inteiro, com o `Log` das últimas 5 execuções (`Start`, `End`, `ExitCode` e `Output`), nos dois backends. Hoje o `loadHealth` usa só o `Log.at(-1)`. A feature amplia o tipo `Health`, cria funções puras dos probes no `format.ts` e um `healthHtml` no `app.ts` e troca a linha "Último healthcheck:" do modal por essa tabela. Os backends não mudam.

## Arquitetura

### Visão de componentes

- **`src/format.ts`** (só dados, como o `topTable`):
  - `probeResult(p)` devolve `ok`, `fail` ou `error`;
  - `probeTime(s)` lê o RFC 3339 do docker, cortando os nanossegundos (o `app.ts` usa também para o horário);
  - `probeDuration(p)` calcula a duração em ms a partir de `Start` e `End`;
  - `healthSummary(log)` monta o texto "3 de 5 falharam".
- **`healthHtml` no `app.ts`**, ao lado do `copyLogs`: gera o HTML da tabela, com:
  - a saída escapada, limitada a 3 linhas, e um `<details>` "mais N linhas" para expandir;
  - um Copiar por probe (só quando há saída), que chama o `copyProbe`;
  - em cima, "Healthcheck", o resumo e o ↻ (`reloadHealth`). O cabeçalho com o ↻ aparece também no erro e com 0 probes, para dar para tentar de novo.
- **`src/app.ts`**:
  - o tipo `Health` ganha os campos do `Log`;
  - o `loadHealth` passa a guardar o `Log` inteiro, ordenado do mais novo para o mais velho;
  - o `renderDlg` troca a linha `#dlg-status` pela tabela;
  - a linha da lista (`<details>` "Ver último healthcheck") continua mostrando só o último, porque ali o espaço é de uma linha.
- **Atualização (RF2.1 e RF2.2)**:
  - o cache `health[ID+Status]` vence quando o `Status` muda, numa mudança de saúde ou com a passagem do tempo ("Up 5 minutes" → "Up 6 minutes"); por isso não há handler de evento novo;
  - abrir o modal (`openLogs`) apaga a chave do container e relê, porque um `Status` como "Up About an hour" seguraria o cache por uma hora;
  - o ↻ apaga a chave e relê.

## Design de implementação

### Interfaces principais

```ts
export type Probe = {Start: string; End: string; ExitCode: number; Output: string};
export type Health = {Status: string; FailingStreak: number; Log?: Probe[]} | null;
export const probeResult = (p: Probe): 'ok' | 'fail' | 'error' => p.ExitCode === 0 ? 'ok' : p.ExitCode === 1 ? 'fail' : 'error';
export const probeTime = (s: string): number => …;          // Date.parse com a fração cortada em 3 casas
export function probeDuration(p: Probe): number | null;    // null se Start/End faltarem ou não fizerem sentido
export function healthSummary(log: Probe[]): string;        // via t``
// e no app.ts: healthHtml(id: string, v: Probe[] | string): string, copyProbe(id, i) e reloadHealth(id)
```

### Modelos de dado

O formato é o do Docker, já passado sem mudança pelos dois backends. O `Start` e o `End` têm nanossegundos (`2026-10-21T10:00:00.123456789-03:00`); o `Date.parse` não garante mais que milissegundos, então o `probeTime` corta a fração em 3 dígitos antes de converter.

### Endpoints de API

Nenhum novo. Usa `GET /api/health/<id>`.

## Pontos de integração

- **Podman**: o `podman inspect` entrega o histórico em `.State.Health` (Podman 4+), com os mesmos campos. Versões mais antigas usavam `.State.Healthcheck`, e com elas a rota já devolve `null` hoje; nada piora. Isso fica registrado como risco.
- **`ExitCode` diferente de 0 e 1**: o docker usa `-1` quando o probe estoura o timeout ou não consegue rodar, e o `Output` diz o motivo. A tabela mostra esse caso como "não rodou como esperado".

## Estratégia de teste

- **Unitário** (`tests/format.test.js`):
  - o `probeResult` com 0, 1 e -1;
  - o `probeDuration` com nanossegundos, com fuso e com o `End` vazio;
  - o `healthSummary`;
  - a tabela (saída longa, HTML escapado) fica com o E2E, como o `topHtml`.
- **E2E** (`tests/e2e/logs.spec.ts`), com o docker falso devolvendo `c.health`, nos dois backends:
  - 5 probes, com resumo, ordem, horário, duração, "não rodou como esperado", "mais N linhas" e Copiar;
  - o ↻ relê sem o `Status` mudar;
  - abrir o modal relê;
  - 0 probes ("Nenhum probe rodou ainda").
  - As células são conferidas uma a uma; o horário usa o fuso da máquina do teste.
- **Contrato**: o `health.json` ganha `Start` e `End` no `Log`, para documentar que os dois backends passam os campos adiante.

## Sequenciamento

1. Funções no `format.ts`, com os testes.
2. `loadHealth`, `renderDlg` e a tabela.
3. E2E.

## Observabilidade

Nada novo.

## Considerações técnicas

### Decisões principais

- **Sem mudança no backend.** O dado já chega inteiro; recortar o `Log` no servidor só tiraria informação.
- **Tabela no lugar da linha de hoje, no `#dlg-status`, e não uma seção `<details>` nova.** O PRD pede que a lista substitua a linha. Ela fica junto do status, porque é a explicação dele.
- **Dados no `format.ts`, HTML no `app.ts`**, como o `topTable`/`topHtml`: o `format.ts` não gera marcação.
- **Sem handler de evento para o ao vivo**: a chave `ID+Status` do cache já vence com a mudança de saúde. Abrir o modal invalida a chave, para o RF2.1 valer mesmo com um `Status` que demora a mudar.

### Riscos conhecidos

- **Podman antigo** (`.State.Healthcheck`): fora do alcance hoje e continua fora. Se aparecer um pedido, a normalização entra na rota dos dois backends.
- **Saída de probe com ANSI** ou muito longa: escapada e cortada em 3 linhas. O expandir mostra o resto, que o docker já limita a 4 KB por probe.

### Conformidade com regras do projeto

- Saída do container é texto não confiável: o `healthHtml` escapa tudo, como o `topHtml`.
- Cor e texto juntos no resultado (WCAG 2.2 AA, DESIGN.md).
- Textos novos em pt e en.

### Conformidade com skills disponíveis

- `tdd` nas funções do `format.ts`.
- `frontend-design` na tabela (seguindo o DESIGN.md e os `TONE` que já existem).
- `feature-prints` do modal, para o PR.

### Arquivos relevantes

- `src/app.ts`:
  - tipo `Health`, `loadHealth`/`reloadHealth`/`lastProbe` e o `healthBox` da linha;
  - `renderDlg` (`#dlg-health`), `openLogs` (invalida o cache), `copyProbe`/`healthHtml` (ao lado do `copyLogs`) e o export para `window`.
- `src/format.ts`: `Probe`, `probeResult`, `probeTime`, `probeDuration` e `healthSummary`, depois do `topTable`.
- `src/en.json`.
- `tests/format.test.js`, `tests/e2e/logs.spec.ts`, `tests/e2e/fixtures.ts` (tipo do `health`) e `tests/contract/reads/health.json`.

## Histórico

**2026-10-21**. Documento criado.

**2026-10-21**. Durante o sdd-tasks: a tabela sai do `format.ts` e vai para o `app.ts` (`healthHtml`), no padrão `topTable`/`topHtml`; o RF2.2 fica com a chave do cache (`ID+Status`), sem handler de evento, mais um botão ↻ para o RF2.1.

**2026-10-21**. Reconciliação do sdd-review. O `probeTime` virou público (o `app.ts` usa para o horário). O cabeçalho com o ↻ aparece também no erro e sem probes, e o Copiar só aparece quando há saída. Abrir o modal passou a invalidar o cache do container: com a chave `ID+Status` só, um `Status` como "Up About an hour" deixava o RF2.1 sem leitura nova por até uma hora. Arquivos relevantes e estratégia de teste atualizados ao que foi construído.
