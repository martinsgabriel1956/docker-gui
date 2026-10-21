# Techspec: Baixar e atualizar imagens

## Resumo executivo

O `docker pull` entra como uma ação em stream, com a mesma máquina do compose: `POST /api/pull {image}` responde em NDJSON, uma string por linha da saída e `{"code": n}` no fim. Nos dois backends, isso reaproveita o `compose_stream` (Python) e o `compose::stream` (Rust), que já recebem a lista de argumentos, já seguem até o fim sem leitor e já aplicam o prazo de 10 min.

O nome da imagem passa pela mesma validação do "Novo container" (`image_ok`/`imageOk`, num lugar só em cada lado). Para saber se a imagem "mudou" ou "já estava em dia", o front compara o ID da tag na lista de imagens antes e depois do pull. Isso funciona igual com Docker e Podman, sem depender do texto de status de cada um.

## Arquitetura

### Visão de componentes

- **`docker_gui.py`**: `do_POST` ganha `/api/pull` → `pull()`, que valida o corpo com o `image_ok()` (o mesmo do `run_argv`) e chama `self.compose_stream(["pull", "--", image])`.
- **`src-tauri/core/src/router.rs`**: `post()` ganha `/api/pull` → `Reply::Ndjson(compose::stream(ctx, vec!["pull", "--", image]))`, com o `v::image_ok()` do `validate.rs`.
- **A mensagem de prazo do stream** (`compose_stream` e `compose::stream`) usa o primeiro argumento (`compose` ou `pull`), no lugar do "compose" fixo.
- **`src/app.ts`**:
  - **Campo:** "Baixar imagem" (`#pull-q`, num `<form>` no topo de `#panel-images`), validado no front pelo `imageOk` do `format.ts` (o mesmo do `runSpec`). O `pullHint` mostra "(tag latest)" quando falta tag, ou o erro de imagem inválida. O pull vai sempre com a tag explícita (`withTag`).
  - **Botão "Atualizar":** um por tag no `objItem` das imagens ("Atualizar <tag>" quando há várias). Durante o pull, fica "Baixando…" e inerte. Imagem sem tag não tem o botão.
  - **Downloads em andamento:** `pulls: Map<ref, Out & {before}>`, com a saída entrando pelo `addOut` do compose (chave `pull:<ref>`). O `renderPulls()` desenha cada um numa área própria, `#pulls`, acima da lista: o comando, o estado e a saída. O pull falho fica até o × (`closePull`).
  - **Ao terminar:** recarrega a lista (`loadObjects('images')`) e compara o ID da tag (`imageOf`, com o `sameRef`) com o `before`, pelo `pullOutcome`. O aviso diz "Baixada", "Atualizada… A versão anterior ficou sem tag" ou "já estava em dia", e quais containers usam a versão anterior. A linha da imagem fica em destaque (`freshRef`) por 4 s (RF1.3). Na falha, o aviso traz o `errHint` sobre a saída.
- **`src/page.html`**: o campo e a área dos downloads em `#panel-images`.

## Design de implementação

### Interfaces principais

```py
# do_POST: corpo {"image": str}; recusa com 400 "imagem inválida" (a mesma mensagem do run) se não casar com IMAGE_RE
def pull(self): ...
```

```ts
// format.ts
export const imageOk = (image: string): boolean => …;            // a regra do run e do pull
export const withTag = (ref: string): string => …;               // "postgres" -> "postgres:latest" (a porta não é tag)
export const sameRef = (tag: string, ref: string): boolean => …; // com o docker.io/library/ que o podman põe
export const pullOutcome = (before: string | null, after: string | null): 'new' | 'updated' | 'same' | 'missing' => …;
// app.ts
const pulls: Map<string, Out & {before: string | null}>;         // before = ID da tag antes, ou null (não havia)
async function pullImage(typed?: string): Promise<void>;          // T.ndjson('/api/pull', {image: withTag(typed)}, …)
```

### Modelos de dado

- **Requisição:** `{"image": "postgres:17"}`.
- **Resposta:** NDJSON igual à do compose. O `400` de validação vem antes do stream, como JSON, e o `T.ndjson` já devolve `{status, error}` nesse caso.

### Endpoints de API

| Método | Path | Descrição |
|---|---|---|
| POST | `/api/pull` | `docker pull -- <image>` em stream NDJSON. Prazo `COMPOSE_TIMEOUT` (600 s). |

## Pontos de integração

- **Registry:** a autenticação é a que o CLI já tem (`docker login` feito no terminal). Nenhuma credencial passa pela página.
- **Podman:** `podman pull` aceita o mesmo argumento. Nome curto (`postgres:17`) depende dos `unqualified-search-registries` do `registries.conf`; se faltar, o erro do Podman é mostrado como está ("short-name resolution"), com `errHint` quando casar.
- **Saída sem TTY:** o docker escreve uma linha por mudança de estado de camada (`Pulling fs layer`, `Download complete`…). Não há barra de progresso, e a área mostra essas linhas.

## Estratégia de teste

