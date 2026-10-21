# Tasks: Histórico do healthcheck

Lote em 3 tasks, nesta ordem: funções puras → tela → contrato e E2E. Os backends não mudam (techspec, "Resumo executivo").

---

## T1. Funções puras dos probes no `format.ts`

**Escopo:** tipo `Probe` e as funções `probeResult`, `probeDuration` e `healthSummary`, com testes no `node:test`.

**Contexto:** o techspec ("Interfaces principais") põe a lógica testável no `format.ts`. O `format.ts` devolve **dados**, não HTML: o `topTable` devolve células, e quem desenha é o `topHtml` do `app.ts`. Por isso a tabela HTML vai para a T2 (`healthHtml` no `app.ts`), seguindo esse padrão. O techspec é ajustado junto (Histórico).

**Skills a carregar:** `tdd`.

**Regras a respeitar:**
- O `format.ts` não toca no DOM (cabeçalho do arquivo).
- Os textos passam pelo `t```, e o `tests/test_i18n.py` exige a chave no `src/en.json`.

**Steps:**

1. Testes primeiro, em `tests/format.test.js` (o vermelho):

```js
const p = (ExitCode, Start, End, Output = '') => ({ExitCode, Start, End, Output});
test('probeResult separa passou, falhou e não rodou', () => {
  assert.equal(f.probeResult(p(0)), 'ok');
  assert.equal(f.probeResult(p(1)), 'fail');
  assert.equal(f.probeResult(p(-1)), 'error');   // timeout ou não conseguiu rodar
  assert.equal(f.probeResult(p(2)), 'error');
});
test('probeDuration lê o RFC 3339 do docker com nanossegundos', () => {
  assert.equal(f.probeDuration(p(0, '2026-10-21T13:00:00.123456789Z', '2026-10-21T13:00:00.456789012Z')), 333);
  assert.equal(f.probeDuration(p(0, '2026-10-21T10:00:00.1-03:00', '2026-10-21T13:00:01.1Z')), 1000);
  assert.equal(f.probeDuration(p(0, '2026-10-21T13:00:00Z', '')), null);
  assert.equal(f.probeDuration(p(0, '2026-10-21T13:00:01Z', '2026-10-21T13:00:00Z')), null);  // fim antes do início
});
test('healthSummary conta as falhas', () => {
  assert.equal(f.healthSummary([p(1), p(0), p(1), p(-1), p(0)]), '3 de 5 falharam');
  assert.equal(f.healthSummary([p(0), p(0)]), 'as 2 passaram');
  assert.equal(f.healthSummary([]), '');
});
```

2. No `src/format.ts`, junto do `topTable`:

```ts
// um probe do healthcheck, como o `inspect` guarda (as 5 últimas execuções, a mais velha primeiro)
export type Probe = {Start: string; End: string; ExitCode: number; Output: string};
// o docker usa 1 para "falhou" e -1 para timeout ou probe que nem rodou; outro código também é "não rodou como esperado"
export const probeResult = (p: Probe): 'ok' | 'fail' | 'error' => p.ExitCode === 0 ? 'ok' : p.ExitCode === 1 ? 'fail' : 'error';
// o Date.parse não garante mais de 3 casas na fração: corta os nanossegundos
const ms = (s: string) => Date.parse(s.replace(/(\.\d{3})\d+/, '$1'));
export function probeDuration(p: Probe): number | null {
  const d = ms(p.End) - ms(p.Start);
  return Number.isFinite(d) && d >= 0 ? d : null;
}
export function healthSummary(log: Probe[]): string {
  const bad = log.filter(p => probeResult(p) !== 'ok').length;
  return !log.length ? '' : bad ? t`${bad} de ${log.length} falharam` : t`as ${log.length} passaram`;
}
```

3. No `src/en.json`: `"{0} de {1} falharam": "{0} of {1} failed"` e `"as {0} passaram": "all {0} passed"`.

**Plano de teste:**
- `npm run test:js` verde.
- `npx tsc -p .` sem erro.
- `python -m unittest tests.test_i18n` verde.

---

## T2. Tabela dos probes no modal de logs

**Escopo:** o cache `health` passa a guardar o `Log` inteiro. A linha da lista continua mostrando só o último probe. O modal troca "Último healthcheck:" pela tabela, com resumo, saída limitada a 3 linhas, expandir, copiar e atualizar.

**Contexto:** PRD, RF1.1 a RF1.6 e RF2.1. O techspec põe a tabela no `#dlg-status`, no lugar da linha de hoje.

O RF2.2 (atualizar com o ao vivo) já é atendido pelo cache: a chave é `ID+Status`, então uma mudança de saúde troca o `Status`. Isso vale também para o "Up 5 minutes" → "Up 6 minutes" (o `rerender.spec.ts` já conta com isso). Por isso, nada de handler de evento novo. O techspec é ajustado junto.

