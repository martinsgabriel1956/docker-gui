# PRD: Iniciar com o sistema

## Visão geral

O Stivo desktop vigia os containers da bandeja e avisa quando algo quebra (PRD do desktop, seção 2). Mas ele só vigia depois que alguém o abre. Depois de ligar o computador, a pessoa abre o editor, sobe o compose pelo terminal e só lembra do Stivo quando algo já está estranho, justamente o momento que a vigilância existe para evitar.

A feature deixa o app subir sozinho no login, direto na bandeja, para quem escolher isso nas preferências.

## Objetivos

- Com a opção ligada, o app está na bandeja e vigiando em até **10 s** depois do login, sem abrir a janela.
- Com a opção desligada (o padrão), nada muda em relação a hoje.
- Ligar e desligar vale sem reiniciar o app e sobrevive a atualizações do app.
- Funciona em Linux e Windows, nas formas de instalação suportadas (`.deb`, `.rpm`, `.msi`, `.exe`, AUR, winget).

## Histórias de usuário

- Como dev que deixa containers rodando, eu quero que o Stivo suba sozinho no login, para ser avisado de uma queda sem lembrar de abrir o app.
- Como dev, eu quero que, ao subir no login, ele fique só na bandeja, para não ganhar uma janela na cara toda vez que ligo o computador.
- Como dev, eu quero desligar isso nas mesmas preferências, para parar quando não precisar.
- **Borda:** o Docker ainda não subiu quando o login termina (o Docker Desktop no Windows demora). O app sobe, mostra o estado de erro na bandeja e volta a funcionar sozinho quando o daemon responde, como já faz hoje.
- **Borda:** o app é desinstalado com a opção ligada. Nada fica tentando abrir um app que não existe mais.
- **Borda:** a pessoa já tem o app aberto quando faz login de novo (sessão restaurada). Continua uma instância só (RF2.7 do PRD do desktop).

## Funcionalidades principais

### 1. Opção nas preferências

1. **RF1.1** As preferências ganham "Iniciar com o sistema", desligada por padrão.
2. **RF1.2** Ligar ou desligar vale na hora e fica salvo entre execuções, como as outras preferências (RF4.3 do PRD do desktop).
3. **RF1.3** A opção mostra o estado real: se o registro de início automático foi removido por fora (pelo sistema ou pela pessoa), ela aparece desligada.
4. **RF1.4** Se o sistema recusar o registro, a preferência volta para desligada e um aviso diz o motivo.

### 2. Subir no login

1. **RF2.1** Com a opção ligada, o app sobe no login da sessão do usuário (não do sistema inteiro, sem privilégio de administrador).
2. **RF2.2** Ao subir pelo login, o app vai direto para a bandeja, sem abrir a janela, e sem o aviso de "o app continua na bandeja" da primeira vez que fecha.
3. **RF2.3** Abrir o app pelo menu do sistema continua abrindo a janela, como hoje.
4. **RF2.4** As regras de notificação valem como numa abertura normal: o que já estava quebrado no login não vira notificação.

### 3. Instalação e remoção

1. **RF3.1** Desinstalar o app remove o início automático.
2. **RF3.2** Atualizar o app mantém a escolha.

## Experiência do usuário

- Na tela de preferências, junto com as notificações, porque as duas tratam do que o app faz em segundo plano. Texto da opção: "Iniciar com o sistema", com a explicação curta "Abre na bandeja ao entrar na sua conta".
- No GNOME sem a extensão AppIndicator a bandeja não aparece (README). A opção continua disponível, e a explicação avisa que, sem a bandeja, o app roda sem ícone visível.
- Teclado e leitor de tela como no resto das preferências (WCAG 2.2 AA).

## Restrições técnicas de alto nível

- **Só no desktop.** A versão web é um script que a pessoa roda quando quer (no terminal, no tmux, por SSH); subir com o sistema é trabalho de quem a executa (um serviço do sistema, por exemplo), e a página não tem como registrar isso. Isso atende à regra do PRD do desktop de que uma feature que não chega às duas versões diz por quê.
- **Sem privilégio de administrador** para ligar ou desligar.
- **Linux e Windows**, cada um pelo mecanismo de início de sessão do próprio sistema, nas formas de instalação suportadas.
- **Metas do PRD do desktop** continuam valendo: subir no login não pode passar de 150 MB de RAM ocioso.

## Fora de escopo

- **Atalho global** e **vários daemons ao mesmo tempo**, que continuam fora de escopo no PRD do desktop.
- **Ligado por padrão** ou perguntar na primeira vez que fecha a janela: a pessoa escolhe nas preferências.
- **Atraso configurável** antes de subir.
- **macOS**, que continua fora do desktop.
- **Script ou serviço de sistema para a versão web.** Consideração futura: documentar no README como rodar o `docker_gui.py --no-browser` como serviço do usuário.

## Histórico

**2026-10-21**. Documento criado. "Iniciar com o sistema" sai do fora de escopo do [PRD do desktop](../prd-desktop-tauri/prd.md), atualizado junto. Decisões: desligado por padrão, ligado pelas preferências, sobe direto na bandeja.
