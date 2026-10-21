# Techspec: Dependência que segurou o serviço

## Resumo executivo

Mudança só no front. O label `com.docker.compose.depends_on` (`db:service_healthy:false,redis:service_started:false`) já chega na string `Labels` de cada container, nos dois backends e no Podman. Duas funções puras no `format.ts` fazem o trabalho: uma lê as dependências; a outra cruza cada dependência com o container do mesmo serviço no mesmo projeto, ou com a lista de serviços sem container que a página já carrega, e diz quais não cumprem a condição.

O resultado (`blockers`) entra na faixa de três formas: como anotação no status, como critério de entrada (o container "Created" que está segurado passa a contar) e como critério de ordem (quem segura outros vem antes).

## Arquitetura

### Visão de componentes

- **`src/format.ts`**:
  - `dependsOn(c)` faz o parse do label;
  - `depState(dep, project, cs)` devolve por que a dependência não cumpre a condição, ou `null`;
  - `blockers(c, cs)` devolve as dependências que não cumprem a condição;
  - `held(c, cs)` diz se é um "Created" segurado; `holds(c, cs)` devolve os dependentes que o container segura.
- **`src/app.ts`**:
  - `inBand` passa a aceitar `(isProblem(c) && !quiet(c)) || held(c, data)`;
  - a ordenação da faixa (`render`, linha 658) põe primeiro quem segura algum container da faixa, depois o resto por nome;
  - o status da linha ganha "depende de `db`, que está com healthcheck falhando", com o nome como botão para os logs da dependência (`openLogs`);
  - quem segura outros ganha "segurando api, worker";
  - o `notify()` ordena o corpo da notificação agrupada com as raízes primeiro;
  - o filtro, as contagens e o título usam `bucketOf(c)` (o `bucket` do `format.ts`, com o "Created" segurado como `problema`), para seguir a faixa;
  - o `renderDlg` mostra a anotação no modal do dependente, como texto: `depHtml(bl, hd, false)`. Trocar de container com o modal aberto seria fechar e abrir de novo, e o `afterClose` roda depois, assíncrono.
  - A assinatura do cache da linha (`row`) inclui `blockers` e `holds`, que vêm de outros containers.
- **Dependência sem container**: vem da própria lista de containers (nenhum container do serviço no projeto), sem consultar o `compose/services`.

## Design de implementação

### Interfaces principais

```ts
export type Cond = 'service_started' | 'service_healthy' | 'service_completed_successfully';
export type Dep = {service: string; cond: Cond};
export function dependsOn(c: Pick<Container, 'Labels'>): Dep[];
export type DepState = 'unhealthy' | 'exited' | 'stopped' | 'missing';   // por que não cumpre
export function depState(d: Dep, project: string, cs: Container[]): DepState | null;   // null = cumpre
export type Blocker = {service: string; state: DepState; c?: Container};
export function blockers(c: Container, cs: Container[]): Blocker[];
export const held: (c: Container, cs: Container[]) => boolean;
export function holds(c: Container, cs: Container[]): Container[];
```

**Parse:** o valor do label vai até o próximo `,<chave>=`. Por isso a regex captura uma sequência de `nome:cond[:bool]` separados por vírgula (o terceiro campo é opcional, ver riscos): `com\.docker\.compose\.depends_on=((?:[^,=:]+:[^,=:]+(?::(?:true|false))?)(?:,[^,=:]+:[^,=:]+(?::(?:true|false))?)*)`. Uma condição desconhecida vale como `service_started`.

**Condição × estado** (só a dependência direta; com réplicas, basta uma que cumpra):

| cond | cumpre quando |
|---|---|
| `service_started` | `running` (qualquer saúde) |
| `service_healthy` | `running` e não `(unhealthy)`: saudável, sem healthcheck ou ainda verificando (`health: starting` é a espera normal do `up`) |
| `service_completed_successfully` | `exited` com código 0, ou `running` (ainda não terminou: não segura, só espera) |

### Modelos de dado

Nenhum novo no backend. O `blockers` é calculado a cada render a partir de `data`.

### Endpoints de API

Nenhum novo. Usa `GET /api/containers`.

## Pontos de integração

- **Compose v2**: grava o `depends_on` no label. O Compose v1 e o `podman-compose` não gravam, e aí o `dependsOn` devolve `[]`: nada muda (PRD, restrição).
- **Containers do mesmo serviço**: são casados por `project(c)` e `service(c)`, as funções que já existem.

