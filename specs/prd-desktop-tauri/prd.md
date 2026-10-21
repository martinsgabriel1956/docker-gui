# PRD: Stivo desktop

## Visão geral

Hoje o produto (até aqui chamado Docker GUI) é um arquivo Python que sobe um servidor em `localhost` e abre a página numa aba do navegador. Para quem desenvolve na própria máquina, isso tem quatro limites:

1. **A vigilância acaba quando a aba fecha.** A faixa "Precisa de atenção" e as notificações só existem enquanto a página está aberta. Um container que cai com a aba fechada passa despercebido, justamente no momento em que a pessoa voltou para o editor.
2. **Exige Python.** No Windows o Python costuma não estar instalado, e "instale o Python antes" é uma barreira para quem só quer ver os containers.
3. **Vive numa aba.** O app se perde no meio das abas do navegador, em vez de ter janela, ícone e lugar próprios no sistema.
4. **Abre um servidor local.** Porta, token e validação de `Host`/`Origin` existem só para proteger um servidor HTTP que, num app de janela, não precisaria existir.

A versão desktop é um app instalável, com janela própria, que continua vigiando os containers na bandeja do sistema e avisa quando algo quebra, sem pedir Python nem abrir servidor local. Ela convive com a versão web: o `docker_gui.py` continua existindo para uso por SSH, pelo celular e para quem não quer instalar nada.

## Objetivos

- **Paridade comprovada:** os cenários da suíte E2E de hoje passam contra o app desktop.
- **Instalação sem dependências:** num Linux e num Windows limpos, só com o Docker (ou Podman) instalado, o app instala e abre sem pedir Python nem outro runtime.
- **Aviso rápido em segundo plano:** com a janela fechada (app na bandeja), um container que entra na faixa de atenção gera notificação do sistema em até **5 s**.
- **Leve:** instalador de até **20 MB** e no máximo **150 MB** de memória com o app ocioso (janela fechada, vigiando).
- **A versão web segue intacta:** a suíte atual (backend, `format`, E2E) continua passando contra o `docker_gui.py`, e o README da versão web continua valendo.

## Histórias de usuário

- Como dev com containers rodando, eu quero fechar a janela e ser avisado quando um container cair, para não descobrir só minutos depois que a API está fora.
- Como dev no Windows sem Python, eu quero baixar um instalador e abrir o app, para gerenciar meus containers sem preparar ambiente.
- Como dev, eu quero ver na bandeja quantos containers precisam de atenção, para saber sem abrir a janela se há algo quebrado.
- Como dev, eu quero abrir o app pelo menu do sistema e encontrar tudo o que a versão web faz (lista ao vivo, logs, compose, terminal), para não precisar escolher entre as duas.
- Como dev que usa Podman ou um contexto remoto, eu quero escolher a CLI, o contexto e o idioma numa tela de preferências, porque abrindo pelo menu do sistema não há linha de comando nem variável de ambiente.
- Como dev, eu quero sair do app de verdade pelo menu da bandeja, para parar a vigilância quando não precisar dela.
- **Borda:** o Docker não está instalado ou o daemon está parado. O app abre, diz o que falta e volta a funcionar sozinho quando o daemon sobe.
- **Borda:** a pessoa troca de contexto (por exemplo, para um daemon remoto) nas preferências. A lista, a bandeja e as notificações passam a refletir o novo daemon, e o aviso de daemon remoto continua visível como hoje.
- **Borda:** vários containers caem juntos com a janela fechada. Sai uma notificação só, com a contagem e os nomes, como na versão web.

## Funcionalidades principais

### 1. Paridade com a versão web

Tudo o que o README descreve hoje funciona no desktop, com o mesmo comportamento e o mesmo texto. Importa porque a pessoa não deve perder nada ao trocar de versão.

