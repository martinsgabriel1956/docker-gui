# Tasks: Dependência que segurou o serviço

Lote em 3 tasks, nesta ordem: funções puras → tela e notificações → E2E. Os backends não mudam: o label `com.docker.compose.depends_on` já chega no `Labels` de cada container (techspec, "Resumo executivo").

**Ajuste ao techspec, decidido aqui:** "sem container" sai da própria lista de containers, sem consultar o `compose/services`. O compose cria as dependências junto no `up`, então uma dependência sem nenhum container no projeto foi removida à mão. O `compose/services` só separaria "fora de um profile ativo", e nesse caso o compose recusaria o `up` antes de criar o dependente. O techspec é atualizado junto (Histórico).

---

## T1. Funções puras das dependências no `format.ts`

**Escopo:** `dependsOn`, `depState`, `blockers`, `held` e `holds`, mais o `newProblems` aceitando o critério de entrada na faixa. Testes no `node:test`.

**Contexto:** o techspec ("Interfaces principais" e a tabela condição × estado) põe a regra no `format.ts`, puro e testável. Um caso de borda do PRD muda o desenho: um "Created" esperando um `db` que ainda está em "verificando saúde" é a espera normal de um `compose up`, e não pode entrar na faixa nem notificar. Por isso `health: starting` cumpre a condição. O mesmo vale para um `migrate` (`service_completed_successfully`) ainda rodando.

**Skills a carregar:** `tdd`.

**Regras a respeitar:**
- O `format.ts` não toca no DOM.
- O parse dos `Labels` usa regex ancorada em `(?:^|,)`, como `project` e `service`. O valor do `depends_on` tem vírgulas (o comentário na linha 64 já avisa).

**Steps:**

1. Testes primeiro, em `tests/format.test.js` (o vermelho):

```js
const dep = (Names, State, Status, deps = '', svc = Names) => ({ID: Names, Names, State, Status,
  Labels: `${deps ? `com.docker.compose.depends_on=${deps},` : ''}com.docker.compose.project=shop,com.docker.compose.service=${svc}`});

test('dependsOn lê o depends_on com 2 ou 3 campos e para no próximo label', () => {
  assert.deepEqual(f.dependsOn(dep('api', 'created', 'Created', 'db:service_healthy:false,redis:service_started:true')),
    [{service: 'db', cond: 'service_healthy'}, {service: 'redis', cond: 'service_started'}]);
  assert.deepEqual(f.dependsOn(dep('api', 'created', 'Created', 'migrate:service_completed_successfully')),
    [{service: 'migrate', cond: 'service_completed_successfully'}]);
  assert.deepEqual(f.dependsOn(dep('api', 'created', 'Created', 'db:outra_coisa:false')), [{service: 'db', cond: 'service_started'}]);
  assert.deepEqual(f.dependsOn(dep('api', 'running', 'Up 1 minute')), []);
  assert.deepEqual(f.dependsOn({Labels: 'xcom.docker.compose.depends_on=db:service_started:false'}), []);
});

test('depState confere a dependência contra a condição', () => {
  const st = (cond, ...cs) => f.depState({service: 'db', cond}, 'shop', cs);
  assert.equal(st('service_started', dep('db', 'running', 'Up 1 minute (unhealthy)')), null);
  assert.equal(st('service_healthy', dep('db', 'running', 'Up 1 minute (unhealthy)')), 'unhealthy');
  assert.equal(st('service_healthy', dep('db', 'running', 'Up 2 seconds (health: starting)')), null);  // espera normal do up
  assert.equal(st('service_healthy', dep('db', 'running', 'Up 1 minute')), null);  // sem healthcheck
  assert.equal(st('service_started', dep('db', 'exited', 'Exited (1) 1 minute ago')), 'exited');
  assert.equal(st('service_started', dep('db', 'restarting', 'Restarting (1) 2 seconds ago')), 'exited');
  assert.equal(st('service_started', dep('db', 'exited', 'Exited (0) 1 minute ago')), 'stopped');
  assert.equal(st('service_completed_successfully', dep('db', 'exited', 'Exited (0) 1 minute ago')), null);
  assert.equal(st('service_completed_successfully', dep('db', 'exited', 'Exited (2) 1 minute ago')), 'exited');
  assert.equal(st('service_completed_successfully', dep('db', 'running', 'Up 3 seconds')), null);  // ainda migrando
  assert.equal(st('service_started'), 'missing');
  // réplicas: basta uma que cumpra
  assert.equal(st('service_started', dep('db-1', 'exited', 'Exited (1) 1 minute ago', '', 'db'), dep('db-2', 'running', 'Up 1 minute', '', 'db')), null);
});

test('blockers, held e holds ligam o dependente à causa', () => {
  const db = dep('db', 'running', 'Up 1 minute (unhealthy)');
  const api = dep('api', 'created', 'Created', 'db:service_healthy:false,cache:service_started:false');
  const web = dep('web', 'running', 'Up 1 minute', 'api:service_started:false');
  const cs = [db, api, web];
  assert.deepEqual(f.blockers(api, cs).map(b => [b.service, b.state, b.c?.ID]), [['db', 'unhealthy', 'db'], ['cache', 'missing', undefined]]);
  assert.equal(f.held(api, cs), true);
  assert.deepEqual(f.blockers(web, cs), []);  // de pé e bem: ninguém o segura
  assert.equal(f.held(dep('api', 'created', 'Created'), cs), false);  // criado à mão, sem dependência quebrada
  assert.deepEqual(f.holds(db, cs).map(c => c.Names), ['api']);
  assert.deepEqual(f.holds(dep('solto', 'running', 'Up 1 minute (unhealthy)'), cs), []);
});

test('newProblems aceita outro critério de entrada na faixa', () => {
  const api = c('created', 'Created', {ID: 'a'});
  assert.deepEqual(f.newProblems(new Set(), [api]), []);
  assert.deepEqual(f.newProblems(new Set(), [api], () => true), [api]);
});
```

