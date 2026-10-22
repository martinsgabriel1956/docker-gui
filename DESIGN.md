---
name: Stivo
description: O docker ps que cresceu, no navegador, para o ciclo mudar → reiniciar → ler logs.
colors:
  canvas: "oklch(16% 0.012 255)"
  raised: "oklch(20.5% 0.014 255)"
  hover: "oklch(26% 0.016 255)"
  line: "oklch(27% 0.014 255)"
  line-strong: "oklch(37% 0.018 255)"
  dim: "oklch(58% 0.02 255)"
  muted: "oklch(72% 0.02 255)"
  fg-soft: "oklch(86% 0.012 255)"
  fg: "oklch(92% 0.008 255)"
  fg-strong: "oklch(97% 0.004 255)"
  accent: "oklch(80% 0.12 200)"
  accent-fg: "oklch(86% 0.09 200)"
  accent-soft: "oklch(92% 0.05 200)"
  ok: "oklch(78% 0.17 148)"
  ok-fg: "oklch(85% 0.14 148)"
  ok-soft: "oklch(91% 0.08 148)"
  warn: "oklch(84% 0.16 92)"
  warn-fg: "oklch(88% 0.14 95)"
  warn-soft: "oklch(92.5% 0.1 97)"
  warn-strong: "oklch(96% 0.05 97)"
  bad: "oklch(69% 0.19 25)"
  bad-fg: "oklch(79% 0.11 22)"
  bad-soft: "oklch(88% 0.05 20)"
  danger: "oklch(52% 0.2 27)"
  danger-hover: "oklch(46% 0.18 27)"
  pause: "oklch(72% 0.17 330)"
  pause-fg: "oklch(82% 0.11 330)"
  svc-1: "oklch(82% 0.11 55)"
  svc-2: "oklch(82% 0.09 355)"
  svc-3: "oklch(78% 0.11 250)"
  svc-4: "oklch(78% 0.11 295)"
typography:
  title:
    fontFamily: "ui-sans-serif, system-ui, sans-serif"
    fontSize: "1.5rem"
    fontWeight: 600
    lineHeight: 1.333
    letterSpacing: "-0.025em"
  headline:
    fontFamily: "ui-sans-serif, system-ui, sans-serif"
    fontSize: "1.125rem"
    fontWeight: 600
    lineHeight: 1.556
  body:
    fontFamily: "ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 400
    lineHeight: 1.429
  label:
    fontFamily: "ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.75rem"
    fontWeight: 500
    lineHeight: 1.333
  data:
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace"
    fontSize: "0.8125rem"
    fontWeight: 400
    lineHeight: "1.25rem"
  data-small:
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace"
    fontSize: "0.75rem"
    fontWeight: 400
    lineHeight: 1.625
  group:
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace"
    fontSize: "1rem"
    fontWeight: 600
    lineHeight: "1.5rem"
  column-header:
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace"
    fontSize: "11px"
    fontWeight: 500
    letterSpacing: "normal"
rounded:
  control: "4px"
  surface: "8px"
  strip-block: "1px"
spacing:
  gap-tight: "6px"
  gap: "12px"
  gutter: "16px"
  row-y: "12px"
  touch-min: "44px"