1. **RF1.1** Lista ao vivo pelos eventos do daemon, com o poll de segurança e a volta ao poll quando os eventos falham.
2. **RF1.2** CPU, memória, rede e disco com sparklines.
3. **RF1.3** Faixa "Precisa de atenção", com a causa traduzida (código de saída, OOM, healthcheck, loop de reinício) e a última linha do log.
4. **RF1.4** Agrupamento por projeto do compose, ações por projeto (`up`, `up --build`, `pull`, `down`), ações por serviço, serviços sem container e a saída ao vivo do compose.
5. **RF1.5** Ações por container e em lote, com as mesmas confirmações em 2 passos e o "conferindo se ficou de pé".
6. **RF1.6** Logs de container e de projeto: ao vivo, filtro, carregar mais, copiar, baixar e reiniciar a partir dos logs.
7. **RF1.7** Terminal no container, com TTY, redimensionamento e as mesmas regras de teclado.
8. **RF1.8** Criar container, com as mesmas restrições de segurança (sem bind mount, `--privileged`, rede ou PID do host, devices ou comando livre).
9. **RF1.9** Imagens, volumes e redes, com remoção e limpeza.
10. **RF1.10** Podman e contextos do Docker, incluindo o aviso permanente de daemon remoto.
11. **RF1.11** Português e inglês, temas claro e escuro, atalhos de teclado e acessibilidade WCAG 2.2 AA.

### 2. Vigilância em segundo plano

O que justifica a versão desktop: o diagnóstico ("o que quebrou e por quê") continua funcionando com a janela fechada.

1. **RF2.1** Fechar a janela não encerra o app: ele vai para a bandeja e continua acompanhando os containers.
2. **RF2.2** O ícone da bandeja mostra a contagem da faixa de atenção (`9+` acima de 9) e um estado de erro quando não consegue falar com o daemon, como o favicon faz hoje.
3. **RF2.3** O menu da bandeja permite abrir a janela e sair do app.
4. **RF2.4** As notificações do sistema vêm ligadas por padrão, sem o botão "Notificar quando algo der problema". As regras de quando notificar são as da versão web: só quem entra na faixa, sem repetir quem continua nela, sem avisar o que já estava quebrado ao abrir, e uma notificação agrupada quando vários entram juntos.
5. **RF2.5** As notificações saem com a janela fechada, minimizada ou sem foco, e não saem com a janela em primeiro plano.
6. **RF2.6** Clicar na notificação abre a janela e leva ao container ou ao grupo que entrou na faixa.
7. **RF2.7** Só uma instância do app roda por vez: abrir de novo traz a janela existente para a frente.

### 3. Janela própria

1. **RF3.1** O app aparece no menu de aplicativos do sistema com nome e ícone próprios.
2. **RF3.2** A janela lembra tamanho e posição entre execuções.
3. **RF3.3** O título da janela mostra o contexto quando ele não é o `default`, como a aba faz hoje.

### 4. Preferências

Sem linha de comando, a configuração que hoje vem de flags e variáveis de ambiente precisa de uma tela.

1. **RF4.1** Uma tela de preferências com: CLI (Docker ou Podman), contexto (lista dos contextos disponíveis) e idioma (automático, português, inglês).
2. **RF4.2** Os padrões são os de hoje: `DOCKER_GUI_CLI`, `DOCKER_CONTEXT`/contexto atual e locale do sistema. O que a pessoa escolhe na tela prevalece e fica salvo entre execuções.
3. **RF4.3** Mudar uma preferência vale na hora, sem reiniciar o app.
4. **RF4.4** As notificações podem ser desligadas nas preferências.

### 5. Sem servidor local

1. **RF5.1** O app desktop não abre nenhuma porta de rede na máquina.
2. **RF5.2** Nenhum outro processo nem site no navegador consegue disparar ações do app.
3. **RF5.3** As garantias de segurança da versão web continuam valendo: nenhum shell no host, argumentos validados e caminhos do compose lidos só dos labels.

### 6. Nome do produto