## Estratégia de teste

- **Unitário** (`tests/format.test.js`, que já tem labels com `depends_on` nas linhas 139 a 160):
  - parse com 1 e com 2 dependências e com outras labels depois;
  - cada linha da tabela condição × estado;
  - dependência sem container;
  - cadeia `web → api → db`, em que só a direta aparece;
  - `holds`;
  - container fora do compose.
- **E2E** (`tests/e2e/compose.spec.ts` e `problems.spec.ts`):
  - a fixture `compose()` em `tests/e2e/fixtures.ts` ganha um parâmetro `depends`;
  - `db` unhealthy e `api` em "Created" com `db:service_healthy:false`: a `api` está na faixa com a anotação, o `db` vem antes com "segurando api", e clicar em `db` abre os logs do `db`;
  - `db` passa a healthy: a anotação some.
  - Roda nos dois backends.

## Sequenciamento

1. `dependsOn`, `depState`, `blockers` e `holds`, com os testes.
2. `inBand`, a ordenação, o status e o botão no `app.ts`.
3. (sem passo: a dependência sem container vem da lista de containers)
4. A ordem na notificação agrupada.
5. E2E.

## Observabilidade

Nada novo.

## Considerações técnicas

### Decisões principais

- **Só labels, sem ler o arquivo do compose.** O label é o que o compose de fato usou para subir aquele container; o arquivo pode ter mudado depois. Também não acrescenta consulta (PRD, restrição).
- **"Created" segurado entra na faixa, "Created" sem dependência quebrada não.** Um container criado e nunca iniciado à mão continua sendo "parado"; só entra quando há uma causa para mostrar.
- **Ordem da faixa por raiz e depois por nome**, sem árvore. A anotação já liga um ao outro, e uma árvore mudaria o layout da faixa para um caso raro.

### Riscos conhecidos

- **Formato do label**: muda entre versões do Compose v2 (o terceiro campo, `restart`, entrou na 2.17). A regex aceita 2 ou 3 campos: o terceiro é opcional.
- **Nome de serviço com `:`** não é permitido pelo compose; nada a tratar.

### Conformidade com regras do projeto

- Lógica da faixa no front compartilhado (techspec do desktop).
- Textos em pt e en; botão com nome acessível ("Abrir logs de db").

### Conformidade com skills disponíveis

- `tdd` nas funções do `format.ts`.
- `feature-prints` da faixa com a anotação.

### Arquivos relevantes

- `src/format.ts`: `tone`/`bucket`/`isProblem` (48 a 63) e `project`/`service`/`workingDir` (64 a 72).
- `src/app.ts`:
  - `attention`, `inBand`, `bucketOf` e `rootsFirst`, junto do `quiet`; `render` e `renderCount`;
  - `row` (assinatura), `DEP_TXT`, `depHtml` e `rowHtml`, além do `renderDlg`;
  - o `load()` (o `newProblems` com o critério `attention`);
  - `load` (149), `row` (441, assinatura do cache) e `notify` (210).
- `tests/format.test.js`, `tests/e2e/fixtures.ts`, `tests/e2e/compose.spec.ts` e `tests/e2e/problems.spec.ts`.

## Histórico

**2026-10-21**. Documento criado.

**2026-10-21**. Durante o sdd-tasks:
- "Sem container" sai da própria lista de containers, sem consultar o `compose/services`. O compose cria as dependências junto no `up`, então uma dependência sem container foi removida à mão; o caso do profile inativo o compose recusa antes de criar o dependente.
- `health: starting` e um `service_completed_successfully` ainda rodando cumprem a condição. São a espera normal de um `compose up`, e não podem acender a faixa nem notificar.
- O `newProblems` ganha o critério de entrada (`isProblem` ou "Created" segurado).
- A assinatura do cache da linha passa a incluir as dependências, que vêm de outros containers.

**2026-10-21**. Reconciliação do sdd-review:
- Entraram o `bucketOf`, para o filtro e as contagens seguirem a faixa (achado no print da tela; antes o "Created" segurado contava como parado), e a anotação no modal de logs, como texto (o PRD já pedia o modal).
- A anotação aparece também na linha do grupo do projeto, porque o `depHtml` está no `rowHtml`. O PRD foi atualizado nesse ponto.
