# PRD: Mudanças no filesystem do container

## Visão geral

"Ontem funcionava, hoje não" num container que ninguém recriou costuma ter uma causa: algo escreveu dentro dele. Um arquivo de lock que ficou, um cache que cresceu, uma configuração editada à mão pelo terminal, um pacote instalado para depurar e esquecido. O `docker diff` mostra exatamente o que mudou no filesystem do container em relação à imagem (adicionado, alterado, apagado), mas pouca gente lembra que ele existe.

A feature leva essa lista para o modal de logs, ao lado dos Processos e da Configuração, para que a pessoa responda "o que mudou aqui dentro?" sem terminal.

## Objetivos

- Responder "o que mudou no container desde que ele saiu da imagem?" no modal de logs, sem terminal.
- Funcionar com o container rodando ou parado (um container que caiu é justamente o que se quer investigar).
- Nunca travar a página: num container com muitas mudanças (um `node_modules` escrito em runtime), a lista aparece resumida e a página continua leve.

## Histórias de usuário

- Como dev com um container que passou a falhar, eu quero ver quais arquivos foram criados, alterados ou apagados dentro dele, para achar o que mudou desde que ele subiu.
- Como dev, eu quero filtrar a lista por caminho, para ir direto a `/etc` ou `/app`.
- Como dev, eu quero perceber quando algo está sendo escrito fora de um volume, porque isso some ao recriar o container.
- **Borda:** container sem nenhuma mudança. Mostra "Nada mudou em relação à imagem".
- **Borda:** milhares de mudanças. Mostra as primeiras, com a contagem total e o filtro para achar o resto.
- **Borda:** caminhos dentro de volumes e bind mounts não aparecem no diff (o docker não os inclui). A seção diz isso, para ninguém achar que o volume não mudou.

## Funcionalidades principais

### 1. Lista de mudanças

1. **RF1.1** O modal de logs de um container ganha a seção "Mudanças" com a lista do que mudou no filesystem em relação à imagem.
2. **RF1.2** Cada item mostra o caminho e o tipo da mudança, traduzido e diferenciado por cor e texto: adicionado, alterado, apagado.
3. **RF1.3** Um resumo em cima conta por tipo ("12 adicionados · 3 alterados · 1 apagado").
4. **RF1.4** A lista funciona com o container rodando, pausado ou parado.
5. **RF1.5** Acima de um limite de itens (na casa das centenas), a lista mostra os primeiros e diz quantos ficaram de fora.
6. **RF1.6** Um filtro por texto no caminho, no estilo do filtro dos logs (sem diferenciar maiúsculas, sem regex), vale sobre a lista inteira, inclusive o que ficou de fora da exibição.
7. **RF1.7** Dá para copiar a lista (a filtrada, se houver filtro).

### 2. Quando ler

1. **RF2.1** A lista é lida quando a pessoa abre a seção, não ao abrir o modal: o diff pode demorar em containers grandes, e quem abre os logs quase sempre quer só os logs.
2. **RF2.2** Um botão atualiza a lista.

## Experiência do usuário

- No modal de logs, junto do Histórico, Processos e Configuração, no mesmo formato (seção recolhida, tabela compacta).
- O nome da seção segue a língua do CLI: "Mudanças (`docker diff`)".
- Uma nota curta explica que volumes ficam de fora.
- Teclado e leitor de tela como no resto do modal; o tipo de mudança é texto, não só cor.

## Restrições técnicas de alto nível

- **As duas versões** (web e desktop) recebem a feature.
- **Podman** tem o mesmo comando, com saída em outro formato; a página mostra igual.
- **Só leitura.** Nada desfaz ou apaga mudanças.
- **Caminhos vêm do container** (texto não confiável) e são exibidos como texto.
- **Daemon remoto** funciona como o resto da página, com o aviso de contexto de hoje.

## Fora de escopo

- **Ver o conteúdo** ou o antes e depois de um arquivo alterado. Para baixar um arquivo, ver o [PRD de baixar arquivo do container](../prd-baixar-arquivo-container/prd.md).
- **Desfazer** mudanças ou **gerar uma imagem** a partir delas (`docker commit`).
- **Comparar** dois containers ou duas imagens.
- **Tamanho** de cada mudança.

## Histórico

**2026-10-21**. Documento criado.