components:
  button:
    textColor: "{colors.fg}"
    typography: "{typography.label}"
    rounded: "{rounded.control}"
    padding: "4px 10px"
  button-hover:
    backgroundColor: "{colors.hover}"
  button-primary:
    textColor: "{colors.accent-fg}"
    typography: "{typography.label}"
    rounded: "{rounded.control}"
    padding: "4px 10px"
  button-start:
    textColor: "{colors.ok-fg}"
    rounded: "{rounded.control}"
    padding: "4px 10px"
  button-danger:
    backgroundColor: "{colors.danger}"
    textColor: "#ffffff"
    rounded: "{rounded.control}"
    padding: "4px 10px"
  button-danger-hover:
    backgroundColor: "{colors.danger-hover}"
  button-ghost:
    textColor: "{colors.fg-soft}"
    rounded: "{rounded.control}"
    padding: "4px 10px"
  input:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.fg-strong}"
    typography: "{typography.body}"
    rounded: "{rounded.control}"
    padding: "8px 12px"
  input-search:
    backgroundColor: "{colors.raised}"
    textColor: "{colors.fg-strong}"
    typography: "{typography.body}"
    rounded: "{rounded.control}"
    padding: "8px 12px"
  tab:
    textColor: "{colors.muted}"
    typography: "{typography.body}"
    padding: "8px 12px"
  tab-selected:
    textColor: "{colors.fg-strong}"
  object-name:
    textColor: "{colors.fg-strong}"
    typography: "{typography.data}"
  object-cell:
    textColor: "{colors.muted}"
    typography: "{typography.data-small}"
  count-segment:
    textColor: "{colors.fg}"
    typography: "{typography.data}"
    padding: "2px 8px"
  count-segment-active:
    backgroundColor: "{colors.fg-strong}"
    textColor: "{colors.canvas}"
  port-link:
    textColor: "{colors.accent-fg}"
    typography: "{typography.data-small}"
    rounded: "{rounded.control}"
    padding: "2px 4px"
  group-header:
    backgroundColor: "{colors.raised}"
    textColor: "{colors.fg-strong}"
    typography: "{typography.group}"
    padding: "12px 16px 10px"
  attention-band:
    textColor: "{colors.bad-fg}"
    typography: "{typography.data-small}"
    padding: "16px 16px 8px"
  surface:
    backgroundColor: "{colors.raised}"
    rounded: "{rounded.surface}"
  compose-output:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.fg-soft}"
    typography: "{typography.data-small}"
    rounded: "{rounded.control}"
    padding: "8px"
  compose-output-failed:
    textColor: "{colors.bad-fg}"
---

# Design System: Stivo

## Overview

**Creative North Star: "O terminal evoluído"**

A página é o `docker ps` que cresceu. Os dados (nomes, status, imagens, portas, cabeçalhos de coluna, logs) ficam no mono do sistema, no ritmo de colunas do CLI; a moldura (títulos, botões, formulários, avisos) fica no sans do sistema. O estado é escrito como texto ("Saiu com código 137 há 2 min") e a cor é reservada para ele: verde, amarelo, vermelho e magenta do ANSI, reafinados em OKLCH, sobre um chão grafite frio. O único acento é ciano, a cor do cursor.

A densidade é de ferramenta, não de painel: linhas de 12px de respiro, controles de 4px de raio, anéis de 1px no lugar de bordas e sombras, nenhuma pílula. O que quebrou sobe para uma faixa própria em chão vermelho, com a causa traduzida e a última linha do log; o resto se agrupa por projeto compose. Imagens, volumes e redes ficam em abas próprias, em tabelas mono no ritmo do `docker images`, `docker volume ls` e `docker network ls`. Dois temas com os mesmos tokens: escuro por padrão, claro sob `prefers-color-scheme: light`.

Recusa confirmada: o painel admin de fábrica (zinc + sky do Tailwind, pílulas de status, cubo isométrico, rótulos uppercase em sans).

**Key Characteristics:**
- Dados em mono, moldura em sans; uppercase só em mono, como o cabeçalho do `docker ps`.
- Cor é estado. O ciano é o único acento e marca o que é interativo ou ao vivo.
- Plano: profundidade por tom (canvas → raised → hover) e anéis de 1px; sombra só no que flutua.
- Raio de 4px nos controles, 8px nas superfícies.
- A faixa de estado do projeto compose é a assinatura.

## Colors

Paleta de terminal ANSI reafinada: grafite frio de croma baixo (matiz 255) para chão e texto, quatro estados ANSI e um acento ciano. Os valores do tema claro vivem em `src/theme.css` sob o mesmo nome; o contraste foi conferido para WCAG AA contra canvas, raised e hover nos dois temas.

### Primary
- **Ciano Cursor** (accent): o único acento. Anel e fundo translúcido do botão primário ("+ Novo container", "Criar e iniciar"), anel de foco de tudo, sublinhado de 2px da aba selecionada, realce do filtro nos logs e seleção de texto (`accent/30`), linha da sparkline de CPU/RAM, parte liberável da barra de disco, ponto do "Ao vivo", `caret-color`. **accent-fg** pinta texto de link (portas abríveis, "Limpar filtros"); **accent-soft** é o hover desse texto e o texto do "Ao vivo" pressionado.