**Skills a carregar:** `frontend-design:frontend-design`, para a tabela seguir o DESIGN.md (tokens, `TONE`, foco visível).

**Regras a respeitar:**
- A saída do container é texto não confiável: tudo passa por `esc`.
- O resultado vai em cor **e** texto (WCAG 2.2 AA).
- Os handlers usados em `onclick` entram no `Object.assign(window, …)`.
- O `build.py` regenera o `docker_gui.py` e a página do desktop; o CI roda o `--check`.

**Steps:**

1. Tipos em `src/app.ts` (linha 38): `type Health = {Log?: Probe[]} | null`, importando `Probe`, `probeResult`, `probeDuration` e `healthSummary` do `format.ts`.

2. O cache guarda os probes (do mais novo para o mais velho), ou o texto do erro:

```ts
const health: Record<string, Probe[] | string> = {};  // ID+Status -> probes (mais novo primeiro) ou o erro
async function loadHealth(id: string) {
  const c = data.find(c => c.ID === id);
  if (!c || health[id + c.Status]) return;
  let v: Probe[] | string;
  try {
    const r = await api('/api/health/' + id), h: unknown = await r.json();
    v = r.ok ? [...((h as Health)?.Log ?? [])].reverse() : t`Não consegui ler o healthcheck: ${h}`;
  } catch { v = t`Não consegui ler o healthcheck.`; }
  health[id + c.Status] = v;
  render();
}
// a linha da lista mostra só o último, como hoje
const lastProbe = (v: Probe[] | string) => typeof v === 'string' ? v
  : v[0] ? t`código ${v[0].ExitCode} · ${v[0].Output.trim() || t`(sem saída)`}` : t`Nenhum probe rodou ainda.`;
```

   O `healthBox` da linha (504) passa a usar `lastProbe(health[...])`. A assinatura do `patchRows` (435) já inclui `health[c.ID + c.Status]`, e com um array o `JSON.stringify` continua comparando certo.

3. A tabela, no estilo do `topHtml` e do `historyHtml`:

```ts
const PROBE: Record<ReturnType<typeof probeResult>, [string, keyof typeof TONE]> =
  {ok: [t`passou`, 'ok'], fail: [t`falhou`, 'bad'], error: [t`não rodou como esperado`, 'warn']};
function healthHtml(id: string, v: Probe[] | string) {
  if (typeof v === 'string') return `<p class="text-bad-fg">${esc(v)}</p>`;
  if (!v.length) return `<p class="text-muted">${t`Nenhum probe rodou ainda.`}</p>`;
  const time = (s: string) => new Date(Date.parse(s.replace(/(\.\d{3})\d+/, '$1')))
    .toLocaleTimeString(LOCALE, {hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false});
  const dur = (d: number | null) => d === null ? '' : d < 1000 ? `${d} ms` : `${(d / 1000).toLocaleString(LOCALE, {maximumFractionDigits: 1})} s`;
  const rows = v.map((p, i) => {
    const [txt, tn] = PROBE[probeResult(p)], lines = p.Output.trimEnd().split('\n'), head = lines.slice(0, 3).join('\n');
    const rest = lines.length > 3 ? `<details><summary class="cursor-pointer text-muted hover:text-fg">${t`mais ${lines.length - 3} linhas`}</summary><pre class="whitespace-pre-wrap [overflow-wrap:anywhere]">${esc(lines.slice(3).join('\n'))}</pre></details>` : '';
    return `<tr class="align-top"><td class="pr-3 text-muted whitespace-nowrap">${time(p.Start)}</td><td class="pr-3 text-muted whitespace-nowrap">${dur(probeDuration(p))}</td>
      <td class="pr-3 whitespace-nowrap ${TONE[tn][1]}">${txt} · ${p.ExitCode}</td>
      <td class="[overflow-wrap:anywhere]"><pre class="whitespace-pre-wrap">${esc(head) || `<span class="text-muted">${t`(sem saída)`}</span>`}</pre>${rest}</td>
      <td><button onclick="copyProbe('${id}', ${i})" aria-label="${t`Copiar a saída do probe das ${time(p.Start)}`}" class="…">${t`Copiar`}</button></td></tr>`;
  }).join('');
  return `<div class="flex items-center gap-2"><span class="font-sans">${t`Healthcheck`}</span><span class="text-fg-soft">${esc(healthSummary(v))}</span>
    <button onclick="reloadHealth('${id}')" aria-label="${t`Atualizar o healthcheck`}" class="…">↻</button></div>
    <table class="mt-1 font-mono max-h-40 overflow-auto block"><caption class="sr-only">${t`Últimos probes do healthcheck, do mais novo para o mais velho`}</caption><tbody>${rows}</tbody></table>`;
}
```

   As classes `…` dos botões copiam as do `copyLogs` e do botão de fechar do modal (foco visível, `coarse:` com alvo de 44 px). A conversão de horário fica aqui porque é só formatação de tela, como o `when` do `historyHtml`.

