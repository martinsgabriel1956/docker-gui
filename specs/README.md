# Specs

Uma linha por feature: PRD, techspec e status.

- [Stivo desktop](prd-desktop-tauri/prd.md) — app instalável (Tauri) para Linux e Windows com paridade com a versão web, vigilância na bandeja e notificações; convive com o `docker_gui.py`. status: implementado ([PR #44](https://github.com/martinsgabriel1956/docker-gui/pull/44), [techspec](prd-desktop-tauri/techspec.md))
- [Alerta de memória](prd-alerta-memoria/prd.md) — container com limite de memória entra na faixa de atenção (e notifica) ao passar de 90% do limite, antes do OOM. status: implementado ([techspec](prd-alerta-memoria/techspec.md))
- [Iniciar com o sistema](prd-iniciar-com-sistema/prd.md) — opção do desktop para subir no login direto na bandeja; desligada por padrão. status: implementado ([techspec](prd-iniciar-com-sistema/techspec.md))
- [Histórico do healthcheck](prd-historico-healthcheck/prd.md) — as 5 últimas execuções do probe no modal de logs, com duração, código e saída. status: implementado ([techspec](prd-historico-healthcheck/techspec.md))
- [Dependência que segurou o serviço](prd-dependencia-compose/prd.md) — a faixa diz qual dependência do compose segura o serviço, com a causa-raiz primeiro. status: implementado ([techspec](prd-dependencia-compose/techspec.md))
- [Mudanças no filesystem](prd-diff-container/prd.md) — o `docker diff` do container no modal de logs, com filtro. status: implementado ([techspec](prd-diff-container/techspec.md))
- [Abrir a pasta do projeto](prd-abrir-pasta-projeto/prd.md) — abre a pasta do projeto compose no gerenciador de arquivos (desktop) ou copia o caminho (web). status: implementado ([techspec](prd-abrir-pasta-projeto/techspec.md))
- [Baixar e atualizar imagens](prd-pull-imagens/prd.md) — `docker pull` pela aba Imagens: baixar pelo nome e atualizar uma tag existente. status: implementado ([techspec](prd-pull-imagens/techspec.md))
- [Baixar arquivo do container](prd-baixar-arquivo-container/prd.md) — baixa um arquivo ou uma pasta (`.tar`) de dentro do container, também parado. status: implementado ([techspec](prd-baixar-arquivo-container/techspec.md))
