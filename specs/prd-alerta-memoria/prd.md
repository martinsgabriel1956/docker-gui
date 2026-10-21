# PRD: Alerta de memória perto do limite

## Visão geral

Hoje a faixa "Precisa de atenção" só mostra o que já quebrou. A falta de memória aparece depois do fato, como "Saiu com código 137 · sem memória (OOM)". Com um container que tem limite de memória (`--memory`, ou o `mem_limit` / `deploy.resources.limits.memory` do compose, comum para reproduzir o ambiente de produção), a queda costuma ser previsível: o uso sobe até o teto por minutos antes de o kernel matar o processo.

A página já lê o uso de memória de cada container a cada poucos segundos e desenha o sparkline, mas o número só aparece no title. Ninguém olha o sparkline enquanto está no editor.

A feature coloca na faixa de atenção o container que está perto do limite, antes de ele cair. Com isso, "o que vai quebrar e por quê" aparece antes do "o que quebrou" (princípio 2 do PRODUCT.md: diagnosticar antes de listar).

## Objetivos

- Um container que fica em 90% ou mais do limite por 2 leituras seguidas entra na faixa em até **15 s** desde a primeira leitura acima do limiar, na web e no desktop (com a janela fechada também).
- **Nenhum falso alerta** em container sem limite de memória.
- **Sem piscar:** um container oscilando perto de 90% não entra e sai da faixa a cada leitura.
- Quando a queda vem, ela é notificada, mesmo que o container já estivesse na faixa por memória.

## Histórias de usuário

- Como dev com um serviço que tem `mem_limit`, eu quero ser avisado quando ele se aproxima do limite, para pegar o vazamento antes do OOM e olhar os processos enquanto o container ainda está de pé.
- Como dev com o app na bandeja, eu quero receber a notificação "perto do limite de memória" com a janela fechada, como recebo a de queda.
- Como dev, eu quero ser avisado de novo quando o container que já estava perto do limite cair, porque a queda é mais grave que o aviso.
- **Borda:** container sem limite de memória usando muita RAM. Não entra na faixa por memória: sem limite, a porcentagem é da RAM da máquina, e o OOM do kernel não é do container.
- **Borda:** pico curto (um build, uma importação) que passa de 90% em uma leitura só. Não entra na faixa.
- **Borda:** o limite muda (o container é recriado com outro `mem_limit`). Vale o limite novo a partir da leitura seguinte.

## Funcionalidades principais

### 1. Entrar e sair da faixa por memória

Importa porque é a única forma de o aviso chegar antes da queda sem a pessoa olhar o sparkline.

1. **RF1.1** Um container rodando, com limite de memória, entra na faixa de atenção quando o uso fica em 90% ou mais do limite em 2 leituras seguidas.
2. **RF1.2** Ele sai da faixa por memória quando o uso fica abaixo de 85% do limite, ou quando para de rodar (aí valem as regras de hoje: se saiu com erro, continua na faixa pela queda).
3. **RF1.3** Um container sem limite de memória nunca entra na faixa por memória.
4. **RF1.4** Os limiares (90% para entrar, 85% para sair, 2 leituras) são fixos, sem configuração.
5. **RF1.5** A faixa conta o container uma vez só, mesmo que ele tenha mais de uma causa (por exemplo, healthcheck falhando e memória perto do limite). O status mostra as duas causas.

### 2. Status traduzido

1. **RF2.1** O status diz a causa com os números: "Memória em 93% do limite (476 MiB de 512 MiB)", em português e em inglês.
2. **RF2.2** O aviso de memória usa o tom de aviso (não o de erro), porque o container ainda está de pé.
3. **RF2.3** A partir da faixa, o caminho para os Processos do container (o `docker top` que já existe no modal de logs) fica a um clique, porque a pergunta seguinte é "qual processo?".

### 3. Contagem e notificações

1. **RF3.1** O container na faixa por memória conta no favicon (web) e na bandeja (desktop), como as outras causas.
2. **RF3.2** Entrar na faixa por memória gera notificação pelas regras de hoje: só quem entra, sem repetir quem continua, sem avisar o que já estava acima do limiar ao abrir, uma notificação agrupada quando vários entram juntos.
3. **RF3.3** Exceção à regra "quem continua na faixa não repete": um container que está na faixa por memória e cai (sai com erro, entra em loop de reinício ou é morto por OOM) gera nova notificação, com a causa da queda.
4. **RF3.4** No desktop, o alerta funciona com a janela fechada (app na bandeja), dentro da meta de aviso de 5 s depois que a condição do RF1.1 se cumpre.

## Experiência do usuário

- Na faixa, o container aparece com o status de memória e o tom de aviso, junto dos que já quebraram. Os que quebraram vêm antes: um container caído é mais urgente que um perto do limite.
- A notificação usa o mesmo formato de hoje: `<nome> precisa de atenção`, com "Memória em 93% do limite" no corpo.
- Leitor de tela: o status é texto, como os outros; a entrada na faixa usa a mesma região viva.
- Nada muda para quem não usa limite de memória.

## Restrições técnicas de alto nível

- **As duas versões** (web e desktop) recebem a feature.
- **Podman e contextos remotos** precisam funcionar como o resto da página: o Podman entrega o uso de memória em outro formato, e com daemon remoto o limite é o do container lá.
- **Não pode aumentar as consultas ao daemon** de forma perceptível: o uso de memória já é lido hoje para o sparkline. O limite de cada container precisa vir de algum lugar sem uma consulta extra a cada leitura.
- **Desktop em segundo plano:** a leitura de memória precisa continuar com a janela fechada, dentro das metas de recursos do PRD do desktop (até 150 MB de RAM ocioso).
- A versão web com a aba escondida segue a regra de hoje: só consulta em segundo plano com as notificações ligadas.

## Fora de escopo

- **Limiar configurável.** Fica fixo; vira consideração futura se 90% se mostrar errado na prática.
- **Containers sem limite**, inclusive alerta por porcentagem da RAM da máquina.
- **CPU perto do limite** (`--cpus`): CPU no teto deixa o container lento, não o derruba.
- **Previsão** ("vai estourar em 3 min") a partir da tendência do sparkline.
- **Disco cheio** de volume ou do daemon.

## Histórico

**2026-10-21**. Documento criado. Decisões: só containers com limite; 90% por 2 leituras para entrar e 85% para sair, fixos; notifica pelas regras de hoje; a queda de quem já estava na faixa por memória notifica de novo (RF3.3), o que muda a regra do RF2.4 do [PRD do desktop](../prd-desktop-tauri/prd.md), atualizado junto.