4. Os handlers, perto do `copyLogs` (1469):

```ts
function copyProbe(id: string, i: number) {
  const c = data.find(c => c.ID === id), v = c && health[id + c.Status];
  if (!Array.isArray(v) || !v[i]) return;
  navigator.clipboard.writeText(v[i].Output).then(() => toast(t`Saída do probe copiada.`, true), () => toast(t`Não consegui copiar.`));
}
function reloadHealth(id: string) {
  const c = data.find(c => c.ID === id);
  if (c) { delete health[id + c.Status]; loadHealth(id); }
}
```

   Os dois entram no `Object.assign(window, {…})` (1921). Se o texto de erro do copiar já existir em outro lugar, ele é reaproveitado.

5. `renderDlg` (1137 a 1146): `h` passa a ser `hasHealth(c) && health[c.ID + c.Status]`. A linha `Último healthcheck:` vira `<div class="mt-2 text-xs">${healthHtml(c.ID, h)}</div>`, com o mesmo `if (hasHealth(c) && !h) loadHealth(c.ID)`. O `sm:truncate` e o `title` saem, porque a tabela já mostra tudo.

6. `src/en.json`:
   - chaves novas: `passou`, `falhou`, `não rodou como esperado`, `mais {0} linhas`, `Copiar a saída do probe das {0}`, `Healthcheck`, `Atualizar o healthcheck`, `Últimos probes do healthcheck, do mais novo para o mais velho` e `Saída do probe copiada.`;
   - `Último healthcheck:` sai do `en.json`, e também da tabela EN do Python e do Rust, se estiver lá só por causa da página (o `test_i18n` acusa a chave órfã).

7. `python3 build.py --css` regenera o `docker_gui.py` e o `src-tauri/dist/index.html`.

**Plano de teste:**
- `npx tsc -p .`, `npm run test:js` e `python -m unittest` (inclui o `test_i18n`) verdes.
- `python3 build.py --css --check` limpo.
- A conferência na tela fica com a T3.

---

## T3. Contrato e E2E

**Escopo:** o caso de contrato `health.json` passa a trazer `Start` e `End`. Os E2E de healthcheck são atualizados para a tabela, e entram dois casos novos.

**Contexto:** techspec, "Estratégia de teste". O contrato documenta que os dois backends passam o `Log` adiante sem cortar campos. O E2E prova o RF1.1 a RF1.5 nas duas versões (`GUI_BACKEND=python|rust`).

**Skills a carregar:** `tdd`; `systematic-debugging`, se algum spec divergir entre os backends.

**Regras a respeitar:**
- Pular um spec no Rust não é correção (techspec do desktop, `no-workarounds`).
- O docker falso continua devolvendo `c.health` como está.

**Steps:**

1. `tests/contract/reads/health.json`: o `stdout` e o `response.body` ganham `"Start": "2026-10-21T13:00:00.123456789Z"` e `"End": "2026-10-21T13:00:00.456789012Z"` no item do `Log`. Rodar `python -m unittest tests.test_contract` e `cargo test -p stivo-core` (contrato).

2. `tests/e2e/logs.spec.ts`:
   - o `unhealthy` ganha `Start` e `End` no probe;
   - o teste "saída do último healthcheck na linha e no modal" mantém a conferência da linha (`código 1 · curl: (7) …`) e, no modal, passa a conferir `#dlg-status` com "Healthcheck 1 de 1 falharam", uma linha da tabela com "falhou · 1" e a saída.

3. Teste novo em `logs.spec.ts`: 5 probes (falha, ok, falha, -1, ok, da mais velha para a mais nova) e um deles com 5 linhas de saída. O teste confere:
   - o resumo "3 de 5 falharam";
   - 5 linhas, a primeira com o horário do último probe;
   - "não rodou como esperado · -1";
   - a saída longa mostrando 3 linhas e "mais 2 linhas", que expande;
   - o "Copiar" da primeira linha põe a saída no clipboard (`context.grantPermissions(['clipboard-read'])`, como o teste do `copyLogs`, se ele existir).

4. Teste novo: "↻" relê. O teste muda o `health` no docker falso (`gui.update`) sem mudar o `Status`, clica no ↻ e confere a linha nova.

5. O teste "healthcheck que ainda não rodou" continua como está: a linha usa o `lastProbe`.

6. Rodar `npx playwright test tests/e2e/logs.spec.ts tests/e2e/rerender.spec.ts` com `GUI_BACKEND=python` e depois com `npm run test:e2e:rust`.

**Plano de teste:**
- A suíte E2E inteira verde nos dois backends.
- `python -m unittest`, `cargo test -p stivo-core` e `npm run test:js` verdes.
- `python3 build.py --css --check` limpo.
