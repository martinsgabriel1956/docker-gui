# Tasks: Alerta de memória perto do limite

Lote em 6 tasks, nesta ordem: rota nos dois backends → funções puras → tela e notificações → E2E → memória do desktop → README.

**Ajustes ao techspec, decididos aqui** (o techspec é atualizado junto, no Histórico):

1. **A rota lê `info --format {{json .}}` e procura a RAM em dois lugares.** O techspec previa um `--format` por CLI (`.MemTotal` no Docker, `.Host.MemTotal` no Podman). Mas o podman-docker (o `docker` que chama o Podman) não seria detectado como Podman pelo nome do binário, e o `.MemTotal` falharia nele. Com o JSON inteiro, a rota pega `MemTotal` (Docker) ou `host.memTotal` (Podman), numa chamada só, para os três casos.
2. **`causes`/`alertKey` viram o que o código já tem depois da dependência do compose.**
   - A entrada na faixa é `attention(c)` (`isProblem`, "Created" segurado ou memória).
   - A chave da notificação é `ID` para quem está quebrado e `ID:mem` para quem só está perto do limite.
   - O `newProblems` ganha o parâmetro da chave.
   (Nota no Histórico do techspec, vinda da dependência.)
3. **O que já estava acima do limiar ao abrir a página não notifica (PRD).** A primeira leitura do stats com a RAM total serve de base. Quem já está em 90% ou mais nela fica "quente" na hora (sem esperar a 2ª leitura) e entra no `seen` sem notificar.

---

## T1. Rota `GET /api/info` nos dois backends

**Escopo:** `/api/info` → `{"MemTotal": <bytes>}` no `docker_gui.py` e no `router.rs`, com os casos de contrato e o `info` no docker falso.

**Contexto:** techspec, "Visão de componentes" e "Endpoints". Sem limite, o stats reporta a RAM total como limite. Saber a RAM total é o que separa o container com limite do container sem limite.

**Skills a carregar:** `tdd`; `security-best-practices` não se aplica (só leitura, sem argumento vindo da página).

**Regras a respeitar:**
- Rota nova nos dois backends, com o mesmo caso de contrato (techspec do desktop).
- `docker_gui.py` só com a biblioteca padrão.
- Mensagens pelo `tr()`/`trf()`. O formato inesperado reaproveita a mensagem que já existe ("formato inesperado na saída do {cmd}").

**Steps:**

1. Casos de contrato em `tests/contract/lists/` (o vermelho), todos com `request: GET /api/info` e a chamada `["info", "--format", "{{json .}}"]`:
   - `info-docker.json`: stdout `{"MemTotal": 16654159872, "NCPU": 8, "ServerVersion": "28.0.0"}` → `200 {"MemTotal": 16654159872}`;
   - `info-podman.json`: `cli: ["podman"]`, stdout `{"host": {"memTotal": 8221675520}, "version": {"Version": "5.4.0"}}` → `200 {"MemTotal": 8221675520}`;
   - `info-erro.json`: código 1, stderr do daemon fora do ar → `500` com o stderr;
   - `info-formato.json`: stdout `{}` → `500 "formato inesperado na saída do docker info"`.

2. `docker_gui.py`, junto das funções de normalização:

```py
def mem_total(out):
    """RAM total do daemon, do `info --format {{json .}}`: MemTotal no docker, host.memTotal no podman (e no
    podman-docker, que o nome do binário não denuncia). None se não vier."""
    try:
        d = json.loads(out)
    except ValueError:
        return None
    v = d.get("MemTotal") or (d.get("host") or {}).get("memTotal") if isinstance(d, dict) else None
    return v if isinstance(v, int) and v > 0 else None
```

   E no `do_GET`, antes do `if self.path in LISTS`:

```py
        if self.path == "/api/info":  # sem limite, o stats reporta a RAM total como limite: a página precisa dela
            r = docker("info", "--format", "{{json .}}")
            if r.returncode:
                return self.send(500, json.dumps(r.stderr.strip()))
            total = mem_total(r.stdout)
            return (self.send(200, json.dumps({"MemTotal": total})) if total else
                    self.send(500, json.dumps(tr("formato inesperado na saída do {cmd}").format(cmd=f"{CLI[0]} info"))))
```

3. `src-tauri/core/src/normalize.rs`:

```rust
/// RAM total do daemon, do `info --format {{json .}}` (o mem_total do Python)
pub fn mem_total(out: &str) -> Option<u64> {
    let v: Value = serde_json::from_str(out).ok()?;
    v.get("MemTotal").or_else(|| v.get("host")?.get("memTotal"))?.as_u64().filter(|&t| t > 0)
}
```

   E no `router.rs` (`get`), antes do bloco `/api/containers | /api/stats | /api/df`:

```rust
    if full == "/api/info" {
        let r = ctx.docker(&["info", "--format", "{{json .}}"], READ_TIMEOUT).await;
        if r.code != 0 {
            return Ok(reply(500, r.stderr.trim()));
        }
        let cmd = format!("{} info", ctx.cli[0]);
        return Ok(n::mem_total(&r.stdout).map_or_else(|| format_error(ctx, &cmd), |t| reply(200, json!({"MemTotal": t}))));
    }
```

4. `tests/e2e/fake-docker/docker`: um `elif cmd == "info":` que imprime `json.dumps({"MemTotal": state.get("mem_total", 16 * 2**30)})`. O tipo `DockerState` em `tests/e2e/fixtures.ts` ganha `mem_total?: number`.

**Plano de teste:**
- `python -m unittest` (contrato e cobertura de rotas) e `cargo test -p stivo-core` verdes.
- `cargo fmt --check` e `clippy -D warnings` do núcleo limpos.

---

## T2. Funções puras da memória no `format.ts`

**Escopo:** `memLimit`, `memPct`, `memWatch` e `memText`, mais o `newProblems` com o parâmetro da chave. Testes no `node:test`.

**Contexto:** techspec, "Interfaces principais" e as regras do `memWatch`. A histerese (90% em 2 leituras para entrar, abaixo de 85% para sair) e a margem de 95% da RAM são puras e testáveis.

**Skills a carregar:** `tdd`.

**Regras a respeitar:** o `format.ts` não toca no DOM; os textos passam pelo `t```.

**Steps:**

1. Testes primeiro (o vermelho):

```js
const st = (used, limit, perc) => ({ID: 'x', CPUPerc: '1%', MemUsage: `${used} / ${limit}`, MemPerc: perc});
const GiB = 2 ** 30;
test('memLimit e memPct leem o uso e o limite do stats', () => {
  assert.deepEqual(f.memLimit(st('476MiB', '512MiB', '92.97%')), {used: 476 * 2 ** 20, limit: 512 * 2 ** 20});
  assert.equal(f.memLimit(st('--', '--', '--')), null);
  assert.equal(f.memPct(st('476MiB', '512MiB', '92.97%')), 92.97);
  assert.equal(f.memPct(st('256MiB', '512MiB', '--')), 50);  // sem o MemPerc, a conta
});
test('memWatch: 2 leituras para entrar, abaixo de 85% para sair, sem limite nunca', () => {
  const s = p => ({x: st(`${p * 5.12}MiB`, '512MiB', `${p}%`)}), T = 16 * GiB;
  let m = f.memWatch(new Map(), s(95), T);
  assert.equal(f.memHot(m, 'x'), false);               // 1ª leitura: ainda não
  m = f.memWatch(m, s(96), T); assert.equal(f.memHot(m, 'x'), true);
  m = f.memWatch(m, s(87), T); assert.equal(f.memHot(m, 'x'), true);   // entre 85 e 90: fica
  m = f.memWatch(m, s(80), T); assert.equal(f.memHot(m, 'x'), false);  // abaixo de 85: sai
  m = f.memWatch(f.memWatch(new Map(), s(95), T), s(88), T);
  assert.equal(f.memHot(f.memWatch(m, s(95), T), 'x'), false);  // pico, queda, pico: não são 2 seguidas
  const noLimit = {x: st('15.5GiB', '15.6GiB', '99.36%')};       // o "limite" é a RAM toda (arredondada)
  assert.equal(f.memHot(f.memWatch(f.memWatch(new Map(), noLimit, T), noLimit, T), 'x'), false);
  assert.equal(f.memHot(f.memWatch(f.memWatch(new Map(), s(95), null), s(95), null), 'x'), false);  // sem RAM total
  assert.equal(f.memHot(f.memWatch(new Map(), s(95), T, true), 'x'), true);  // base: quente já na 1ª leitura
  assert.equal(f.memWatch(f.memWatch(new Map(), s(95), T), {}, T).size, 0);  // parou: sai
});
test('memText diz a porcentagem e os números', () => {
  assert.equal(f.memText(st('476MiB', '512MiB', '92.97%')), 'Memória em 93% do limite (476 MiB de 512 MiB)');
});
test('newProblems compara pela chave', () => {
  const a = c('running', 'Up 1 minute', {ID: 'a'});
  assert.deepEqual(f.newProblems(new Set(['a:mem']), [a], () => true, x => x.ID), [a]);  // mem -> queda: entra de novo
  assert.deepEqual(f.newProblems(new Set(['a']), [a], () => true, x => x.ID), []);
});
```