### Secondary
- **Verde Rodando** (ok / ok-fg / ok-soft): ponto e texto de "rodando bem", ponto do indicador "ao vivo", texto dos botões Iniciar. `ok/40` + ok-soft é o estado "verificando saúde".
- **Amarelo Atenção** (warn / warn-fg / warn-soft / warn-strong): healthcheck falhando, aviso de daemon remoto (faixa fixa no topo em `warn/15`). No tema claro o matiz desce para âmbar (68 a 70) para continuar legível no branco.
- **Vermelho Falha** (bad / bad-fg / bad-soft): ponto e texto de containers com problema, chão da faixa de atenção (`bad/10`), erros de campo, nota da confirmação armada, itens destrutivos dos menus.
- **Vermelho Destrutivo** (danger / danger-hover): só o botão armado da confirmação em 2 passos e o checkbox de publicar em 0.0.0.0. É mais escuro que bad para carregar texto branco.
- **Magenta Pausa** (pause / pause-fg): containers pausados.

### Tertiary
- **Tons de serviço** (svc-1 a svc-4): prefixo do serviço nos logs do projeto compose. Laranja, rosa, azul e violeta: nenhum é tom de status nem o acento, para um serviço que caiu não sair verde. A cor vai pela ordem em que o serviço aparece (os quatro primeiros nunca repetem), réplicas herdam a do serviço e a atribuição fica guardada por projeto, para reabrir os logs não trocar as cores.

### Neutral
- **Grafite Chão** (canvas): fundo da página e dos campos de texto.
- **Grafite Superfície** (raised): cabeçalho da página com as abas, cabeçalhos de grupo, modais, menus, barras flutuantes e o campo de busca (que fica sobre o canvas). As tabelas e o disco usam `raised/40`.
- **Grafite Hover** (hover): hover de botões e itens de menu.
- **Linha** (line / line-strong): divisórias entre linhas (`line/70`), anéis de superfície (line), anéis de controle (`line-strong/80`), trilho da barra de disco, separador acima de grupo compose (line-strong).
- **Texto** (dim → muted → fg-soft → fg → fg-strong): dim só para marcas decorativas (o `›` da última linha do log, ponto de parado) e para o anel dos campos de texto, onde ele é limite e não texto (3:1 contra o chão nos dois temas); muted para metadados, imagens, cabeçalhos de coluna e timestamps; fg-soft é o corpo; fg é o texto de botão; fg-strong é nome de container, título e rótulo.

### Named Rules
**A Regra da Cor de Estado.** Verde, amarelo, vermelho e magenta só dizem estado do container (ou de um log). Nunca decoram, nunca marcam categoria. Se algo novo precisa se distinguir sem ser estado, ganha um tom próprio fora dessa família, como os svc-*.

**A Regra do Cursor Único.** O ciano é o único acento: interativo, ao vivo ou liberável. Não existe segundo acento.

**A Regra do Vermelho com Verbo.** O fundo vermelho sólido (danger) aparece só no segundo passo de uma ação destrutiva, e sempre com o verbo e o alvo escritos.

## Typography

**Body Font:** sans do sistema (ui-sans-serif, system-ui, sans-serif)
**Data Font:** mono do sistema (ui-monospace, SFMono-Regular, Menlo, Consolas, monospace)

**Character:** o mono carrega tudo o que o `docker` imprime; o sans carrega tudo o que a GUI diz. Fontes do sistema porque o produto é um arquivo só, offline, sem nada para baixar. O mono desenha maior que o sans, por isso o token `--text-data` (13px) em vez dos 14px do corpo.

### Hierarchy
- **Title** (600, 24px, tracking -0.025em; 20px abaixo de 640px): só o "Stivo" do cabeçalho, sem ícone.
- **Headline** (600, 18px): título dos modais ("Logs · shop-api-1", "Novo container").
- **Body** (400, 14px): botões do cabeçalho, campos, avisos, rótulos de formulário, rótulo das categorias do disco. As abas usam 14px em 500.
- **Label** (500, 12px): botões de linha e das ferramentas dos logs (14px no toque).
- **Data** (mono, 13px / 20px): nome do container e primeira coluna das tabelas de imagens, volumes e redes (600), linha de status, contagens por estado, status no modal.
- **Group** (mono, 600, 16px / 24px, token `--text-group`): o nome do projeto compose no cabeçalho do grupo. Um degrau acima dos nomes dos containers que ele agrupa: com o mesmo 13px, só o fundo separava o pai dos filhos.
- **Data small** (mono, 12px, line-height 1.625 nos logs): imagem, portas, CPU/RAM, contexto do docker, linhas de log, metadados do disco, demais células das tabelas de objetos, contagem das abas.
- **Column header** (mono, 500, 11px, uppercase): NOME IMAGEM STATUS PORTAS; IMAGEM ID TAMANHO CRIADA EM USO POR; VOLUME DRIVER EM USO POR; REDE DRIVER ESCOPO EM USO POR. A faixa de atenção usa o mesmo tratamento em 12px semibold.

