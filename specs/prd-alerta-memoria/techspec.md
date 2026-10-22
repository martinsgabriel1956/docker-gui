# Techspec: Alerta de memória perto do limite

## Resumo executivo

O alerta é decidido inteiro no front, como o resto da faixa de atenção: o `docker stats` que a página já lê a cada 5 s traz o uso e o limite de cada container (`MemUsage` "uso / limite" e `MemPerc`). Sem limite, o docker reporta como limite a RAM total do daemon. Por isso a página precisa de um número só a mais: a RAM total, lida uma vez por uma rota nova (`/api/info`) nos dois backends. Um container tem limite quando o limite do stats fica abaixo de 95% da RAM total.

A histerese (2 leituras ≥ 90% para entrar, < 85% para sair) é uma função pura no `format.ts`, alimentada a cada leitura do stats. A faixa, o favicon, a bandeja e as notificações passam a olhar duas classes de container: `severe` (o que quebrou, ou o "Created" que uma dependência segura) e só memória. A chave usada pelas notificações é o ID para `severe` e `ID:mem` para só memória, e é isso que faz a queda de um container que estava na faixa por memória notificar de novo (RF3.3), sem mexer no resto das regras.

## Arquitetura

### Visão de componentes

- **`docker_gui.py` e `src-tauri/core/src/router.rs`**: rota nova `GET /api/info`, que devolve `{"MemTotal": <bytes>}`. Lê `info --format {{json .}}` e pega `MemTotal` (Docker) ou `host.memTotal` (Podman e podman-docker), em `mem_total()` no Python e no `normalize.rs`.
- **`src/format.ts`**:
  - `memLimit(s)` e `memPct(s)`: uso, limite e porcentagem a partir do `MemUsage` e do `MemPerc` (o `bytes()` e o `percent()` que já existem);
  - `memWatch(prev, stats, memTotal, first)`: a histerese, que devolve o estado novo por container;
  - `memHot` e `memText` ("Memória em 93% do limite (476 MiB de 512 MiB)");
  - o `newProblems` ganha o parâmetro da chave (`key`), além do critério de entrada.
- **`src/app.ts`**:
  - `loadMemTotal()` lê a RAM total uma vez (e de novo a cada leitura do stats enquanto falhar).
  - `loadStats()` atualiza o `memSt` pelo `memWatch`. A primeira leitura com a RAM total é a base: quem já está no alto fica quente e vai para o `seen` sem notificar. Depois, `loadStats()` chama o `checkAttention()`, o mesmo do `load()`.
  - O `statsLoop` segue o `watching()`, como o poll da lista: com a aba escondida, só com as notificações ligadas (no desktop, sempre).
  - `memOn`, `severe`, `attention`, `inBand`, `alertKey`, `bucketOf` e `attnSort` (raiz de dependência, depois os graves, depois só memória) decidem a faixa, o filtro, as contagens e a ordem.
  - `toneOf` põe no tom de aviso a bolinha, o status e o bloco do projeto de quem está rodando bem mas quente.
  - `memHtml` mostra a linha da memória na linha (com o botão Processos, `openProcs`) e no modal (sem o botão). O corpo da notificação de quem só está quente é essa linha.
  - O subtítulo da faixa (`bandHead`) inclui "memória perto do limite".

**Fluxo:** o stats chega e o `memWatch(prev, stats, memTotal, first)` devolve o novo `memSt: Map<id, {n, on}>`. Depois o `checkAttention()` calcula as chaves `alertKey` dos containers em `attention`, e as que não estavam no `seen` vão para o `notify()`, que já agrupa e já respeita a janela em primeiro plano. O render da faixa vem em seguida.

## Design de implementação

### Interfaces principais

```ts
// format.ts
export type MemState = Map<string, {n: number; on: boolean}>;      // n = leituras seguidas ≥ 90%
export function memLimit(s: Stats): {used: number; limit: number} | null;   // null se o MemUsage não for "uso / limite"
export const memPct = (s: Stats): number | null => …;               // o MemPerc, ou a conta
export function memWatch(prev: MemState, stats: Record<string, Stats>, memTotal: number | null, first?: boolean): MemState;
export const memHot = (st: MemState, id: string): boolean => …;     // on
export const memText = (s: Stats): string => …;
export const newProblems = (before, cs, is = isProblem, key = (c: Container) => c.ID): Container[] => …;
// app.ts
const severe = (c: Container) => isProblem(c) || held(c, data);
const alertKey = (c: Container) => severe(c) ? c.ID : `${c.ID}:mem`;
```

Regras do `memWatch`:
- `memTotal == null` (a rota ainda não respondeu ou falhou): nenhum container fica quente.
- Container sem limite (`limit >= 0.95 * memTotal`): sai do mapa.
- `pct >= 90`: `n + 1`, e `on` passa a valer quando `n >= 2`, ou já na primeira leitura da página (`first`, a base).
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
- Podman: no JSON do `podman info` (e do podman-docker), a RAM fica em `host.memTotal`. A rota procura `MemTotal` e depois `host.memTotal`, sem depender do nome do binário.

## Estratégia de teste