2. No `src/format.ts`, depois do `percent`/`fmtBytes`:

```ts
// memória: uso e limite do "476MiB / 512MiB" do stats. Sem limite, o docker põe a RAM toda do daemon no lugar do limite
export function memLimit(s: Stats): {used: number; limit: number} | null {
  const [u, l] = s.MemUsage.split(' / ').map(x => bytes(x ?? ''));
  return u !== null && l ? {used: u, limit: l} : null;
}
// o MemPerc do docker vem das contas exatas; sem ele ("--" no podman), a conta com o que veio
export const memPct = (s: Stats): number | null => {
  const m = memLimit(s);
  return percent(s.MemPerc) ?? (m && m.used / m.limit * 100);
};
// container quente: 2 leituras seguidas em 90% ou mais do limite; sai abaixo de 85% (entre os dois, fica como está).
// Limite acima de 95% da RAM total conta como sem limite (o stats arredonda a RAM: "7.6GiB" são 7,63 GiB). first: a
// primeira leitura da página, que serve de base (quem já estava no alto fica quente sem esperar, e não notifica)
export type MemState = Map<string, {n: number; on: boolean}>;
const MEM_IN = 90, MEM_OUT = 85, MEM_READS = 2, NO_LIMIT = 0.95;
export function memWatch(prev: MemState, stats: Record<string, Stats>, memTotal: number | null, first = false): MemState {
  const next: MemState = new Map();
  if (!memTotal) return next;
  for (const [id, s] of Object.entries(stats)) {
    const m = memLimit(s), pct = memPct(s), was = prev.get(id) ?? {n: 0, on: false};
    if (!m || pct === null || m.limit >= NO_LIMIT * memTotal) continue;
    if (pct >= MEM_IN) next.set(id, {n: was.n + 1, on: was.on || first || was.n + 1 >= MEM_READS});
    else if (pct >= MEM_OUT && was.on) next.set(id, {n: 0, on: true});
  }
  return next;
}
export const memHot = (st: MemState, id: string): boolean => !!st.get(id)?.on;
export const memText = (s: Stats): string => {
  const m = memLimit(s)!;
  return t`Memória em ${Math.round(memPct(s)!)}% do limite (${fmtBytes(m.used)} de ${fmtBytes(m.limit)})`;
};
```

3. O `newProblems` ganha a chave, com o ID como padrão:

```ts
export const newProblems = (before: Set<string> | null, cs: Container[], is: (c: Container) => boolean = isProblem,
                            key: (c: Container) => string = c => c.ID): Container[] =>
  before ? cs.filter(c => is(c) && !before.has(key(c))) : [];
```

4. `src/en.json`: `"Memória em {0}% do limite ({1} de {2})": "Memory at {0}% of the limit ({1} of {2})"`.

**Plano de teste:** `npm run test:js` e `npx tsc -p .` verdes.

---

## T3. A faixa, as contagens e as notificações com a memória

**Escopo:**
- **Leitura:** a página lê a RAM total, mantém o estado `mem` a cada leitura do stats e lê o stats em segundo plano quando vigia.
- **Faixa e contagens:** o container quente entra na faixa, nas contagens, no favicon e na bandeja, depois dos que quebraram.
- **Notificação:** sai pelas regras de hoje, e a queda de quem estava quente notifica de novo.
- **Texto:** a linha e o modal mostram "Memória em 93% do limite (…)", com um botão para os Processos.

**Contexto:** PRD, RF1.1 a RF1.5, RF2.1 a RF2.3 e RF3.1 a RF3.4. Hoje o `statsLoop` olha só o `document.hidden`; o techspec manda seguir o `watching()`, como o poll da lista.

**Skills a carregar:** `frontend-design:frontend-design` (texto no tom de aviso, botão com foco visível, DESIGN.md).

