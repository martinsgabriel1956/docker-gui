# PRD: Dependência que segurou o serviço

## Visão geral

Num projeto compose, um serviço muitas vezes não sobe por causa de outro: a `api` tem `depends_on: db: condition: service_healthy`, o `db` nunca fica saudável, e a `api` fica parada em "Created" ou cai ao tentar conectar. Hoje a faixa de atenção mostra a `api` e o `db` lado a lado, cada um com o seu status, e cabe à pessoa lembrar do arquivo do compose para perceber que o problema da `api` é o `db`. Pior: a `api` em "Created" não está na faixa (não saiu com erro), e o `compose up` pelo terminal só diz "dependency failed to start".

O compose grava as dependências de cada serviço nos labels do container, que a página já lê. A feature usa isso para dizer, no serviço que não está de pé, qual dependência o segura, e para pôr a causa-raiz primeiro.

## Objetivos

- Num projeto em que uma dependência está quebrada, a faixa diz em cada dependente qual dependência o segura, sem a pessoa abrir o arquivo do compose.
- A causa-raiz aparece antes dos dependentes na faixa.
- Nenhuma consulta nova ao daemon: as dependências vêm dos labels já lidos.

## Histórias de usuário

- Como dev, quando a `api` não sobe, eu quero ver "depende de db, que está com healthcheck falhando", para ir direto ao `db` em vez de ler os logs da `api`.
- Como dev, eu quero ir da `api` para o `db` com um clique, porque o próximo passo é ver os logs do `db`.
- Como dev, eu quero ver o `db` antes da `api` na faixa, porque consertar o `db` conserta os dois.
- **Borda:** dependência em cadeia (`web` → `api` → `db`). Cada dependente aponta para a dependência direta que está quebrada; seguir os links leva à raiz. A raiz vem primeiro.
- **Borda:** a dependência não tem container (foi removida, ou está atrás de um profile). O dependente diz que a dependência não existe, usando a lista de serviços sem container que a página já tem.
- **Borda:** a dependência está de pé e saudável, e mesmo assim a `api` caiu. Nenhuma anotação: a causa é da própria `api`.
- **Borda:** dependência com `condition: service_started` ou `service_completed_successfully`. A anotação considera a condição: um `migrate` que saiu com 0 não segura ninguém; um que saiu com erro segura.
- **Borda:** container fora do compose. Nada muda.

## Funcionalidades principais

### 1. Anotar a causa no dependente

1. **RF1.1** Um container de um serviço do compose que não está de pé (ou que está na faixa) e tem uma dependência direta que não cumpre a condição declarada no compose ganha a anotação "depende de `<serviço>`, que `<estado traduzido>`" (por exemplo, "que está com healthcheck falhando", "que saiu com código 1", "que está parado", "que não tem container").
2. **RF1.2** O container que não sobe por causa de uma dependência ("Created" e nunca iniciado) entra na faixa de atenção com essa anotação, mesmo sem ter saído com erro.
3. **RF1.3** A anotação aponta só para a dependência direta. Com mais de uma dependência quebrada, lista todas.
4. **RF1.4** O nome da dependência na anotação leva aos logs dela.
5. **RF1.5** Quando a dependência volta a cumprir a condição, a anotação some na próxima atualização da lista.

### 2. Causa-raiz primeiro

1. **RF2.1** Na faixa, um container que segura outros vem antes dos que ele segura.
2. **RF2.2** O container que segura outros diz quantos ("segurando api, worker").

### 3. Notificações

1. **RF3.1** As regras de notificação continuam as de hoje. Quando a raiz e os dependentes entram juntos na faixa, a notificação agrupada lista a raiz primeiro.

## Experiência do usuário

- A anotação aparece no status do dependente, abaixo da causa própria (se houver), no mesmo tom: o dependente continua com o seu estado, a anotação explica o motivo.
- O link para a dependência é um botão com nome acessível ("Abrir logs de db"), alcançável pelo teclado.
- No agrupamento por projeto, fora da faixa, nada muda; a anotação vive na faixa e no modal de logs do dependente.
- Português e inglês.

## Restrições técnicas de alto nível

- **As duas versões** (web e desktop) recebem a feature.
- **As dependências vêm só dos labels** que o compose grava no container. Versões do compose que não gravam o label não têm a anotação, sem erro.
- **Podman com `podman compose` / `podman-compose`**: só funciona se as dependências estiverem nos labels; senão, nada muda.
- **Sem consulta nova** ao daemon e **sem ler o arquivo do compose** para isso.

## Fora de escopo

- **Grafo de dependências** do projeto desenhado na tela.
- **Iniciar a dependência** a partir da anotação (a pessoa usa o Iniciar do próprio `db`).
- **Dependências entre projetos diferentes** ou por rede (`links`, `external_links`, um serviço que só conecta pelo nome).
- **Esconder os dependentes** da faixa e mostrar só a raiz.

## Histórico

**2026-10-21**. Documento criado. Decisão: a causa é anotada no dependente, que continua na faixa; a raiz vem primeiro.