O produto passa a se chamar **Stivo** nas duas versões, porque "Docker GUI" usa uma marca de terceiro que as listagens públicas (Flathub, Snap, winget, AUR) tornariam um risco.

1. **RF6.1** Todo nome visível é Stivo: título da página e da janela, cabeçalho, instalador, menu do sistema, bandeja, notificações, listagens das lojas, README e mensagens.
2. **RF6.2** "Docker" e "Podman" aparecem só como compatibilidade ("para Docker e Podman"), no subtítulo e na descrição.
3. **RF6.3** Quem já usa a versão web não é afetado: comando, variáveis de ambiente e dados guardados no navegador continuam funcionando.

### 7. Distribuição

1. **RF7.1** Instaladores para Linux e Windows publicados a cada release no GitHub.
2. **RF7.2** O app também é publicado no Flathub, no winget, no AUR e no Snap.
3. **RF7.3** O CI gera os instaladores e confere que a versão desktop e a versão web passam nos testes antes da release.

## Experiência do usuário

- **Primeira execução:** a pessoa instala e abre pelo menu do sistema. Sem tela de boas-vindas: o app já mostra a lista. Se o daemon não responde, o estado vazio diz o que falta (Docker não instalado, daemon parado, sem permissão no socket) e o que fazer.
- **Ciclo diário:** a janela fica ao lado do editor. Mudar, reiniciar e ler os logs continua a um clique ou uma tecla (princípio 1 do PRODUCT.md). Ao fechar a janela, uma única vez, o app avisa que continua na bandeja e como sair.
- **Em segundo plano:** a contagem na bandeja e as notificações substituem o favicon. A notificação usa o mesmo texto da versão web (`<nome> precisa de atenção`, com o status no corpo).
- **Preferências:** abertas pelo menu da bandeja e por um atalho dentro da janela. A tela segue o DESIGN.md (tokens, tipografia, foco visível, teclado completo).
- **Acessibilidade:** a mesma meta da versão web (WCAG 2.2 AA). A bandeja e as notificações têm textos legíveis por leitor de tela.
- **Visual:** a janela usa o mesmo design da versão web. O layout de celular continua existindo só na versão web.

## Restrições técnicas de alto nível

- **Tauri é decisão tomada** para a camada desktop. O techspec decide como o backend atual é aproveitado ou reescrito.
- **As duas versões convivem e são mantidas.** Uma feature nova precisa chegar às duas, ou o PRD dela diz por que não.
- **Linux e Windows** na primeira entrega. No Windows, o alvo é quem usa o Docker Desktop.
- **O Flathub e o Snap isolam o app.** O acesso ao socket do Docker ou do Podman e ao binário da CLI precisa funcionar dentro dessas restrições.
- **A GUI nunca amplia o que o `docker` já permite** (PRODUCT.md, "Capabilities and Constraints"). Isso vale igual para o desktop.
- **Metas mensuráveis:** aviso em até 5 s, instalador de até 20 MB, até 150 MB de RAM ocioso.
- **Funciona offline**, como hoje: nada de rede além do daemon.

## Fora de escopo

- **Atualização automática.** Uma versão nova é instalada pelo canal de onde o app veio.
- **Assinatura de código.** No Windows, o SmartScreen avisa na primeira execução. Isso será documentado no README.
- **macOS.** Fica para depois, porque exige assinatura e notarização da Apple.
- **Features novas** além de paridade, segundo plano, janela própria e preferências. Exemplos: vários daemons ao mesmo tempo, atalho global, iniciar com o sistema.
- **Layout de celular no desktop.**
- **Telemetria** de qualquer tipo.

## Histórico

**2026-10-21**. Documento criado.

**2026-10-21**. Nome do produto: Stivo (seção 6, RF6.1 a RF6.3), no lugar de "Docker GUI", por causa das diretrizes de marca da Docker; distribuição renumerada para a seção 7 (RF7.x). Busca de marca no INPI e no USPTO pendente.