### Named Rules
**A Regra do Uppercase em Mono.** Caixa alta só em mono, como cabeçalho de coluna do CLI. Nunca uppercase em sans.

**A Regra do Dado em Mono.** Se o texto viria do `docker` (nome, imagem, porta, status, comando, caminho), ele é mono, inclusive dentro de frases (`<code class="font-mono">`). Placeholders de campo mono voltam para sans.

## Layout

Coluna única centrada, largura máxima de 80rem, calha de 16px. Cabeçalho da página em superfície própria (raised), de ponta a ponta, com título, contexto e indicador ao vivo à esquerda e "Atalhos" à direita; as abas Containers / Imagens / Volumes / Redes ficam na borda de baixo dessa faixa, sobre o traço line dela. Na aba Containers, uma barra de ferramentas: "+ Novo container", contagens por estado e a busca (288px a partir de 640px) à direita; abaixo, a tabela num contêiner de 8px de raio. Nas abas Imagens e Volumes, o uso de disco (`docker system df`) vem em cima, num contêiner próprio (Imagens leva também os containers parados e o build cache), e a tabela de objetos embaixo; Redes só tem a tabela.

A tabela segue o ritmo de colunas do CLI: nome, imagem (truncada pela esquerda para manter a tag), status, portas, ações. A partir de 1280px são as 5 colunas, em `table-fixed` (nome 17rem, imagem 11rem, portas 10rem, ações 17.5rem; o status fica com o resto), para nada mudar de largura quando um healthcheck abre ou uma busca esvazia. Entre 640 e 1280px (a janela ao lado do editor) a tabela fica compacta: nome, status e ações, com a imagem e as portas descendo para baixo do nome. Quem decide é o `matchMedia` no app.ts, não duas cópias no DOM: cada porta existe uma vez para o Tab e o leitor de tela. A ordem é diagnóstico primeiro: faixa de atenção, depois cada projeto compose (com a saída do compose, quando houver, entre o cabeçalho e os containers), depois "Sem projeto compose". Ações de linha têm posição fixa por estado (Logs sempre no mesmo lugar). A linha de uso põe CPU e RAM cada um na sua linha abaixo de 1280px (o "·" some) e lado a lado a partir de 1280px.

Abaixo de 640px a tabela vira cards: o cabeçalho some (menos "Selecionar todos") e status e ações recuam até o nome. O alvo de 44px não depende da largura, e sim do ponteiro: `coarse:` (`@media (pointer: coarse)`) dá altura mínima de 44px a todo controle no toque, e com mouse a janela estreita continua densa como o terminal. As contagens rolam de lado em vez de quebrar. A barra da aba Containers reordena para a triagem vir primeiro: contagens, busca e, por último, "+ Novo container". Cada linha das tabelas de objetos vira um card, com cada célula rotulada "Coluna: valor". No toque as abas ganham 44px de altura; se faltar largura elas rolam de lado e esmaecem na borda direita enquanto há mais para ver (máscara ligada a `animation-timeline: scroll()`). O modal de logs vira tela cheia e Atualizar/Copiar/Baixar entram num menu "⋯".

Ritmo: 6px entre botões vizinhos, 12px entre elementos de uma linha, 12px vertical por linha de tabela, 16px de calha e de padding interno.

Barras flutuantes (ações em lote, a confirmação armada, toast) ficam no pé da tela, centradas, para a tabela não se mexer; a confirmação fica acima da barra de lote (`--bulk`) e a página ganha a folga das duas embaixo (`--dock`). A raiz tem `scrollbar-gutter: stable`: a barra de rolagem aparece sem empurrar a página de lado (o preço é uma faixa de 15px sem a cor da faixa do cabeçalho quando não há rolagem).