**Regras a respeitar:**
- O que vem do docker passa por `esc`.
- Cor e texto juntos.
- Os handlers no `Object.assign(window, …)`.
- `build.py` depois.

**Steps:**

1. Estado e leitura (junto do `stats`, linha 230):

```ts
let memTotal: number | null = null, mem: MemState = new Map(), memBase = true;  // memBase: a próxima leitura é a base
async function loadMemTotal() {
  try { const r = await api('/api/info'); if (r.ok) memTotal = (await r.json() as {MemTotal: number}).MemTotal; }
  catch { /* tenta de novo na próxima leitura do stats */ }
}
```

   No `loadStats`, depois de montar o `next`:

```ts
  if (memTotal === null) await loadMemTotal();
  const first = memBase && memTotal !== null;
  mem = memWatch(mem, next, memTotal, first);
  stats = next;
  if (first) { memBase = false; for (const c of data) if (memOn(c)) seen?.add(alertKey(c)); }  // base: não notifica
  checkAttention();
```

   O `statsLoop` passa a ser `if (watching()) await loadStats()`.

2. Faixa, chave e ordem (junto do `attention`, que veio da dependência):

```ts
const memOn = (c: Container) => c.State === 'running' && memHot(mem, sid(c.ID));
// quebrado (o que existia) ou segurado: grave. Só a memória: aviso, com chave própria, para a queda notificar de novo
const severe = (c: Container) => isProblem(c) || held(c, data);
const attention = (c: Container) => severe(c) || memOn(c);
const inBand = (c: Container) => (isProblem(c) && !quiet(c)) || held(c, data) || memOn(c);
const bucketOf = (c: Container): Bucket => held(c, data) || memOn(c) ? 'problema' : bucket(c);
const alertKey = (c: Container) => severe(c) ? c.ID : `${c.ID}:mem`;
// raiz de dependência, depois quem quebrou, depois quem só está perto do limite (o sort é estável: o resto por nome)
const rank = (c: Container) => holds(c, data).length ? 0 : severe(c) ? 1 : 2;
const attnSort = (cs: Container[]) => cs.sort((a, b) => rank(a) - rank(b));
```

   O `rootsFirst` vira `attnSort` nos dois usos (`render` e `notify`).

3. `checkAttention()` junta o que o `load()` faz hoje e passa a ser chamado também do `loadStats`:

```ts
let seen: Set<string> | null = null;  // (já existe: passa a guardar chaves, não IDs)
function checkAttention() {
  notify(newProblems(seen, data, attention, alertKey));
  seen = new Set(data.filter(attention).map(alertKey));
}
```

4. Texto: `const memLine = (c) => memOn(c) && stats[sid(c.ID)] ? memText(stats[sid(c.ID)]) : ''`.
   - **Na linha (`rowHtml`), depois do `depHtml`:**
     `<span class="block text-xs text-warn-fg">${esc(memLine)} <button onclick="openProcs('${c.ID}')" aria-label="${t`Ver os processos de ${esc(c.Names)}`}" class="… underline …">${t`Processos`}</button></span>`.
     A assinatura do `row` ganha `memOn(c)`.
   - **No `renderDlg`:** a mesma linha, sem o botão (os Processos estão logo abaixo, no `#procs`).
   - **No `notify`:** o corpo de um container só usa `memLine(c) || status(c)[0]` quando o container não é `severe`.

5. O botão abre os logs com os Processos abertos:

```ts
function openProcs(id: string) { logs(id); const d = $<HTMLDetailsElement>('#procs'); if (!d.hidden) d.open = true; }
```

   O `ontoggle` do `#procs` já chama o `loadTop`. O `openProcs` entra no `Object.assign(window, …)`.

6. O subtítulo da faixa: "healthcheck falhando, loop de reinício, saída com erro, dependência quebrada ou memória perto do limite", com a chave trocada no `en.json`, mais `Ver os processos de {0}` e `Processos`. Se `Processos` já existir no `page.html`, a chave já existe.

7. `python3 build.py --css`.

**Plano de teste:**
- `npx tsc -p .`, `npm run test:js`, `python -m unittest` e `build.py --check` verdes.
- A suíte E2E de hoje continua verde.

---

## T4. E2E

**Escopo:** casos da faixa, das contagens, da notificação e da escalada para queda, nos dois backends.

