---
name: feature-prints
description: Tira prints recortados de uma feature de front funcionando no app local e edita as imagens com caixas, setas e rótulos explicando o uso, prontas para anexar na PR. Use quando o usuário pedir prints, screenshots, capturas ou evidência visual de uma feature ("tira print disso", "coloca prints na PR", "mostra a feature funcionando", "faz uma imagem explicando a tela nova"), e ofereça ao terminar uma mudança visível na tela antes de abrir ou atualizar a PR. A skill começa decidindo se a mudança tem algo visual para mostrar; refatoração sem efeito na tela, backend, testes, tipos ou config não geram prints.
---

# Prints de feature com anotações

Gera imagens PNG de uma feature sendo usada, recortadas só na área que importa, com anotações em vermelho (caixa tracejada, seta e rótulo numerado) que explicam o que mudou. Serve para quem revisa a PR entender a mudança sem rodar o app.

## 1. Decidir se vale a pena

Antes de abrir o navegador, olhe o diff e responda: existe algo que uma pessoa veria diferente na tela?

| Vale print                                              | Não vale print                     |
| ------------------------------------------------------- | ---------------------------------- |
| Botão, menu, dialog, barra ou tela nova                 | Refatoração sem mudança visual     |
| Novo fluxo de interação (atalho, seleção, arrastar)     | Backend, rota, use case, migration |
| Mudança de layout, responsivo, estados vazios e de erro | Testes, tipos, lint, config, CI    |
| Texto ou dado novo exibido na interface                 | Performance sem efeito perceptível |

Se nada for visual, diga isso ao usuário em uma frase, com o motivo, e pare. Se só parte da mudança for visual (por exemplo, rota nova no backend mais um botão no front), capture só a parte visível e deixe claro o que ficou de fora.

## 2. Planejar as cenas

Uma cena é uma imagem que mostra uma coisa sendo usada. Duas ou três cenas por feature costumam bastar, e mais do que cinco vira ruído. Para cada cena, defina:

- o estado que precisa estar na tela (menu aberto, itens selecionados, dialog aberto);
- a região de recorte (o card ou a barra onde a feature vive, não a tela inteira);
- as anotações, em ordem de uso ("1 Clique em Relatórios", "2 Escolha a empresa").

Mostre o plano ao usuário em poucas linhas e siga. Pergunte antes só se houver dúvida real sobre o que mostrar.

Cenas nunca podem alterar dados. Monte estados de interface (abrir, selecionar, passar o mouse), e não clique em ações que gravam, enviam, baixam arquivo ou apagam. Se a cena ideal exigir dados que não existem (por exemplo, caixas preenchidas), capture com os dados disponíveis e avise o que a imagem não mostra.

## 3. Preparar o ambiente

1. Suba os servidores de dev pelo `preview_start` do projeto (`.claude/launch.json`), nunca pelo Bash.
2. Se cair na tela de login, peça ao usuário para entrar no painel do navegador. Não digite credenciais nem procure senha em arquivos do projeto.
3. Ajuste a janela com `resize_window` para um tamanho de computador, como 1440×900. Aumente a altura se a cena precisar de mais conteúdo visível ao mesmo tempo. Para features responsivas, capture também em 375 px (celular) e 768 px (tablet).

## 4. Servidor de captura

As capturas do `computer screenshot` chegam só como imagem para você, sem arquivo. Por isso a captura acontece dentro da página, com a biblioteca `html-to-image`, e um servidor local grava o PNG no disco.

1. Confirme que o front tem a biblioteca: `ls <raiz-do-front>/node_modules/html-to-image/dist/html-to-image.js`. Se não tiver, pergunte ao usuário antes de instalar qualquer coisa, porque isso altera as dependências do projeto.
2. Suba o servidor em segundo plano (`run_in_background: true`), gravando no scratchpad da sessão:

   ```bash
   node <raiz-deste-repo>/.claude/skills/feature-prints/scripts/capture-server.cjs <scratchpad>/prints <raiz-do-front> http://localhost:<porta-do-app> 3999
   ```

   Ele escuta só em `127.0.0.1`, aceita requisições apenas da origem do app, entrega `/lib.js` (a biblioteca) e `/helpers.js` (os helpers desta skill) e grava o que receber em `POST /save`.

3. Injete os dois scripts na aba do app com `javascript_tool`:

   ```js
   for (const src of ["http://localhost:3999/lib.js", "http://localhost:3999/helpers.js"]) {
     await new Promise((resolve, reject) => {
       const script = document.createElement("script");
       script.src = src;
       script.onload = resolve;
       script.onerror = reject;
       document.head.appendChild(script);
     });
   }
   ({ lib: typeof window.htmlToImage?.toCanvas, helpers: typeof window.__cap?.shot });
   ```

   Uma navegação ou um reload apagam os scripts. Injete de novo depois de cada `navigate`.

## 5. Montar a cena

Os helpers ficam em `window.__cap`. Quatro armadilhas já apareceram e custam retrabalho:

- **Clique por coordenada erra** quando a janela emulada é maior que o painel, porque a imagem é reduzida. Dirija a cena pelo DOM:
  - `__cap.pointerDown(el)` abre triggers do Radix (dropdown, select, popover);
  - `__cap.click(el)` abre submenus e aciona botões;
  - `__cap.click(el, { shiftKey: true })` ou `{ ctrlKey: true }` simula atalhos de teclado com clique;
  - `__cap.byText('button', 'Relatórios')` encontra elementos pelo texto.
