# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Quem desenvolve, na própria máquina, com containers Docker (ou Podman) rodando o projeto em que está trabalhando. O trabalho é um ciclo curto e repetido: mudar o código, reiniciar o container (ou o serviço do compose) e ler os logs para ver se ficou de pé.

## Product Purpose

Gerenciar os containers locais pelo navegador sem decorar comandos: ver o que está rodando, o que quebrou e por quê, agir (iniciar, parar, reiniciar, remover, compose up/down), ler logs ao vivo e abrir um terminal no container. Sucesso é responder "o que quebrou e por quê" sem clique e fechar o ciclo reiniciar → ler logs sem sair da página.

## Positioning

Um arquivo Python só, que usa só a biblioteca padrão e o `docker` CLI que a pessoa já tem: nada para instalar, funciona offline. Fala a língua do CLI (os menus usam os verbos do `docker` e do `compose`) e traduz a saída dele (código de saída, healthcheck, loop de reinício) em causa legível.

## Operating Context

- Roda com `python3 docker_gui.py`; abre o navegador num link com token. Uso em janela ao lado do editor e do terminal.
- Lista ao vivo pelos eventos do `docker events`, com poll de segurança.
- Contextos do Docker (daemon remoto) e Podman funcionam; daemon remoto é sinalizado o tempo todo.
- Interface em pt-BR ou em inglês, pelo locale do sistema ou pelo `--lang`.

## Capabilities and Constraints

- Servidor escuta só em `127.0.0.1`, exige token por execução, valida `Host` e `Origin`; nenhum shell no host; argumentos validados por lista fixa ou regex.
- A GUI nunca amplia o que o `docker` já permite: sem bind mount, `--privileged`, `--cap-add`, rede/PID do host, devices ou comando livre no "Novo container".
- Ações destrutivas (remover, compose down, prune) sempre com confirmação em 2 passos.
- Front em TypeScript + Tailwind v4, compilado e embutido no `docker_gui.py` pelo `build.py`; CI confere que o bloco gerado está em dia.
- Testes: unittest (backend, docker mockado), node:test (format.ts) e Playwright contra um docker falso.

## Brand Commitments

- Nome: Docker GUI. Sem logo próprio.
- Voz: pt-BR direto (em inglês, o mesmo tom), frases curtas, verbos do CLI literais nos menus, confirmações que dizem o que sai e o que fica.

## Evidence on Hand

Nenhum depoimento, métrica de uso ou cliente. Não inventar.

## Product Principles

1. O ciclo mudar → reiniciar → ler logs é a razão de existir; ele nunca pode ficar a mais de um clique ou uma tecla.
2. Diagnosticar antes de listar: o que quebrou aparece primeiro, já com a causa traduzida.
3. Seguro por padrão: a GUI não amplia o acesso ao host, e toda ação destrutiva diz exatamente o que vai apagar, onde.
4. Falar a língua do CLI: o que a tela mostra corresponde ao comando que roda.
5. Nada para instalar: um arquivo, biblioteca padrão, offline.

## Accessibility & Inclusion

WCAG 2.2 AA: contraste, foco visível, leitor de tela (regiões vivas para ações e confirmações), teclado completo, `prefers-reduced-motion`, alvos de toque de 44px no celular.