**Contexto:** techspec, "Estratégia de teste". O stats do docker falso já aceita uma lista de leituras por container (`stats: [...]`, uma por consulta). O `info` vem da T1.

**Skills a carregar:** `tdd`; `systematic-debugging`, se os backends divergirem.

**Regras a respeitar:**
- Pular um spec no Rust não é correção.
- Chrome do sistema (`PW_CHROMIUM_PATH=/usr/bin/google-chrome`).
- O stats roda a cada 5 s, então as esperas usam o `slow` (15 s) do `stats.spec.ts`.

**Steps:**

1. `tests/e2e/stats.spec.ts`, com casos novos:
   - **Entrada:** `api` com leituras `[50%, 95%, 96%, 96%…]` de um limite de 512 MiB (com `MemPerc` coerente). Na 3ª leitura ela entra na faixa (`h:attn`), com "Memória em 96% do limite (… de 512 MiB)". O filtro mostra "1 com problema". O botão "Processos" abre o modal com o `#procs` aberto.
   - **Saída:** depois, leituras de 80%: a `api` sai da faixa.
   - **Sem limite:** `web` com `15.5GiB / 15.6GiB` (99%) e `mem_total` de 16 GiB: nunca entra.
   - **Já no alto ao abrir:** `api` em 95% desde a 1ª leitura: entra na faixa já na 1ª leitura (base).

2. `tests/e2e/notifications.spec.ts`: com as notificações ligadas, a `api` sobe de 50% para 95%. Sai `['api precisa de atenção', 'Memória em 95% do limite (…)']`. Depois a `api` passa a `Exited (137)` (OOM): sai a 2ª notificação, com o status da queda.

3. A suíte inteira nos dois backends.

**Plano de teste:** a suíte E2E inteira verde nos dois backends.

---

## T5. Memória do desktop com o stats em segundo plano

**Escopo:** medir o PSS do app com a janela fechada, agora com o stats rodando a cada 5 s, e conferir o teto de 150 MB.

**Contexto:** techspec, "Riscos conhecidos" e a etapa 5 do "Sequenciamento". A última medição (T10 do desktop) deu 140,8 MB sem o stats em segundo plano.

**Skills a carregar:** `extreme-software-optimization`, só se passar do teto.

**Regras a respeitar:**
- Medir com o binário de release e o `scripts/memory.sh --idle`, como no PRD do desktop.
- Se estourar, não forçar: o techspec manda espaçar o stats em segundo plano, e o PRD (meta de 15 s) precisa mudar junto.

**Steps:**

1. `npx tauri build --no-bundle` (o binário de release em `src-tauri/target/release/stivo`).
2. `scripts/memory.sh --idle src-tauri/target/release/stivo`, com o docker falso em 6 containers, alguns com `stats`. O script já sobe o X próprio e fecha a janela.
3. Registrar o número no techspec (Riscos conhecidos e Histórico), como foi feito com o desktop.
4. Se o ambiente não tiver o que o `--idle` precisa (Xvfb, xdotool, WebKitGTK), registrar que a medição ficou pendente e por quê, sem inventar número.

**Plano de teste:** PSS ≤ 150 MB, ou a pendência registrada no techspec.

---

## T6. README

**Escopo:** o README descreve o alerta de memória e as duas features implementadas antes, que ainda não estão lá: o histórico do healthcheck e a dependência do compose.

**Contexto:** o README é a documentação das features ("O que faz"), e o PRD do desktop exige que ele continue valendo. O histórico do healthcheck e a dependência do compose entraram sem atualizá-lo.

**Skills a carregar:** nenhuma.

**Regras a respeitar:** a voz do PRODUCT.md: pt-BR direto, frases curtas, os verbos do CLI literais.

**Steps:**

1. **"Faixa 'Precisa de atenção'" (README, linha 59):** acrescentar memória perto do limite (só com limite; 90% em 2 leituras, sai abaixo de 85%; notifica, e a queda notifica de novo) e a dependência que segurou o serviço ("depende de db, que …", a raiz primeiro, o "Created" segurado contando como problema).
2. **"Logs" (linha 75):** trocar "Mostra também a saída do último healthcheck" pelos 5 últimos probes (horário, duração, resultado e saída, com Copiar e ↻).
3. **Lista ao vivo:** dizer que o stats continua em segundo plano com as notificações ligadas (e sempre no desktop).

**Plano de teste:** leitura; nada de código.