- **A rolagem desalinha o recorte.** O `html-to-image` redesenha a página a partir do topo, enquanto menus e barras fixas ficam na posição da tela. Mantenha `scrollY` em 0: recolha seções acima (accordions, quadros) ou aumente a altura da janela, em vez de rolar. O `shot` recusa capturar se a página estiver rolada. Se um menu abrir e rolar a página, rode `window.scrollTo(0, 0)` depois de abrir; o Radix reposiciona o menu sozinho.
- **Animações ficam travadas no começo.** Com o painel sem foco, a animação de entrada do Radix para em opacidade 0 e o menu some da imagem. O `shot` chama `__cap.freezeAnimations()` antes de capturar, fixando menus, dialogs e tooltips no estado final. Se criar outro tipo de sobreposição animada, chame antes também.
- **Dados ainda carregando** aparecem como skeleton. Espere o conteúdo com `await __cap.waitFor(() => condição)` antes de capturar.
- **Uma chamada longa estoura o tempo do `javascript_tool`** (cerca de 45 s). Separe em chamadas curtas: injetar os scripts, montar a cena e capturar. A primeira captura da página demora mais, porque a biblioteca embute fontes e imagens. Se ela passar de alguns segundos, dispare o `shot` sem `await`, guardando o resultado (`__cap.shot(...).then((r) => (window.__res = r)).catch((e) => (window.__res = String(e)))`), e leia `window.__res` numa chamada seguinte.

## 6. Capturar e anotar

```js
const trigger = __cap.byText("button", "Relatórios");
const [menu, submenu] = document.querySelectorAll('[role="menu"]');
const card = __cap.rect(__cap.byText("p", "Conferência de Lote").closest(".w-full"));
const t = __cap.rect(trigger);
const s = __cap.rect(submenu);
const label = __cap.measureLabel(["1  Relatórios antes de enviar"]);
const at = { x: t.left - label.width - 60, y: t.top + 2 };

await __cap.shot(
  "1-relatorios",
  __cap.union(card, menu, submenu),
  [
    { box: t },
    { box: s },
    {
      from: { x: at.x + label.width + 4, y: at.y + 14 },
      to: { x: t.left - 9, y: t.top + t.height / 2 }
    },
    { label: ["1  Relatórios antes de enviar"], at }
  ],
  { pad: 12 }
);
```

- `shot(nome, região, anotações, opções)` recorta a região e desenha as anotações em coordenadas da tela, em pixels CSS. As opções são `pad` (folga ao redor, 16 por padrão), `marginRight` e `marginBottom` (área extra de fundo neutro para rótulos) e `ratio` (densidade, 2 por padrão).
- Tipos de anotação:
  - `{ box }`: caixa tracejada ao redor de um retângulo;
  - `{ from, to }`: seta com ponta;
  - `{ from, to, noHead: true }`: traço sem ponta, para montar setas em cotovelo;
  - `{ label: [linhas], at }`: rótulo vermelho de uma ou mais linhas.
- `measureLabel(linhas)` devolve a largura e a altura do rótulo, para posicionar a seta encostada nele.

Boas práticas que deixaram as imagens legíveis:

- Numere os rótulos na ordem de uso ("1", "2") e escreva frases curtas, de no máximo duas linhas.
- Não cubra dados com rótulos. Quando o recorte não tiver espaço livre, use `marginRight` e escreva os rótulos na margem, com a seta apontando para dentro.
- Caixa tracejada no elemento e seta até ele; uma cor só (vermelho) para todas as anotações.
- Quando uma seta reta atravessaria outro botão, faça um cotovelo com um traço `noHead` e uma seta curta.
- Nomeie os arquivos com número e assunto, na ordem em que vão aparecer: `1-relatorios-liberar-exportacao`, `2-selecao-shift-ctrl`.

## 7. Conferir cada imagem

Abra cada PNG com `Read` antes de entregar. Refaça a cena quando:

- menus ou barras aparecem deslocados em relação ao conteúdo (a página estava rolada);
- um menu aberto não aparece (animação travada ou menu fechado);
- um rótulo ficou cortado na borda do recorte;
- aparece skeleton ou dado incompleto;
- a anotação cobre informação importante.

Uma captura de teste da tela inteira no começo (`__cap.shot('teste', { left: 0, top: 0, width: innerWidth, height: innerHeight }, [], { pad: 0 })`) confirma que fontes e cores saem fiéis. Apague essa imagem depois.

## 8. Limpar

- Feche menus e desfaça seleções que a cena criou.
- Volte a janela ao normal com `resize_window` no preset `desktop`.
- Apague as imagens de teste.
- Pare o servidor de captura com `TaskStop`, usando o id da tarefa em segundo plano. Evite `pkill -f` com o nome do script, porque ele também encerra o próprio comando.

## 9. Entregar

1. Envie os PNGs com `SendUserFile` (`display: "attach"`) e descreva em uma linha o que cada um mostra e o que ficou de fora.
2. O `gh` não anexa imagens à descrição da PR; o GitHub só aceita upload pelo navegador. O caminho padrão é o usuário arrastar os arquivos. Entregue um trecho pronto para o fim da descrição da PR:

   ```markdown
   ## Prints

   **<o que a cena 1 mostra>**

   <!-- arraste 1-<nome>.png aqui -->

   **<o que a cena 2 mostra>**

   <!-- arraste 2-<nome>.png aqui -->
   ```

3. Só publique as imagens em outro lugar (por exemplo, numa branch separada de assets no repositório) se o usuário pedir explicitamente, porque isso cria algo novo no repositório da organização.
