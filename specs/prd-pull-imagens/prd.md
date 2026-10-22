# PRD: Baixar e atualizar imagens

## Visão geral

A aba Imagens lista, mede e remove imagens, mas não baixa nenhuma. Hoje há dois caminhos indiretos: o `pull` de um projeto compose (que baixa todas as imagens do projeto) e o "Novo container" (que baixa a imagem se ela faltar, mas também cria um container). Para os dois casos mais comuns, a pessoa volta ao terminal:

1. **Baixar uma imagem antes de usar** (um `postgres:17` para o próximo projeto, a imagem base de um build).
2. **Atualizar uma tag que já existe** (`node:22`, `nginx:latest`) para saber se há versão nova antes de reconstruir.

A feature traz o `docker pull` para a aba Imagens, para os dois casos.

## Objetivos

- Baixar uma imagem pelo nome e atualizar uma imagem existente sem terminal.
- Ao atualizar, dizer claramente se a imagem mudou ou já estava em dia.
- Mostrar o progresso de downloads longos, sem a página parecer travada.
- Mesmo comportamento na web e no desktop, com Docker e Podman.

## Histórias de usuário

- Como dev, eu quero digitar `postgres:17` e baixar a imagem, para tê-la pronta antes de subir o projeto.
- Como dev, eu quero atualizar a `node:22` que já tenho, para saber se veio versão nova antes de reconstruir meus serviços.
- Como dev, eu quero ver o progresso de uma imagem grande, para saber que está andando.
- **Borda:** a imagem não existe ou exige login. O aviso traduz a causa, como o "Novo container" já faz ("imagem que não existe no registry ou sem login").
- **Borda:** disco cheio ou imagem de outra arquitetura. Mesmas causas traduzidas de hoje.
- **Borda:** atualizar uma tag que não mudou. O aviso diz "já estava em dia".
- **Borda:** atualizar uma tag que mudou. A imagem antiga perde a tag e passa a aparecer como "sem tag" na lista (como faz o docker); o aviso diz isso, para a pessoa saber que pode limpar depois.
- **Borda:** imagem sem tag (dangling) ou só com digest. Não tem "Atualizar".
- **Borda:** fechar a aba no meio do download. O download continua até terminar ou estourar o prazo, como as ações do compose.
- **Borda:** daemon remoto. A imagem é baixada no daemon remoto, e o aviso começa pelo nome do contexto, como as outras ações.

## Funcionalidades principais

### 1. Baixar imagem pelo nome

1. **RF1.1** A aba Imagens ganha o campo "Baixar imagem", que aceita os mesmos formatos de imagem do "Novo container" (`repo[:tag]` ou `repo@sha256:…`), com a mesma validação.
2. **RF1.2** Sem tag, vale o padrão do docker (`latest`), e o campo deixa isso visível antes de baixar.
3. **RF1.3** Terminado o download, a imagem aparece na lista e fica em destaque por um momento.

### 2. Atualizar uma imagem existente

1. **RF2.1** Cada imagem com tag ganha "Atualizar", que baixa a mesma tag de novo. Uma imagem com várias tags atualiza a tag escolhida.
2. **RF2.2** O resultado diz se a imagem mudou ("Atualizada: node:22") ou já estava em dia ("node:22 já estava em dia").
3. **RF2.3** Quando a imagem mudou e há containers usando a versão anterior, o aviso diz que eles continuam com a versão anterior até serem recriados.

### 3. Progresso e erros

1. **RF3.1** Enquanto baixa, a imagem mostra o progresso (o que o docker informa, por camada ou resumido), no estilo da saída ao vivo do compose.
2. **RF3.2** Dá para baixar mais de uma imagem ao mesmo tempo; cada uma mostra o seu progresso.
3. **RF3.3** Falhas usam as causas traduzidas de hoje no aviso; o erro do docker fica na saída do pull, que continua aberta até o ×.
4. **RF3.4** O download tem o mesmo prazo das outras ações que baixam imagem (10 min).

## Experiência do usuário

- O campo fica no topo da aba Imagens, junto do uso de disco. Enter baixa.
- "Atualizar" fica em cada linha de imagem com tag, ao lado de Remover, sem confirmação (não apaga nada).
- O texto dos botões segue a língua do CLI: a ação é o `docker pull`, e o title diz o comando que roda.
- Progresso anunciado ao leitor de tela só no começo e no fim, para não inundar a região viva. Teclado completo, português e inglês.

## Restrições técnicas de alto nível

- **As duas versões** (web e desktop) recebem a feature.
- **Podman**: o mesmo fluxo, com a saída de progresso e o nome curto de imagem no formato dele (o Podman pode pedir o registry completo).
- **Nenhuma credencial passa pela página.** Login em registry continua sendo feito pelo terminal; a página usa o que o docker já tem.
- **Validação do nome da imagem** do lado de quem executa, como no "Novo container". Nada vindo da página vira argumento livre.
- **Rede**: é a única ação que depende do registry; sem rede, o erro é traduzido e o resto da página segue offline.

## Fora de escopo

- **Atualizar todas as imagens** de uma vez.
- **Avisar sozinho** que há versão nova de uma imagem (consultar o registry em segundo plano), por ir contra o funcionamento offline.
- **Recriar os containers** que usam a imagem atualizada (para isso existe o `up` e o Reconstruir do compose).
- **Login em registry**, **push**, **tag** e **build** de imagens.
- **Buscar imagens** no registry (`docker search`).

## Histórico

**2026-10-21**. Documento criado. Decisão: entram os dois fluxos, baixar pelo nome e atualizar uma tag existente.

**2026-10-21**. Reconciliação do sdd-review. RF3.3: o erro do docker fica na saída do pull, aberta até o ×, que é onde ele já aparece inteiro; não há um "ver erro" à parte.
