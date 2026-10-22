# PRD: Abrir a pasta do projeto compose

## Visão geral

O ciclo do dia é mudar o código, reiniciar e ler os logs. Quando os logs mostram o problema, o passo seguinte é abrir o projeto: o `docker-compose.yml`, o `.env`, o código. A página já sabe onde fica a pasta de cada projeto compose (ela vem dos labels e é usada para o `up`, o `down` e o `pull`), mas não ajuda a chegar lá. Com vários projetos rodando, a pessoa precisa lembrar onde cada um mora.

A feature dá um caminho direto da página para a pasta do projeto: no desktop, abre a pasta no gerenciador de arquivos do sistema; na web, copia o caminho.

## Objetivos

- Da página até a pasta do projeto em uma ação, nas duas versões.
- Nunca oferecer abrir uma pasta que não está nesta máquina (daemon remoto).
- Nenhuma brecha nova: a página nunca abre um caminho que não seja a pasta de um projeto que o daemon informou.

## Histórias de usuário

- Como dev no app desktop, eu quero abrir a pasta do projeto compose no gerenciador de arquivos, para chegar ao `docker-compose.yml` e ao `.env` sem procurar.
- Como dev na versão web, eu quero copiar o caminho da pasta do projeto, para colar no terminal (`cd`) ou no editor.
- **Borda:** daemon remoto. A pasta está na outra máquina: a ação não aparece em nenhuma das versões.
- **Borda:** a pasta não existe mais (o projeto foi movido ou apagado com o container ainda lá). O desktop avisa que a pasta não existe, com o caminho; a web copia o caminho normalmente.
- **Borda:** container sem compose. Não tem pasta de projeto; nada muda.
- **Borda:** versão web acessada por SSH ou pelo celular. Copiar o caminho continua útil (para o terminal da máquina); abrir não faria sentido, e por isso a web não abre.

## Funcionalidades principais

### 1. A ação

1. **RF1.1** O menu "⋯" do projeto compose ganha a ação da pasta. No desktop: "Abrir pasta". Na web: "Copiar caminho da pasta".
2. **RF1.2** O desktop abre a pasta no gerenciador de arquivos padrão do sistema.
3. **RF1.3** A web copia o caminho completo da pasta e confirma com o aviso de sempre ("Caminho copiado").
4. **RF1.4** A ação só existe para projetos com pasta conhecida e com daemon local; com daemon remoto, não aparece.
5. **RF1.5** O caminho também aparece no title (dica ao passar o mouse) da ação, para a pessoa saber qual pasta é antes de abrir.

### 2. Segurança

1. **RF2.1** A pasta aberta ou copiada é sempre a que vem dos labels dos containers do projeto, conferida do lado de quem executa, como no `up` e no `down` de hoje. Nada vindo da página escolhe o caminho.
2. **RF2.2** O desktop só abre pastas, nunca executa arquivos.

## Experiência do usuário

- No menu "⋯" do projeto, junto do `up`, `pull` e `down`, sem botão novo no cabeçalho (o cabeçalho fica com a ação principal e os Logs).
- Mensagens em português e inglês. Falha ao abrir (pasta sumiu, sem gerenciador de arquivos) vira aviso com o caminho, para a pessoa chegar lá por conta própria.
- Teclado e leitor de tela como no resto do menu.

## Restrições técnicas de alto nível

- **As duas versões recebem a feature, com ações diferentes.** A web não abre a pasta porque o navegador não abre pastas da máquina e porque a página pode estar sendo usada por SSH ou de outro aparelho; copiar o caminho é o equivalente que funciona em todos esses casos.
- **Linux e Windows** no desktop, cada um pelo gerenciador de arquivos padrão.
- **A GUI não amplia o acesso ao host** (PRODUCT.md): abrir uma pasta que o próprio projeto declara, no gerenciador de arquivos, não executa nada.

## Fora de escopo

- **Abrir no editor** (VS Code e outros), com editor configurável. Consideração futura.
- **Abrir um arquivo específico** (o `docker-compose.yml`, o `.env`).
- **Abrir um terminal** na pasta do projeto.
- **Pasta de container fora do compose** (não existe uma).

## Histórico

**2026-10-21**. Documento criado. Decisão: desktop abre no gerenciador de arquivos; web copia o caminho; nenhuma das duas com daemon remoto.
