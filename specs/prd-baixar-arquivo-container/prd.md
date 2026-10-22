# PRD: Baixar arquivo do container

## Visão geral

Nem tudo que importa num container sai no `docker logs`. Muitos programas escrevem em arquivo: o log de erro do nginx, o `slow.log` do banco, um relatório que o teste gera, um dump, um core, um arquivo de configuração que a imagem gerou. Para ver, hoje a pessoa abre o terminal da página e usa `cat` (que não serve para arquivo grande ou binário), ou vai para o terminal do host e monta um `docker cp` com o nome do container.

A feature baixa um arquivo, ou uma pasta, de dentro do container, a partir do caminho que a pessoa digita. Só na direção de dentro para fora: a GUI não grava nada dentro do container nem fora da pasta que a pessoa escolhe.

## Objetivos

- Baixar um arquivo ou uma pasta de um container sem terminal, nas duas versões.
- Funcionar com o container parado (o caso mais comum é investigar um container que caiu).
- Recusar com mensagem clara o que não dá para baixar (caminho que não existe, tamanho acima do limite), sem travar a página.

## Histórias de usuário

- Como dev, eu quero baixar `/var/log/nginx/error.log` de um container, para ler o erro que não aparece no `docker logs`.
- Como dev, eu quero baixar uma pasta (`/app/reports`) inteira, que chega como um `.tar`, para abrir os relatórios no meu editor.
- Como dev com um container que caiu, eu quero baixar o arquivo mesmo com ele parado, porque é justamente esse que estou investigando.
- **Borda:** o caminho não existe. A mensagem diz que não existe, com o caminho.
- **Borda:** o arquivo é maior que o limite. A mensagem diz que ele passa do limite e sugere o `docker cp` pelo terminal, com o comando pronto para copiar.
- **Borda:** o caminho é um link simbólico. Baixa o arquivo para onde o link aponta, dentro do container.
- **Borda:** daemon remoto. Funciona: o arquivo vem do container lá, e o aviso de contexto continua como hoje.
- **Borda:** container que não existe mais (removido no meio). Mensagem de erro, sem download parcial.

## Funcionalidades principais

### 1. Baixar

1. **RF1.1** O menu "⋯" do container ganha "Baixar arquivo…", que pede o caminho dentro do container.
2. **RF1.2** O caminho precisa ser absoluto (começa com `/`); o campo diz isso e recusa o resto antes de pedir.
3. **RF1.3** Um arquivo chega com o próprio nome e o conteúdo como está (texto ou binário).
4. **RF1.4** Uma pasta chega como `<nome-da-pasta>.tar`.
5. **RF1.5** Funciona com o container rodando, pausado ou parado.
6. **RF1.6** O campo lembra os últimos caminhos usados naquele container (neste navegador / neste app), porque o mesmo log é baixado várias vezes no mesmo dia.

### 2. Onde o arquivo vai parar

1. **RF2.1** Na web, o arquivo chega como um download comum do navegador, como o "Baixar" dos logs.
2. **RF2.2** No desktop, a pessoa escolhe onde salvar numa janela do sistema, que já vem com o nome do arquivo.
3. **RF2.3** Nada é gravado no host sem a escolha da pessoa (desktop) ou fora do fluxo de download do navegador (web).

### 3. Limites e erros

1. **RF3.1** Um limite de 100 MB protege a página e o app. Acima dele, a recusa vem antes de qualquer byte chegar à página ou ao disco, e a mensagem traz o `docker cp` pronto.
2. **RF3.2** Erros traduzidos: caminho não existe, container sumiu, tamanho acima do limite. Os outros (sem permissão, entre eles) mostram o erro do docker inteiro.
3. **RF3.3** Um download em andamento mostra que está acontecendo e pode ser cancelado.

## Experiência do usuário

- Um diálogo pequeno com o campo do caminho e os últimos usados, no estilo do "Novo container". Enter baixa; `Esc` fecha.
- O title da ação mostra o comando equivalente (`docker cp <container>:<caminho> .`), na língua do CLI.
- Português e inglês; teclado completo e leitor de tela (o resultado sai na região viva de avisos).

## Restrições técnicas de alto nível

- **As duas versões** (web e desktop) recebem a feature.
- **Só de dentro para fora.** Nada é enviado para o container; a GUI não amplia o acesso ao host (PRODUCT.md).
- **Caminho validado** do lado de quem executa: absoluto, sem argumento livre, aplicado ao container escolhido.
- **Conteúdo não confiável**: o arquivo vem do container e nunca é aberto, interpretado ou executado pela página ou pelo app, só entregue.
- **Podman**: o mesmo fluxo.
- **Prazo** de ação longa, como as outras que transferem dados.

## Fora de escopo

- **Enviar arquivo para o container** (`docker cp` de fora para dentro).
- **Navegar pelo filesystem** do container clicando em pastas. O [PRD de mudanças no filesystem](../prd-diff-container/prd.md) mostra o que mudou, que é um ponto de partida para saber o que baixar.
- **Ver o arquivo** dentro da página, sem baixar.
- **Baixar de um volume** sem container.
- **Compactar** a pasta (o `.tar` sai sem compressão, como o docker entrega).

## Histórico

**2026-10-21**. Documento criado. Decisões: caminho digitado; pasta sai como `.tar`; funciona com o container parado; limite de tamanho com o `docker cp` sugerido.

**2026-10-21**. RF3.1: o limite passa a ser 100 MB, nas duas versões. Na web o arquivo passa pela memória da aba (o token fica no header, sem link direto com o token na URL), e o techspec fixou o valor por isso.

**2026-10-22**. RF3.2, revisto na implementação: são traduzidos o caminho que não existe, o container que sumiu e o tamanho acima do limite. "Sem permissão" não ganhou texto próprio: com o Docker, o `docker cp` lê pelo daemon, como root, e o stderr desse caso varia entre Docker e Podman. Ele e os demais erros aparecem no diálogo com o stderr do docker inteiro, sem um "ver erro" para abrir.

**2026-10-22**. RF3.1 e a borda do arquivo grande, revistos na implementação: o tamanho não é conhecido antes (o `docker cp` não o informa, e a leitura para no limite). A mensagem diz que passa de 100 MB, sem o tamanho exato, e a recusa vem antes de qualquer byte chegar à página ou ao disco.
