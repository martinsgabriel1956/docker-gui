# Techspec: Baixar e atualizar imagens

## Resumo executivo

O `docker pull` entra como uma ação em stream, com a mesma máquina do compose: `POST /api/pull {image}` responde em NDJSON, uma string por linha da saída e `{"code": n}` no fim. Nos dois backends, isso reaproveita o `compose_stream` (Python) e o `compose::stream` (Rust), que já recebem a lista de argumentos, já seguem até o fim sem leitor e já aplicam o prazo de 10 min.

O nome da imagem passa pela mesma validação do "Novo container" (`IMAGE_RE`). Para saber se a imagem "mudou" ou "já estava em dia", o front compara o ID da tag na lista de imagens antes e depois do pull. Isso funciona igual com Docker e Podman, sem depender do texto de status de cada um.

## Arquitetura

### Visão de componentes

- **`docker_gui.py`**: `do_POST` ganha `/api/pull`, que valida o corpo e chama `self.compose_stream([*CLI, "pull", "--", image])`.
- **`src-tauri/core/src/router.rs`**: `post()` ganha `/api/pull` → `Reply::Ndjson(compose::stream(ctx, vec!["pull", "--", image]))`, com a validação do `validate.rs` (`IMAGE_RE` e `MAX_IMAGE`).
- **`src/app.ts`**:
  - **Campo:** "Baixar imagem" (`#pull-q`) no topo de `#panel-images`, validado no front pelo `IMAGE_RE` do `format.ts` (o mesmo do `runSpec`). Sem tag, o campo mostra "(tag latest)".
  - **Item "Atualizar":** novo item em cada imagem com tag no `objItem` (uma ação por tag, quando há várias).
  - **Downloads em andamento:** `pulls: Map<ref, {out: string; before: string | null; done?: number}>`, desenhados por um `pullRow(ref)` no estilo do `outRow` do compose: saída ao vivo, × para fechar quando falha e `errHint` sobre a saída em caso de erro.
  - **Ao terminar:** recarrega a lista (`loadObjects('images')`) e compara o ID da tag com o `before`, para decidir entre "Atualizada", "já estava em dia" ou "Baixada". Com mudança, avisa quantos containers ficaram na versão anterior.
- **`src/page.html`**: o campo e a área dos downloads em `#panel-images`.

## Design de implementação

### Interfaces principais

```py
# do_POST: corpo {"image": str}; recusa com 400 "imagem inválida" (a mesma mensagem do run) se não casar com IMAGE_RE
def pull(self): ...
```

```ts
type PullState = {out: string; before: string | null; code?: number};   // before = ID da tag antes, ou null (não havia)
async function pullImage(ref: string): Promise<void>;                      // T.ndjson('/api/pull', {image: ref}, line => …)
export function pullOutcome(before: string | null, after: string | null): 'new' | 'updated' | 'same' | 'missing';
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

- **Contrato:** o NDJSON chama o `Popen` direto e fica fora das fixtures (techspec do desktop). A validação recusada entra no contrato, porque responde antes de executar: `writes/pull-invalida.json`, com `calls: []`.
- **Unitário Rust:** a rota recusa a imagem inválida e monta os argumentos com `--`.
- **Unitário front:** o `pullOutcome`, nas quatro combinações.
- **E2E** (`tests/e2e/disk.spec.ts`, ou um `images.spec.ts` novo): o docker falso ganha `pull`, que acrescenta ou troca o ID de uma imagem no estado e escreve linhas de progresso (com demora configurável e falha por nome). Casos:
  - baixar uma imagem nova faz ela aparecer;
  - atualizar uma tag que não muda dá "já estava em dia";
  - atualizar uma tag que muda dá "Atualizada", e a antiga aparece como sem tag;
  - imagem inexistente mostra a causa traduzida;
  - nome inválido é recusado no campo.
  - Roda nos dois backends.

## Sequenciamento

1. A rota nos dois backends (validação primeiro, com o caso de contrato).
2. O docker falso com `pull`.
3. Front: campo, item "Atualizar", `pulls` e `pullRow`, depois `pullOutcome` e os avisos.
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

- `docker_gui.py`:
  - `do_POST` (785) e `compose_stream` (1033);
  - `IMAGE_RE`/`MAX_IMAGE` (116 a 125) e as constantes de prazo (45, 75 e 112).
- `src-tauri/core/src/router.rs` (`post`, 195 a 224), `compose.rs` (15) e `validate.rs` (19 a 26 e 123 a 167).
- `src/app.ts`:
  - `loadObjects` (1792), `objItem` (1803) e `renderObjects` (1847);
  - `composeAct`/`addOut`/`outRow` (935 a 989).
- `src/format.ts`: `IMAGE_RE` (310) e `errHint` (242).
- `src/page.html`: `#panel-images` (102 a 104).
- `tests/contract/writes/`, `tests/e2e/fake-docker/docker` e `tests/e2e/disk.spec.ts`.

## Histórico

**2026-10-21**. Documento criado.

**2026-10-21**. Durante o sdd-tasks:
- A mensagem de prazo do stream usa o primeiro argumento (`compose` ou `pull`), no lugar do "compose" fixo.
- A validação da imagem vira o `image_ok()` nos dois backends, usado pelo `run_argv` e pelo pull.
- A saída ao vivo usa o `addOut` do compose (chave `pull:<ref>`), numa área própria da aba (`#pulls`).
- O "mudou?" compara a tag também com o prefixo do Docker Hub que o Podman põe (`sameRef`).