## Elevation & Depth

Plano por padrão. A profundidade vem do tom (canvas → raised → hover) e de anéis de 1px; não há bordas grossas nem sombras em repouso. Sombra só no que flutua sobre a página: menus, popover de atalhos, barra de lote, nota armada, toast. Modais escurecem o fundo (`black/70`; popover `black/40`).

### Shadow Vocabulary
- **Flutuante** (`box-shadow` do `shadow-lg` com cor `black/30` a `black/40`): menus "⋯", popover, barras do pé, toast.

### Named Rules
**A Regra do Anel, Não da Sombra.** Separação em repouso é anel de 1px (line ou line-strong). Sombra é só para o que flutua acima do fluxo.

## Shapes

Dois raios: 4px nos controles (botões, campos, segmentos de contagem, `kbd`, links de porta, selos) e 8px nas superfícies (tabela, disco, modais, menus, avisos, barras flutuantes). Os blocos da faixa de estado têm 1px. Círculos só para pontos de estado (8px) e o ponto do ao vivo (6px). No celular os modais perdem raio e anel e ocupam a tela.

**A Regra Sem Pílula.** Nada com raio cheio que carregue texto. Status é texto colorido com ponto; portas são texto mono; contagens são um controle segmentado de 4px.

## Components

### Buttons
Contidos e iguais em peso; a cor diz a intenção.
- **Shape:** 4px de raio, anel de 1px `line-strong/80`, padding 4px 10px, label 12px (no toque 44px de altura mínima, 16px de padding lateral, 14px).
- **Padrão:** texto fg, hover em hover. Ações principais de linha (Parar, Retomar).
- **Iniciar:** texto ok-fg, hover `ok/10`.
- **Primário:** anel `accent/40`, fundo `accent/10` a `accent/15`, texto accent-fg; hover sobe o fundo em 10 pontos. Só criação ("+ Novo container", "Criar e iniciar"). Exceção: o Logs da faixa de atenção leva o anel `accent/40` e o texto accent-fg (sem o fundo), porque ali diagnosticar é a tarefa.
- **Fantasma:** sem anel, texto fg-soft. Só Logs, a ação mais usada e mais inofensiva, para a principal saltar aos olhos.
- **Ícone:** quadrado (Reiniciar, ×, "⋯"), SVG de traço 1.6 a 1.8.
- **Foco:** contorno de 2px accent, deslocado 2px. **Ocupado:** `aria-disabled`, opacidade 40%, cursor de espera. Transição padrão do Tailwind, desligada em `prefers-reduced-motion`.

### Confirmação destrutiva (2 passos)
O primeiro clique arma; o segundo passo aparece numa barra presa ao pé da tela (`#armdock`, anel `bad/50`, acima da barra de lote): a nota em bad-soft, 12px, que diz o que sai e o que fica ("Os volumes ficam."), com os nomes vindos do docker em mono, o Confirmar em **Vermelho Destrutivo** com texto branco e o verbo, e um botão quadrado com × que cancela (Esc também; no toque, cancela sozinho em 8 s). O foco vai para o ×. Na tabela nada muda de tamanho: a linha armada só ganha o chão `bad/10`, e a principal e o "⋯" ficam inertes (`aria-disabled`; clicar na principal, ou no mesmo "Limpar…" ou "Remover…" de novo, só cancela), para o clique por hábito no mesmo lugar nunca confirmar. O verbo de remoção é um só: "Remover" (container, imagem, volume, rede) e "Remover 3 containers" no lote, que confirma na própria barra de lote. Só duas ações têm verbo próprio: a limpeza do disco ("Limpar imagens") e o compose down ("Derrubar shop"). Com daemon remoto, a nota começa pelo contexto em warn-fg.

### Contagens por estado
Controle segmentado (é filtro, não selo): segmentos mono 13px em linha, anel line e divisórias line, raio de 4px no conjunto. O número em semibold tabular; "com problema" em bad-fg. Pressionado: fundo fg-strong, texto canvas.