- **Contrato** (`tests/contract/lists/`): `info-docker.json`, `info-podman.json`, `info-erro.json` e `info-formato.json`, rodando nos dois backends.
- **Unitário** (`tests/format.test.js`):
  - `memLimit` e `memPct` (com e sem o `MemPerc`);
  - `memWatch`: entra na 2ª leitura e não na 1ª; pico, queda e pico não entram; fica entre 85% e 90%; sai abaixo de 85%; sem limite nunca entra; `memTotal` nulo; a base (`first`); quem parou sai;
  - `memText`;
  - `newProblems` pela chave (`ID:mem` → `ID` conta como entrada).
- **E2E** (`tests/e2e/stats.spec.ts` e `notifications.spec.ts`), com o `info` e o `mem_total` no docker falso e o `stats` em lista de leituras:
  - entrada na 2ª leitura alta, com o texto, o filtro, o tom de aviso e o atalho para os Processos;
  - saída abaixo de 85%;
  - sem limite nunca entra;
  - quem já estava no alto ao abrir entra na 1ª leitura;
  - notificação ao entrar, e de novo quando o mesmo container passa a `Exited (137)`.
  - Os testes rodam nos dois backends (`GUI_BACKEND=python|rust`).

## Sequenciamento

1. A rota `/api/info` nos dois backends, com os casos de contrato (o vermelho primeiro).
2. `memLimit`, `memPct`, `memWatch` e `memText` no `format.ts`, e a chave no `newProblems`, com os testes unitários.
3. `app.ts`: `memSt`, `statsLoop` em segundo plano, faixa, contagens, tom, status e notificação.
4. E2E e o docker falso.
5. Medir de novo a memória do desktop com a janela fechada (`scripts/memory.sh --idle`), agora com o stats rodando em segundo plano.

## Observabilidade

Nada novo. A rota segue a regra de log do projeto (sem argumentos nem dados de container).

## Considerações técnicas

### Decisões principais

- **Limite detectado pelo stats contra a RAM total, não pelo `HostConfig.Memory`.** O stats já é lido, então o limite chega ao vivo, inclusive depois de um `docker update --memory`. Rejeitado: um `inspect` por container novo, que acrescenta consultas e não vê o `update`.
- **Margem de 95% da RAM total.** O stats arredonda o limite ("7.6GiB" para 7,63 GiB), então comparar com igualdade marcaria um container sem limite como "com limite". Um limite acima de 95% da RAM é tratado como sem limite, o que coincide com a intenção do PRD (o OOM aí é do sistema).
- **Lógica no front.** Segue a decisão do techspec do desktop: as regras da faixa e das notificações existem uma vez só, no front compartilhado. O backend só fornece o dado.
- **A causa entra na chave da notificação só quando é só memória (`ID:mem`).** A regra "quem continua na faixa não repete" fica intacta para tudo o que existe hoje, e a única passagem que gera nova notificação é `mem` → queda (RF3.3).
- **Stats em segundo plano só quando a página vigia** (`notifying()`, sempre verdadeiro no desktop), igual ao poll da lista.

### Riscos conhecidos

- **Memória e CPU do desktop em segundo plano** (medido na T5): com o `docker stats --no-stream` a cada ~5 s e a janela fechada, o `scripts/memory.sh --idle` (binário de release, 6 containers com stats, um perto do limite, 2 min na bandeja) deu **138,2 MB** de PSS, dentro do teto de 150 MB. A medição anterior, sem o stats em segundo plano, deu 140,8 MB: o stats não pesa na memória do app, porque é um processo curto do docker, que o script deixa fora da conta. O `--idle` passa a dar stats aos containers; num computador com um Stivo aberto, roda dentro de um `dbus-run-session` (senão o single-instance repassa para o Stivo aberto e a janela de teste não abre).
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

- `src/format.ts`: `newProblems`, e `memLimit` a `memText`, depois do `fmtBytes`.
- `src/app.ts`:
  - `loadMemTotal`/`loadStats`/`statsLoop` e o `notify`;
  - `memOn`, `severe`, `attention`, `inBand`, `alertKey`, `bucketOf`, `attnSort`, `toneOf`, `memLine` e `checkAttention`, junto do `quiet`;
  - `memHtml`/`openProcs` (antes do `rowHtml`), o `rowHtml`, o `renderDlg`, o `groupHead` (bloco do projeto) e o `bandHead`.
- `docker_gui.py`: `mem_total()` e a rota no `do_GET`, antes da de stats.
- `src-tauri/core/src/router.rs` (`get`) e `normalize.rs` (`mem_total`).
- `scripts/memory.sh` (o `--idle` com stats).
- `README.md`.
- `tests/contract/lists/info-*.json`, `tests/format.test.js`, `tests/e2e/stats.spec.ts`, `tests/e2e/notifications.spec.ts`, `tests/e2e/fixtures.ts` e `tests/e2e/fake-docker/docker`.

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

**2026-10-21**. T5: medida a memória do desktop com o stats em segundo plano (138,2 MB de PSS, dentro do teto). O `memory.sh --idle` ganhou stats nos containers do docker falso, para medir o custo novo.

**2026-10-21**. Reconciliação do sdd-review. O documento passa a descrever o que foi construído:
- a rota com o `info` em JSON;
- a classe `severe` e a chave `ID:mem` no `app.ts`, não `causes`/`alertKey` no `format.ts`;
- o `memPct`, a base (`first`) e o `checkAttention` chamado também pelo stats;
- os testes em `lists/` e no `stats.spec.ts`.

Desvio da execução: o `toneOf`. No print da tela, quem estava quente ficava com a bolinha e o status verdes; agora fica no tom de aviso, como o RF2.2 pede.
