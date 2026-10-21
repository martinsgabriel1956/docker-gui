# Techspec: Mudanças no filesystem do container

## Resumo executivo

A rota nova `GET /api/diff/<id>`, nos dois backends, roda `docker diff <id>` e devolve a lista já separada (`[{"k": "A"|"C"|"D", "p": "/caminho"}]`). No front, uma quarta seção `<details id="diff">` no modal de logs segue o padrão do Histórico e dos Processos: carrega ao abrir a seção, desenha os primeiros 500 itens, filtra sobre a lista inteira com o `logFilter` + `markInto` que os logs já usam, e copia com o mesmo padrão do `copyLogs`.

## Arquitetura

### Visão de componentes

- **`docker_gui.py`**: a rota em `do_GET`, junto do `/api/top`, e a função `diff(stdout)`.
- **`src-tauri/core/src/router.rs` e `normalize.rs`**: a mesma rota e `n::diff`.
- **`src/format.ts`**:
  - `diffSummary(items)` monta o texto "12 adicionados · 3 alterados · 1 apagado";
  - `diffHtml(items, re, max)` gera a lista escapada, com o trecho do filtro marcado;
  - a constante `DIFF_MAX = 500`.
- **`src/app.ts`**:
  - `loadDiff()` segue o modelo do `loadTop` (captura o `logId` e desiste se o modal mudou);
  - o filtro próprio `#diff-q` e o botão de copiar;
  - a lista de seções do `afterClose` e do `openLogs` ganha `'diff'`, para esconder a seção nos logs de projeto e fechá-la ao sair.
- **`src/page.html`**: a seção `<details id="diff" ontoggle="this.open && loadDiff()">`, com o filtro, o resumo, a nota sobre volumes, o botão de atualizar e o corpo.

## Design de implementação

### Interfaces principais

```py
def diff(out: str) -> list[dict]:  # "C /etc\nA /etc/x" -> [{"k": "C", "p": "/etc"}, …]; linha fora do formato é ignorada
```

```rust
pub fn diff(out: &str) -> Vec<Value>;   // normalize.rs, mesma regra
```

```ts
export type DiffItem = {k: 'A' | 'C' | 'D'; p: string};
export const DIFF_MAX = 500;
export function diffSummary(items: DiffItem[]): string;
export function diffHtml(items: DiffItem[], re: RegExp | null, max?: number): {html: string; shown: number; total: number};
```

### Modelos de dado

`200 [{"k":"C","p":"/etc"}, …]`. Erro do CLI (container sumiu) → `500` com o stderr, como o `/api/top`.

### Endpoints de API

| Método | Path | Descrição |
|---|---|---|
| GET | `/api/diff/<id>` | `docker diff <id>`, já separado. `id` pela mesma regex `[0-9a-f]{12,64}`. Prazo: `ACTION_TIMEOUT` (120 s), porque o diff de um container grande pode passar dos 15 s de leitura. |

## Pontos de integração

- **Podman**: o `podman diff <id>` tem a mesma saída em texto (`A`, `C` e `D` seguidos do caminho), então a mesma função atende.
- **Daemon remoto**: funciona igual.

## Estratégia de teste

- **Contrato** (`tests/contract/reads/`): `diff.json` (saída normal), `diff-vazio.json` e `diff-erro.json`, rodando nos dois backends. Mais `en/diff-erro.json`, se a mensagem de erro passar pelo `tr`.
- **Unitário Python e Rust**: o `diff` com linha em branco, com caminho com espaço (o caminho é tudo depois do primeiro espaço) e com linha fora do formato.
- **Unitário front**: o `diffSummary`; o `diffHtml` com o corte em 500 e o total, com o filtro marcando o trecho e com caminho com `<` escapado.
- **E2E** (`tests/e2e/inspect.spec.ts`): o docker falso ganha `diff` com um campo `diff` por container. Os casos: abrir a seção mostra o resumo e os itens; o filtro reduz a lista; um container sem mudanças mostra a mensagem. Roda nos dois backends.

## Sequenciamento

1. A rota e as funções `diff` nos dois backends, com o contrato.
2. As funções do `format.ts`.
3. A seção no `page.html`, o `loadDiff`, o filtro e o copiar.
4. E2E.

## Observabilidade

Nada novo.

## Considerações técnicas

### Decisões principais

- **O backend separa as linhas** (lista de objetos), em vez de passar o texto cru como o `/api/top`. A página precisa do tipo e do caminho em separado para o resumo e para o filtro, e a separação no servidor fica coberta pelo contrato.
- **Corte de exibição no front, não no backend.** O filtro precisa da lista inteira (RF1.6). Uma lista de milhares de caminhos em JSON tem poucas centenas de KB.
- **`ACTION_TIMEOUT` em vez do `READ_TIMEOUT`.** O `docker diff` percorre a camada gravável inteira.
- **Filtro próprio da seção**, sem reaproveitar o `#lf` dos logs, que é ligado ao buffer de linhas. As funções `logFilter` e `markInto` são reaproveitadas.

### Riscos conhecidos

- **Containers com camada gravável enorme** (centenas de milhares de arquivos): o diff pode passar de 120 s. Nesse caso a rota responde com o erro de prazo, e a página sugere o `docker diff` no terminal.

### Conformidade com regras do projeto

- Rota nova nos dois backends, com contrato e E2E nos dois.
- Só leitura; nenhum argumento além do `id` validado.
- Caminhos escapados (texto não confiável).

### Conformidade com skills disponíveis

- `tdd` (contrato primeiro).
- `feature-prints` da seção.

### Arquivos relevantes

- `docker_gui.py`: `do_GET` (676 a 686).
- `src-tauri/core/src/router.rs` (176 a 192) e `normalize.rs`.
- `src/app.ts`:
  - `loadTop`/`topHtml` (1530 a 1545), `openLogs` (1363 a 1372) e `afterClose` (1558);
  - `markInto` (1223), `copyLogs` (1469) e o export para `window` (1921).
- `src/format.ts`: `logFilter` (218).
- `src/page.html`: as seções 130 a 143.
- `tests/contract/reads/`, `tests/format.test.js`, `tests/e2e/inspect.spec.ts` e `tests/e2e/fake-docker/docker`.

## Histórico

**2026-10-21**. Documento criado.

**2026-10-21**. Durante o sdd-tasks: o `diffHtml` sai do `format.ts`. O `format.ts` fica com o `DiffItem`, o `DIFF_MAX` e o `diffSummary`, e a lista é desenhada no `app.ts` com DOM (`paintDiff`), marcando o filtro com o `markInto` dos logs. É o padrão do projeto: dados no `format.ts`, marcação no `app.ts`.