### Inputs / Fields
- **Style:** o campo toma o tom oposto ao da superfície em que está: canvas dentro dos modais, raised na busca (que fica sobre o canvas). Anel de 1px dim em todo campo, `select` e `textarea` (o line media 1,2:1 e o campo vazio sumia: WCAG 1.4.11 pede 3:1), 4px de raio, padding 8px 12px, texto fg-strong; valores técnicos (imagem, portas, env) em mono.
- **Focus:** anel vira accent, mais contorno de 2px accent.
- **Error:** anel bad, mensagem 12px bad-fg logo abaixo do campo.

### Linha de container
Ponto de estado de 8px, nome em mono 13px semibold fg-strong, imagem em mono 12px muted, status como texto colorido pelo tom (ok, warn, bad, pause, muted), com causa traduzida, CPU/RAM em mono 12px com sparkline ciano de 48×14 e, para quem caiu, a última linha do log precedida por `›` em dim, que é um botão: abre os logs (sublinha no hover). A linha mostrada é a que explica a queda (`tailLine`, das últimas 20): a última de erro que não continua nem abre um stack trace, na ordem do timestamp; sem nenhuma, a última. Em loop de reinício a ação principal é Reiniciar, o próximo passo do ciclo, e o Parar vai para o "⋯". Selecionada: fundo `accent/10`; armada para remover: `bad/10`. Abaixo de 1280px a imagem e as portas ficam sob o nome.

### Sparkline
Traço ciano de 1.5px, sem linha de base nem eixo. Até a janela encher, a série ocupa a largura toda; depois cada amostra tem fatia fixa, alinhada à direita. O eixo y vai de 0 ao máximo da série, com piso de 10% na CPU (uma variação de 0,01% não vira montanha); série sem variação é desenhada no meio da altura. No modal de logs a mesma sparkline cresce para 96×20.

### Portas
Texto mono 12px como a coluna PORTS do `docker ps`, `host→container` com a seta em sans. Porta HTTP de container rodando é link em accent-fg com seta SVG de nova aba; as outras copiam o endereço (fg-soft, ícone de copiar); inalcançáveis ficam em muted. Sublinhado e fundo translúcido só no hover.

### Faixa de atenção
Primeiro grupo da tabela, quando há algo quebrado: cabeçalho "PRECISA DE ATENÇÃO · n" em mono 12px semibold uppercase bad-fg sobre chão `bad/10`, seguido da explicação em sans. As linhas abaixo dele mostram também o projeto de cada container, e o Logs delas tem contorno ciano. Uma queda já terminada (exited ou dead) ganha "Marcar como visto" (sans 12px muted sublinhado): sai da faixa até o container cair de novo (o FinishedAt do inspect muda), fica guardado no navegador e o aviso tem Desfazer. Continua vermelha e contada em "com problema"; só o favicon e a faixa deixam de contá-la.

### Faixa de estado do projeto (assinatura)
No cabeçalho de cada grupo compose (fundo raised, separador line-strong acima): o nome do projeto em mono 16px semibold (Group), depois um bloco por container, 6×12px, raio de 1px, 2px de vão, na cor do estado, ordenados por nome, como uma calha de processos. Em seguida "compose · 3 de 5 rodando · 1 pausado · 1 reiniciando" em mono muted (os estados que entram no "Parar tudo (5)" aparecem pelo nome) e, se for o caso, "1 na faixa de atenção, acima" em bad-fg. Ação principal do projeto, Logs e "⋯" à direita. No "⋯" de um container, o compose do serviço vem com o comando literal em mono ("compose restart api", "compose up --build api"), para não se confundir com o Reiniciar da linha (o `docker restart` daquele container).

### Saída do compose
Enquanto um `up`, `up --build`, `pull`, `down` ou uma ação de serviço roda, uma linha própria aparece logo abaixo do cabeçalho do projeto, no mesmo chão raised dele, como continuação do cabeçalho e não como mais um container. Em cima, o comando e o estado numa linha só, em mono 12px: "compose up --build · rodando…" em fg-soft. Embaixo, a saída do compose num `pre` mono 12px fg-soft sobre canvas, com anel line e 4px de raio, quebrando linhas longas e com até 256px de altura antes de rolar. A caixa acompanha o fim da saída, a não ser que a pessoa tenha rolado para cima para ler. Ela recebe foco por Tab (o contorno de 2px accent) e é rotulada "Saída do compose up". Se der certo, a linha some e o aviso basta. Se falhar, ela fica: a linha de cima passa a bad-fg ("falhou (código 1)" ou "sem resposta do servidor") e ganha o botão quadrado com × na ponta direita, que fecha a saída e devolve o foco ao "⋯" do projeto.

