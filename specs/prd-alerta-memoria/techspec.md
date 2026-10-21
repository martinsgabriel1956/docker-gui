# Techspec: Alerta de memória perto do limite

## Resumo executivo

O alerta é decidido inteiro no front, como o resto da faixa de atenção: o `docker stats` que a página já lê a cada 5 s traz o uso e o limite de cada container (`MemUsage` "uso / limite" e `MemPerc`). Sem limite, o docker reporta como limite a RAM total do daemon. Por isso a página precisa de um número só a mais: a RAM total, lida uma vez por uma rota nova (`/api/info`) nos dois backends. Um container tem limite quando o limite do stats fica abaixo de 95% da RAM total.

A histerese (2 leituras ≥ 90% para entrar, < 85% para sair) é uma função pura no `format.ts`, alimentada a cada leitura do stats. A faixa, o favicon, a bandeja e as notificações passam a olhar uma "causa" por container (`fall` para o que existe hoje, `mem` para memória). A chave usada pelas notificações inclui a causa só quando ela é `mem`, e é isso que faz a queda de um container que estava na faixa por memória notificar de novo (RF3.3), sem mexer no resto das regras.

## Arquitetura

### Visão de componentes

- **`docker_gui.py` e `src-tauri/core/src/router.rs`**: rota nova `GET /api/info`, que devolve `{"MemTotal": <bytes>}`. Docker: `info --format {{json .MemTotal}}`; Podman: `info --format {{json .Host.MemTotal}}`. Normalização em `normalize.rs` e numa função equivalente no Python.
- **`src/format.ts`**:
  - `memLimit(s: Stats): {used, limit}` a partir do `MemUsage` (o `bytes()` que já existe lê as duas metades);
  - `memWatch(prev, stats, memTotal)`: a histerese, que devolve o estado novo por container;
  - `causes(c, hot)`: as causas do container (hoje só `tone()`; passa a somar `mem`);
  - `alertKey(c, hot)`: a chave das notificações (`ID` ou `ID:mem`).
- **`src/app.ts`**:
  - `loadStats()` passa a atualizar o estado `hot` pelo `memWatch` e a disparar o mesmo `notify()` da lista.
  - O `statsLoop` deixa de parar com a aba escondida quando a página está vigiando (`notifying()`), como o poll da lista já faz.
  - `inBand`, `renderCount()`, a ordenação da faixa e o subtítulo (`bandHead`) passam a considerar `mem`.
  - O status ganha a linha "Memória em 93% do limite (476 MiB de 512 MiB)", com um botão para os Processos do container.

**Fluxo:** o stats chega e o `memWatch(prev, stats, memTotal)` devolve o novo `hot: Map<id, {n, on}>`. Depois vêm o render da faixa e o cálculo das chaves `alertKey` dos containers na faixa. As chaves que não estavam no conjunto anterior vão para o `notify()`, que já agrupa e já respeita a janela em primeiro plano.

## Design de implementação

### Interfaces principais

```ts
// format.ts
export type MemState = Map<string, {n: number; on: boolean}>;      // n = leituras seguidas ≥ 90%
export const memLimit = (s: Stats): {used: number; limit: number} => …;
export function memWatch(prev: MemState, stats: Record<string, Stats>, memTotal: number | null): MemState;
export const memHot = (st: MemState, id: string): boolean => …;     // on
export type Cause = 'fall' | 'mem';                                  // 'fall' = tudo o que isProblem() cobre hoje
export function causes(c: Container, hot: (id: string) => boolean): Cause[];
export const alertKey = (c: Container, cs: Cause[]): string => cs.includes('fall') ? c.ID : `${c.ID}:mem`;
```

Regras do `memWatch`:
- `memTotal == null` (a rota ainda não respondeu ou falhou): nenhum container fica quente.
- Container sem limite (`limit >= 0.95 * memTotal`): sai do mapa.
- `pct >= 90`: `n + 1`, e `on` passa a valer quando `n >= 2`.
- `pct < 85`: sai do mapa.
- Entre 85% e 90%: mantém o `on` e zera o `n` (a entrada exige 2 leituras *seguidas*).
- Container que sumiu do stats (parou): sai do mapa.

### Modelos de dado

- `GET /api/info` → `200 {"MemTotal": 16654159872}`; erro do CLI → `500` com o stderr (como as outras leituras).
- `MemState` vive só na página, como o `series` dos sparklines.

### Endpoints de API

| Método | Path | Descrição |
|---|---|---|
| GET | `/api/info` | RAM total do daemon em bytes. Lida pelo front uma vez, e de novo a cada leitura do stats enquanto não tiver dado certo. |

## Pontos de integração

- `docker info` pode demorar no daemon remoto: usa o `READ_TIMEOUT` (15 s), fora do caminho crítico (o alerta só começa quando o número chega).
- Podman: `podman info` tem a RAM em `.Host.MemTotal`. O podman-docker (o `docker` que chama o Podman) responde ao `.MemTotal`? Isso fica para conferir na task. Se não responder, a rota tenta `.Host.MemTotal` quando o `.MemTotal` vier vazio.

## Estratégia de teste

- **Contrato** (`tests/contract/reads/`): `info-docker.json`, `info-podman.json` e `info-erro.json`, rodando nos dois backends.
- **Unitário** (`tests/format.test.js`):
  - `memLimit`, com unidades binárias e decimais;
  - `memWatch`: entra na 2ª leitura e não na 1ª; um pico isolado não entra; fica entre 85% e 90%; sai abaixo de 85%; sem limite nunca entra; `memTotal` nulo;
  - `alertKey`: `mem` → `fall` muda a chave, `fall` → `fall+mem` não muda.