2. No `src/format.ts`, depois do `service`:

```ts
// depends_on do compose: "db:service_healthy:false,redis:service_started:false". O 3º campo (restart) entrou no Compose 2.17
// e é opcional. O valor tem vírgulas: a regex vai até o próximo ",chave=", que não casa com "nome:condição"
const DEP = '[^,=:]+:[^,=:]+(?::(?:true|false))?';
const DEPS_RE = new RegExp(`(?:^|,)com\\.docker\\.compose\\.depends_on=(${DEP}(?:,${DEP})*)`);
export type Cond = 'service_started' | 'service_healthy' | 'service_completed_successfully';
export type Dep = {service: string; cond: Cond};
const CONDS: readonly string[] = ['service_started', 'service_healthy', 'service_completed_successfully'];
export function dependsOn(c: Pick<Container, 'Labels'>): Dep[] {
  const v = (c.Labels || '').match(DEPS_RE)?.[1];
  return !v ? [] : v.split(',').map(d => {
    const [service, cond] = d.split(':');
    return {service, cond: (CONDS.includes(cond) ? cond : 'service_started') as Cond};  // condição desconhecida: a mais branda
  });
}

// por que a dependência não cumpre a condição; null = cumpre. "verificando saúde" e um migrate ainda rodando são a espera
// normal de um compose up: não seguram ninguém (senão cada up acenderia a faixa)
export type DepState = 'unhealthy' | 'exited' | 'stopped' | 'missing';
function oneState(c: Container, cond: Cond): DepState | null {
  if (c.State === 'running') return cond === 'service_healthy' && /\(unhealthy\)/.test(c.Status) ? 'unhealthy' : null;
  if (cond === 'service_completed_successfully' && /^Exited \(0\)/.test(c.Status)) return null;
  if (c.State === 'restarting' && !restartCode(c)) return null;  // voltando, sem crash
  return tone(c) === 'bad' ? 'exited' : 'stopped';
}
export function depState(d: Dep, p: string, cs: Container[]): DepState | null {
  const st = cs.filter(c => project(c) === p && service(c) === d.service).map(c => oneState(c, d.cond));
  if (!st.length) return 'missing';
  return st.includes(null) ? null : st.find(s => s === 'unhealthy' || s === 'exited') ?? st[0];  // réplicas: basta uma
}

// as dependências diretas que seguram o container. Container de pé e bem não é segurado por ninguém.
// ponytail: O(n) por container, O(n²) por render; listas locais têm dezenas de containers
export type Blocker = {service: string; state: DepState; c?: Container};
export function blockers(c: Container, cs: Container[]): Blocker[] {
  const p = project(c);
  if (!p || (c.State === 'running' && !isProblem(c))) return [];
  return dependsOn(c).flatMap(d => {
    const state = depState(d, p, cs);
    return state ? [{service: d.service, state, c: cs.find(x => project(x) === p && service(x) === d.service)}] : [];
  });
}
// "Created" esperando uma dependência quebrada: entra na faixa (o criado à mão, sem causa, continua parado)
export const held = (c: Container, cs: Container[]): boolean => c.State === 'created' && blockers(c, cs).length > 0;
// quem este container segura (no mesmo projeto)
export function holds(c: Container, cs: Container[]): Container[] {
  const p = project(c), s = service(c);
  return !p ? [] : cs.filter(d => d.ID !== c.ID && project(d) === p && blockers(d, cs).some(b => b.service === s));
}
```