### Logs
Modal de altura fixa, `pre` mono 12px. Abaixo do título, o status e o uso (CPU, memória, rede e disco, numa linha à parte que só ela muda a cada leitura do stats) e uma linha só, "Detalhes: configuração, histórico, processos e mudanças", que abre os quatro `details` aninhados, recuados por um traço line de 1px: abertos, eram quatro linhas de moldura antes da primeira linha do log. Os avisos com o modal aberto flutuam sobre o pé do log, centrados como o toast da página, sem empurrar as linhas. Cada linha toma a cor do nível (ERROR bad-fg, WARN warn-fg, DEBUG muted; o resto fg-soft). O timestamp do docker continua no texto (Copiar e Baixar levam a linha inteira), mas aparece como HH:MM:SS local em muted, desenhado pelo CSS a partir de `data-t`; o UTC vai no title, e o leitor de tela não lê nenhum dos dois (`aria-hidden`), como se lê a linha copiada. Depois de um reinício, uma marca "— reiniciado às HH:MM:SS —" em sans 11px accent-fg sobre um traço `accent/50`, também desenhada pelo CSS (`data-mark`), para não entrar no texto copiado. Nos logs do projeto, o prefixo do serviço toma um tom svc-* (ver Colors). O filtro realça os trechos que casam com `accent/30` e texto fg-strong, não com o tom de aviso. Ao lado do campo, três `select` nativos no mesmo estilo (canvas, anel line-strong/80, 12px): nível (todos, avisos e erros, só erros), serviço (só nos logs do projeto) e período (`--since`). Log ao vivo vazio mostra uma frase em sans muted, desenhada pelo CSS (`data-empty`). Depois de reiniciar pelo modal, a linha de status ganha "· reiniciado às HH:MM:SS" em muted, porque a marca só aparece se o container escrever algo. Ao abrir, o foco vai para a caixa do log. O Ao vivo começa ligado para container rodando; desligar fica lembrado neste navegador. No cabeçalho, CPU, memória, rede e disco são grupos que não quebram por dentro, com o "·" no fim do anterior.

### Terminal
Modal com o xterm sobre o chão canvas, na paleta da página no tema de agora: fg-soft no texto, cursor e seleção ciano e os ANSI pelos tons de estado (vermelho bad, verde ok, amarelo warn, magenta pause, ciano accent; os brilhantes nos `-fg`), lidos dos tokens ao abrir. O xterm fica com todas as teclas, inclusive Tab e Esc (do vim, do less); Ctrl+], o escape do telnet, devolve o foco ao ×, e de lá o Esc fecha. Com a sessão encerrada, o foco vai sozinho para o ×. O cursor só pisca sem `prefers-reduced-motion`, e o `screenReaderMode` do xterm põe a saída numa região viva.

### Disco
No topo das abas Imagens (containers parados, imagens e build cache, nessa ordem: os parados seguram as imagens "em uso") e Volumes. Cada categoria: rótulo em sans, números em mono 12px muted (total · liberável · itens, em uso) e uma barra de 6px, até 320px, trilho line-strong; a parte liberável, em ciano, fica na ponta direita. "Limpar…" arma a confirmação "Limpar <categoria>".

### Tabelas de objetos
Imagens, volumes e redes no ritmo de colunas do CLI, dentro do mesmo contêiner de 8px de raio e `raised/40`, linhas separadas por `line/70`. Cabeçalho uppercase mono 11px muted; a primeira coluna é o nome em mono 13px semibold fg-strong; as demais células em mono 12px muted. A coluna "Em uso por" lista os nomes dos containers (fg-soft) ou diz "nenhum container". Qualificadores como "(anônimo)", "(padrão)" e "(dangling)" são texto muted ao lado do nome, nunca selo com borda. A ação da linha é "Remover…", na ponta direita; a rede padrão não tem. Em uso (imagem ou volume com qualquer container, rede com container de pé), o "Remover…" fica indisponível em muted, com "Em uso por db: remova o container antes" no title, em vez de deixar o docker recusar. A contagem de cada lista aparece na aba, em mono 12px muted ("Imagens · 4").