- **E2E** (`tests/e2e/problems.spec.ts` e `notifications.spec.ts`, docker falso):
  - o docker falso ganha `info` e um campo de memória por container no `stats`;
  - container com 95% do limite em duas leituras entra na faixa com o texto;
  - container sem limite e com 95% da RAM não entra;
  - notificação ao entrar, e de novo quando o mesmo container passa a `Exited (137)`.
  - Os testes rodam nos dois backends (`GUI_BACKEND=python|rust`).

## Sequenciamento

1. A rota `/api/info` nos dois backends, com os casos de contrato (o vermelho primeiro).
2. `memLimit`, `memWatch`, `causes` e `alertKey` no `format.ts`, com os testes unitários.
3. `app.ts`: estado `hot`, `statsLoop` em segundo plano, faixa, contagens, status e notificação.
4. E2E e o docker falso.
5. Medir de novo a memória do desktop com a janela fechada (`scripts/memory.sh --idle`), agora com o stats rodando em segundo plano.

## Observabilidade

Nada novo. A rota segue a regra de log do projeto (sem argumentos nem dados de container).

## Considerações técnicas

### Decisões principais

- **Limite detectado pelo stats contra a RAM total, não pelo `HostConfig.Memory`.** O stats já é lido, então o limite chega ao vivo, inclusive depois de um `docker update --memory`. Rejeitado: um `inspect` por container novo, que acrescenta consultas e não vê o `update`.
- **Margem de 95% da RAM total.** O stats arredonda o limite ("7.6GiB" para 7,63 GiB), então comparar com igualdade marcaria um container sem limite como "com limite". Um limite acima de 95% da RAM é tratado como sem limite, o que coincide com a intenção do PRD (o OOM aí é do sistema).
- **Lógica no front.** Segue a decisão do techspec do desktop: as regras da faixa e das notificações existem uma vez só, no front compartilhado. O backend só fornece o dado.
- **A causa entra na chave da notificação só quando é `mem`.** A regra "quem continua na faixa não repete" fica intacta para tudo o que existe hoje, e a única passagem que gera nova notificação é `mem` → queda (RF3.3).
- **Stats em segundo plano só quando a página vigia** (`notifying()`, sempre verdadeiro no desktop), igual ao poll da lista.

### Riscos conhecidos

- **Memória e CPU do desktop em segundo plano:** o `docker stats --no-stream` roda a cada ~5 s com a janela fechada (é um processo curto, mas leva ~2 s medindo). A meta de 150 MB precisa ser medida de novo (etapa 5). Se estourar, a saída é espaçar o stats em segundo plano para 10 s, o que leva a entrada na faixa para uns 25 s; isso exigiria mudar a meta de 15 s do PRD.
- **Podman sem `--no-stream` estável em versões antigas:** já é tratado hoje pelo stats; nada novo.
- **cgroup v1 sem limite** pode reportar um limite enorme (maior que a RAM). A regra `limit >= 0.95 * memTotal` cobre o caso.

### Conformidade com regras do projeto

- Rota nova nos dois backends com fixtures de contrato e E2E nos dois (techspec do desktop, "Estratégia de teste").
- Sem dependência nova. O `docker_gui.py` segue só com a biblioteca padrão.
- Texto em pt e en pela tabela do `i18n` (`en.json` e a tabela EN do Python/Rust).

### Conformidade com skills disponíveis

- `tdd`: os casos de contrato e o `memWatch` antes da implementação.
- `feature-prints`: print da faixa com o alerta para o PR.
- `sdd-review` no fechamento.

### Arquivos relevantes

- `src/format.ts`: `tone`, `bucket`, `isProblem` e `newProblems` (linhas 48 a 63), `usage` (154) e `bytes` (159).
- `src/app.ts`:
  - `load()`/`notify` (149 a 216) e `statsLoop`/`loadStats` (228 a 251);
  - `inBand` (463), `renderCount` (283) e `render` (654);
  - `bandHead` (575) e o status da linha (527).
- `docker_gui.py`: `LISTS` e a rota de stats (86, 637). Rota nova.
- `src-tauri/core/src/router.rs` e `normalize.rs`: rota nova.
- `tests/contract/reads/`, `tests/format.test.js`, `tests/e2e/problems.spec.ts`, `tests/e2e/notifications.spec.ts` e `tests/e2e/fake-docker/docker`.

## Histórico

**2026-10-21**. Documento criado.

**2026-10-21**. Nota vinda da [dependência do compose](../prd-dependencia-compose/techspec.md), já implementada:
- A entrada na faixa no `app.ts` passou a ser `attention(c)` (`isProblem` ou "Created" segurado), e o `newProblems` recebe esse critério.
- O filtro e as contagens usam o `bucketOf`.
- As causas deste techspec (`causes`, `alertKey`) precisam partir desse critério, não só do `isProblem`, e o `bucketOf` precisa contar o `mem`.

**2026-10-21**. Durante o sdd-tasks:
- A rota lê `info --format {{json .}}` e pega `MemTotal` (Docker) ou `host.memTotal` (Podman). Um `--format` por CLI falharia no podman-docker, que o nome do binário não denuncia.
- `causes`/`alertKey` viram o critério que já existe depois da dependência do compose: `attention` (grave ou memória), a chave `ID` ou `ID:mem`, e o `newProblems` com o parâmetro da chave.
- A primeira leitura do stats com a RAM total é a base. Quem já está em 90% ou mais fica quente na hora e não notifica.
- Entram também a T6 (README, inclusive das duas features anteriores, que ficaram sem ele) e a medição do desktop (T5).