3. O `newProblems` ganha o critério, com o padrão de hoje:

```ts
export const newProblems = (before: Set<string> | null, cs: Container[], is: (c: Container) => boolean = isProblem): Container[] =>
  before ? cs.filter(c => is(c) && !before.has(c.ID)) : [];
```

**Plano de teste:**
- `npm run test:js` verde (os testes antigos do `newProblems` continuam passando sem mudança).
- `npx tsc -p .` sem erro.

---

## T2. A faixa, a linha e a notificação

**Escopo:** o "Created" segurado entra na faixa, nas contagens e nas notificações. A causa-raiz vem primeiro na faixa e na notificação agrupada. A linha ganha "depende de `db`, que …" (com o nome levando aos logs da dependência) e "segurando api, worker". O subtítulo da faixa menciona a dependência.

**Contexto:** PRD, RF1.1 a RF1.5, RF2.1, RF2.2 e RF3.1.
- O techspec põe `inBand`, a ordem e o status no `app.ts`.
- Como a anotação depende de **outros** containers, a assinatura do cache da linha (`row`, linha 441) precisa incluí-la. Sem isso, a linha da `api` não seria redesenhada quando o `db` muda.

**Skills a carregar:** `frontend-design:frontend-design`, para a anotação seguir o DESIGN.md (texto `text-fg-soft`, o nome em mono e foco visível).

**Regras a respeitar:**
- Nomes que vêm do docker passam por `esc` e vão em mono, como o `mono()` da linha 457.
- Botão com nome acessível ("Abrir logs de db").
- Textos novos em pt e en (`src/en.json`).
- O `build.py` regenera o `docker_gui.py` e a página do desktop.

**Steps:**

1. Imports do `format.ts`: `type Blocker`, `type DepState`, `blockers`, `held` e `holds`.

2. Entrada na faixa e notificação (linhas 149 e 150, e 471):

```ts
// na faixa de atenção: o que está com problema (menos a queda antiga marcada como vista) e o "Created" que uma
// dependência quebrada segura
const attention = (c: Container) => isProblem(c) || held(c, data);
const inBand = (c: Container) => (isProblem(c) && !quiet(c)) || held(c, data);
```

   E no `load()`:

```ts
    notify(newProblems(seen, data, attention));
    seen = new Set(data.filter(attention).map(c => c.ID));
```

   O `attention` e o `inBand` são `const` de função, chamados só depois de `data` existir. Precisam ficar declarados antes do primeiro `load()`: se o `inBand` ficar onde está (471), o `attention` vai para junto dele.

3. A causa-raiz primeiro, na faixa (`render`, 667) e na notificação (`notify`, 210):

```ts
// quem segura outros vem antes (consertar o db conserta a api); o sort é estável, então o resto segue por nome
const rootsFirst = (cs: Container[]) => cs.sort((a, b) => +(holds(b, data).length > 0) - +(holds(a, data).length > 0));
```

   Uso: `const attn = rootsFirst(rows.filter(inBand))`; no `notify`, `cs = rootsFirst([...cs])` antes de montar o título, o corpo e o alvo do clique.

4. A anotação na linha:

```ts
const DEP_TXT: Record<DepState, (s: string) => string> = {
  unhealthy: s => t`depende de ${s}, que está com healthcheck falhando`, exited: s => t`depende de ${s}, que saiu com erro`,
  stopped: s => t`depende de ${s}, que está parado`, missing: s => t`depende de ${s}, que não tem container`};
// "depende de db, que …" (o nome abre os logs do db) e "segurando api e worker"
function depHtml(bl: Blocker[], hd: Container[]) {
  return bl.map(b => `<span class="block text-xs text-fg-soft">${DEP_TXT[b.state](b.c
    ? `<button data-id="${b.c.ID}" data-a="dep" onclick="act('logs','${b.c.ID}')" aria-label="${t`Abrir logs de ${esc(b.service)}`}"
        class="font-mono underline underline-offset-4 rounded hover:text-fg-strong focus-visible:outline-2 focus-visible:outline-accent">${esc(b.service)}</button>`
    : mono(esc(b.service)))}</span>`).join('')
    + (hd.length ? `<span class="block text-xs text-fg-soft">${t`segurando ${mono(esc(names(hd)))}`}</span>` : '');
}
```

   No `row()`:
   - calcular `const bl = blockers(c, data), hd = holds(c, data)`;
   - acrescentar `bl.map(b => [b.service, b.state, b.c?.ID])` e `hd.map(x => x.ID)` à assinatura;
   - passar os dois para o `rowHtml(c, withProject, bl, hd)`.

   No `rowHtml`, depois do `${tailBtn}`: `${b ? '' : depHtml(bl, hd)}`.