### Ícone
"Estiva": uma pilha de três contêineres sobre o chão grafite (`#141a22`, raio 5 de 24), em que a de cima é ciano e a última linha termina num bloco ciano, o cursor. As outras são `#566273`. Fonte única em `src-tauri/icons/stivo.svg`: dela saem os PNG e o ICO do app (`npx tauri icon`), e o `setIcon` do app.ts desenha o mesmo SVG no favicon da web e na bandeja do desktop. A contagem da faixa de atenção vai num selo `#c2181d` (o danger, `oklch(52% 0.2 27)`, em hex: o SVG da bandeja não lê oklch) com texto branco no canto inferior direito (`9+` acima de 9, `!` com os dados velhos), porque ali o vermelho é estado. Legível a 16 px nos dois temas da bandeja; nada de baleia nem cubo isométrico.

### Preferências (só no desktop)
O mesmo esqueleto do modal "Novo container": título "Preferências" com a nota "Valem na hora" em muted, campos em coluna (`select` nativos de CLI, contexto e idioma, e a caixa das notificações), Cancelar e Salvar (primário) no pé. A linha do contexto some com o podman, porque o contexto é do docker. Salvar recarrega a janela, que volta com o rótulo do daemon e o idioma novos; erro aparece no mesmo aviso vermelho do Novo container. O botão "Preferências" fica no cabeçalho, ao lado de "Atalhos", e só existe no app desktop. No WebKitGTK os `select` nativos (aqui e nos logs) desenham o fundo do tema do GTK, não o canvas.

### Bandeja (só no desktop)
O ícone do Stivo com o selo da faixa de atenção (o mesmo desenho do favicon, em PNG de 64 px). Menu: Abrir o Stivo, Preferências… e Sair. Fechar a janela pela primeira vez gera uma notificação que diz que o app continua na bandeja e como sair.

### Navigation
Abas (`role="tablist"`): Containers, Imagens, Volumes, Redes, na borda de baixo da faixa do cabeçalho. Sans 14px em 500, padding 8px 12px, texto muted; hover fg; a selecionada fica fg-strong com um sublinhado de 2px accent que encosta no traço da faixa. Todas as abas levam a contagem em mono 12px muted ("Containers · 6"). Setas, Home e End andam entre as abas; trocar de aba entra no histórico e desarma qualquer confirmação. Atalhos de teclado (`/`, ←→, ↑↓, `r`, `s`, `b`, `x`, `a`, `z`, `?`; o `s` inicia, para ou retoma; o `r` reinicia, inicia o que está parado e, sem o que reiniciar, diz por quê; `a` e `z` só com o foco na lista, WCAG 2.1.4) aparecem num popover nativo com `kbd` mono de 4px de raio e anel line-strong.

## Do's and Don'ts

### Do:
- **Do** escrever o estado como texto e colori-lo com o tom do estado; o ponto de 8px é redundância, não substituto.
- **Do** usar o mono do sistema em `--text-data` (13px) para nome, status e contagens, e 12px para imagem, portas e logs.
- **Do** separar em repouso com anéis de 1px e tom de superfície; raio de 4px em controles e 8px em superfícies.
- **Do** dar a cada ação destrutiva o segundo passo vermelho com verbo e alvo, um × que cancela e uma nota que diz o que sai e o que fica; o verbo de remoção é sempre "Remover" ("Limpar" só na limpeza do disco, "Derrubar" só no compose down).
- **Do** desenhar por CSS (`data-t`, `data-mark`) o que é só leitura nos logs, para Copiar e Baixar levarem só o log.
- **Do** dar 44px de alvo a todo controle no toque (`coarse:`, não por largura) e desligar transições e pulsos com `prefers-reduced-motion`.
- **Do** pôr o segundo passo de uma ação destrutiva no pé da tela, nunca no lugar do botão que armou.

### Don't:
- **Don't** usar zinc + sky do Tailwind, pílulas de status, cubo isométrico ou rótulos uppercase em sans: é o painel admin de fábrica que este sistema recusa.
- **Don't** usar verde, amarelo, vermelho ou magenta para algo que não seja estado.
- **Don't** introduzir um segundo acento além do ciano.
- **Don't** pôr raio cheio em nada que carregue texto.
- **Don't** usar fundo vermelho sólido fora do segundo passo de uma confirmação destrutiva.
- **Don't** pôr sombra em superfícies em repouso.