- **Contrato:** o NDJSON chama o `Popen` direto e fica fora das fixtures (techspec do desktop). A validação recusada entra no contrato, porque responde antes de executar: `writes/pull-invalida.json` e `writes/pull-sem-corpo.json`, com `calls: []`. A rota está na lista do teste de cobertura.
- **Unitário Rust:** o `image_ok` (aceita e recusa).
- **Unitário front:** `imageOk`, `withTag` (com porta e digest), `sameRef` e o `pullOutcome` nas quatro combinações.
- **E2E** (`tests/e2e/images.spec.ts`): o docker falso ganha `pull`, que consulta o `registry` do estado, escreve linhas de progresso (com `pull_delay`), acrescenta a imagem ou troca a tag de lugar, e recusa um pull sem o `--` (é ali que o `--` fica conferido nos dois backends). Casos:
  - baixar uma imagem nova faz ela aparecer;
  - atualizar uma tag que não muda dá "já estava em dia";
  - atualizar uma tag que muda dá "Atualizada", e a antiga aparece como sem tag;
  - imagem inexistente mostra a causa traduzida;
  - nome inválido é recusado no campo, sem ir ao docker;
  - a imagem baixada fica em destaque;
  - a imagem sem tag não tem "Atualizar", e uma com duas tags tem um botão por tag.
  - Roda nos dois backends.

## Sequenciamento

1. A rota nos dois backends (validação primeiro, com o caso de contrato).
2. O docker falso com `pull`.
3. Front: campo, "Atualizar" por tag, `pulls` e `renderPulls`, depois `pullOutcome` e os avisos.
4. E2E.

## Observabilidade

Nada novo. O nome da imagem não vai para o log (a regra de privacidade do projeto).

## Considerações técnicas

### Decisões principais

- **Reaproveitar o stream do compose** em vez de criar outro. Ele já resolve o merge de stdout com stderr, o prazo, o "continua sem leitor" (o PRD pede que fechar a aba não interrompa o pull) e o transporte NDJSON nas duas versões. Os nomes `compose_stream` e `compose::stream` ficam como estão; um comentário registra o segundo uso.
- **"Mudou?" pelo ID antes e depois, não pelo texto de status do pull.** O texto `Status: Image is up to date` é do Docker; o Podman escreve outra coisa. Comparar o ID funciona com os dois e não depende de idioma.
- **`--` antes da imagem**, como no serviço do compose. A regex já impede o `-`, mas o `--` fecha a porta de qualquer jeito.
- **A lista de imagens não ganha poll**: recarrega ao fim de cada pull, como faz depois de `prune` e `rm`.

### Riscos conhecidos

- **Pulls simultâneos da mesma imagem**: o docker deduplica as camadas, e a página bloqueia um segundo pull do mesmo `ref` enquanto há um em andamento.
- **Saída muito longa** (imagem com dezenas de camadas): a área usa o mesmo limite `OUT_MAX` da saída do compose.

### Conformidade com regras do projeto

- Argumento validado por regex nos dois backends e no front, sem argumento livre.
- Sem `-f`, sem `--all-tags` e sem login: a GUI não amplia o que o `docker` permite.
- Textos em pt e en; o `title` dos botões mostra o comando (`docker pull <ref>`).

### Conformidade com skills disponíveis

- `tdd` (validação e `pullOutcome`).
- `feature-prints` da aba Imagens com um pull em andamento.

### Arquivos relevantes

- `docker_gui.py`: `image_ok()` (antes do `run_argv`), `do_POST` e `pull()`, e a mensagem de prazo do `compose_stream`.
- `src-tauri/core/src/router.rs` (`post`), `compose.rs` (a mensagem de prazo) e `validate.rs` (`image_ok`, com teste).
- `src/app.ts`: `pulls`, `freshRef`, `imageOf`, `pullHint`, `pullImage`, `closePull` e `renderPulls` (antes do `rmObj`), o `objItem` (botões e destaque) e as ligações do `#pull-q`.
- `src/format.ts`: `imageOk`, `withTag`, `sameRef` e `pullOutcome` (junto do `IMAGE_RE`); o `runSpec` usa o `imageOk`.
- `src/page.html`: o `#pull-form` e o `#pulls` no `#panel-images`.
- `README.md`.
- `tests/contract/writes/pull-*.json`, `tests/test_contract.py`, `tests/format.test.js`, `tests/e2e/images.spec.ts`, `tests/e2e/disk.spec.ts` (o "Atualizar" na linha), `tests/e2e/fixtures.ts` e `tests/e2e/fake-docker/docker`.

## Histórico

**2026-10-21**. Documento criado.

**2026-10-21**. Durante o sdd-tasks:
- A mensagem de prazo do stream usa o primeiro argumento (`compose` ou `pull`), no lugar do "compose" fixo.
- A validação da imagem vira o `image_ok()` nos dois backends, usado pelo `run_argv` e pelo pull.
- A saída ao vivo usa o `addOut` do compose (chave `pull:<ref>`), numa área própria da aba (`#pulls`).
- O "mudou?" compara a tag também com o prefixo do Docker Hub que o Podman põe (`sameRef`).

**2026-10-21**. Reconciliação do sdd-review. O documento passa a descrever o que foi construído:
- o `image_ok`/`imageOk`, o `withTag`, o `sameRef`, a área `#pulls` com o `renderPulls`, o botão por tag e os testes em `images.spec.ts`.

Correções feitas no review:
- o destaque da imagem baixada (RF1.3), que tinha ficado de fora;
- o docker falso passou a recusar um pull sem o `--`, para o E2E conferir os argumentos, que nenhum teste cobria.