5. O subtítulo da faixa (`bandHead`, 576): "healthcheck falhando, loop de reinício, saída com erro ou dependência quebrada", com a chave antiga trocada no `en.json` ("failing healthcheck, restart loop, exit with an error or a broken dependency").

6. `src/en.json`: as 4 frases do `DEP_TXT`, mais `Abrir logs de {0}` e `segurando {0}`. Depois, `python3 build.py --css`.

**Plano de teste:**
- `npx tsc -p .`, `npm run test:js` e `python -m unittest` (com o `test_i18n`) verdes.
- `python3 build.py --css --check` limpo.
- A suíte E2E de hoje continua verde (a faixa de quem não usa `depends_on` não muda).

---

## T3. E2E

**Escopo:** a fixture `compose()` ganha o `depends_on`, e entram casos E2E da faixa, da anotação, do link e da notificação. Tudo nos dois backends.

**Contexto:** techspec, "Estratégia de teste". O E2E prova o RF1.1 a RF1.5, o RF2.1, o RF2.2 e o RF3.1 contra o docker falso, que já passa os labels sem mexer (o split dele só quebra antes de `,chave=`).

**Skills a carregar:** `tdd`; `systematic-debugging`, se os backends divergirem.

**Regras a respeitar:**
- Pular um spec no Rust não é correção.
- O E2E usa o Chrome do sistema (`PW_CHROMIUM_PATH=/usr/bin/google-chrome`), porque o Chromium do Playwright não está instalado nesta máquina.

**Steps:**

1. `tests/e2e/fixtures.ts`, com o `depends_on` primeiro, como o `docker ps` ordena os labels:

```ts
export const compose = (project: string, service: string, depends = '') =>
  `${depends ? `com.docker.compose.depends_on=${depends},` : ''}com.docker.compose.project=${project},com.docker.compose.service=${service}`;
```

2. `tests/e2e/compose.spec.ts`, com casos novos:
   - **Causa-raiz:** `db` "Up 1 minute (unhealthy)" e `api` "Created" com `db:service_healthy:false`.
     - `rowKeys` começa com `h:attn`, `c:<db>` e `c:<api>` (o `db` antes da `api`, apesar da ordem alfabética);
     - a linha da `api` tem "depende de db, que está com healthcheck falhando";
     - a do `db` tem "segurando api";
     - clicar em "Abrir logs de db" abre o modal com `#lt` = `db`.
     - Com `gui.update`, o `db` vira "Up 2 minutes (healthy)": a anotação some e a `api` sai da faixa.
   - **`migrate`:** com `service_completed_successfully`, um `migrate` "Exited (0)" e a `api` "Up" não geram anotação nem faixa. Com o `migrate` "Exited (1)" e a `api` "Created", a `api` mostra "depende de migrate, que saiu com erro".
   - **Dependência sem container:** `api` "Created" com `cache:service_started:false` e sem nenhum container `cache`. A linha mostra "depende de cache, que não tem container", sem botão.
   - **Espera normal do up:** `db` "Up 2 seconds (health: starting)" e `api` "Created": nenhuma faixa (`#rows` sem `h:attn`).

3. `tests/e2e/notifications.spec.ts`: com as notificações ligadas, `db` e `api` entram juntos (o `db` cai para unhealthy e a `api` é criada segurada). A notificação é `['2 containers precisam de atenção', 'db, api']`, com a raiz primeiro.

4. Rodar `npx playwright test tests/e2e/compose.spec.ts tests/e2e/notifications.spec.ts tests/e2e/problems.spec.ts` com o Python e com o Rust (`npm run test:e2e:rust`), e depois a suíte inteira nos dois.

**Plano de teste:**
- A suíte E2E inteira verde nos dois backends.
- `npm run test:js`, `python -m unittest` e `python3 build.py --css --check` verdes.
