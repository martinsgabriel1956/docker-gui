# Docker GUI

Gerenciador de containers Docker no navegador, num arquivo Python só. Usa apenas a biblioteca padrão e o `docker` CLI que você já tem.

```bash
python3 docker_gui.py
```

O comando abre o navegador em `http://localhost:8765` com um token de acesso. O link também aparece no terminal. Se a 8765 estiver ocupada, ele usa a próxima porta livre (até a 8774). Para escolher a porta, use `--port`:

```bash
python3 docker_gui.py --port 9000
```

Para usar o [Podman](https://podman.io) no lugar do Docker, ou outro contexto do Docker (um daemon remoto, por exemplo), use `--cli` e `--context`. O `--cli` também pode vir da variável `DOCKER_GUI_CLI`. Sem `--context`, vale o `DOCKER_CONTEXT` do ambiente ou o contexto atual (`docker context use`):

```bash
python3 docker_gui.py --cli podman
DOCKER_GUI_CLI=podman python3 docker_gui.py
python3 docker_gui.py --context producao
```

A saída do `podman ps` tem outro formato (`Names` em lista, portas como objetos, labels como dicionário…), e a do `podman stats` também (`cpu_percent`, `net_io`…; pelo `podman-docker`, números crus). O servidor converte tudo para o formato do `docker ps` e do `docker stats`, então a página funciona igual. O mesmo vale para as listas de imagens (tamanho em bytes, data em epoch), volumes e redes (chaves em minúsculas no Podman 4+). Uma rede que venha sem ID (formatos antigos do Podman) aparece na lista, mas sem o botão de remover. O "Copiar `docker exec`" usa o mesmo binário e contexto.

## O que faz

- **Lista ao vivo** de todos os containers, atualizada pelos eventos do `docker events`: quando um container é criado, sobe, cai, pausa ou muda de saúde (`health_status`), a lista é consultada de novo em até 200 ms, e uma rajada (um `compose up`, por exemplo) vira uma consulta só. Os `exec` que o healthcheck roda a cada intervalo são ignorados. Como o Docker não avisa a passagem do tempo ("Up 5 minutes"), um poll de segurança roda a cada 30s. Se o stream de eventos cair, for recusado ou não existir (um Podman antigo, por exemplo), a lista volta ao poll de 2s e tenta os eventos de novo depois de 30s. Só as linhas que mudaram são redesenhadas, e com a aba escondida a página para de consultar e fecha o stream (a não ser com as notificações ligadas).
- **CPU e memória** de cada container rodando, do `docker stats`, atualizadas a cada 5s (num poll à parte, porque o stats leva uns 2s para medir), com um **sparkline** de cada uma: as últimas 60 leituras (uns 5 a 7 min, conforme o stats demora), guardadas só na página. O leitor de tela (e o mouse, no hover) recebe o mínimo, o máximo e o valor atual. Se a aba ficar escondida, o histórico recomeça ao voltar, em vez de ligar os pontos por cima do buraco.
- **Rede e disco** (`NetIO` e `BlockIO`, totais desde que o container subiu) no title do uso de recursos e no modal de logs, com sparklines maiores, para não poluir a tabela.
- **Faixa "Precisa de atenção"** com o que está quebrado: healthcheck falhando, loop de reinício e saída com código diferente de zero. O status vem traduzido, por exemplo "Saiu com código 137 · morto à força ou sem memória (OOM)".
- **Favicon com a contagem** da faixa de atenção (`9+` acima de 9) e `!` quando a lista não consegue atualizar.
- **Notificação do sistema** quando um container entra na faixa de atenção, só se você pedir pelo botão "Notificar quando algo der problema", abaixo da busca. O botão aparece em contexto seguro (`localhost` é) enquanto a permissão não foi decidida. A notificação só sai com a página em segundo plano (aba escondida ou janela sem foco): `<nome> precisa de atenção`, com o status no corpo, ou `N containers precisam de atenção`, com os nomes, quando entram vários juntos. Quem já estava na faixa ao abrir a página não notifica e quem continua nela não repete; sair e voltar conta como entrada nova. Clicar na notificação traz a página para a frente. No Chrome do Android ela não aparece, e fica só o favicon.
- **Agrupamento por projeto do compose** (`com.docker.compose.project`), com **Iniciar / Reiniciar / Parar tudo** e "Iniciar de novo" para desfazer.
- **`compose up` / `up --build` / `pull` / `down` por projeto**, com a pasta e os arquivos do compose lidos dos labels dos containers (o servidor nunca confia num caminho vindo da página). O `down` pede confirmação em 2 passos: os volumes ficam, mas o projeto some da lista e só volta com `up` pelo terminal.
- **Reiniciar um serviço** pelo menu "⋯" de um container do compose: `docker compose restart <serviço>`, que reinicia todas as réplicas do serviço e depois confere se ficaram de pé. O nome do serviço também sai dos labels: o servidor só aceita um serviço que exista no projeto.
- **Logs do projeto inteiro** pelo botão Logs do cabeçalho do projeto: `docker compose logs`, no mesmo modal dos logs de um container, com o prefixo do serviço em cada linha (`api-1  | …`) e em ordem cronológica. O ao vivo também funciona e para quando todos os containers do projeto param. O filtro e o "Carregar mais" valem aqui também, mas o histórico conta por container: "últimas 500 linhas" são 500 de cada um.
- Projetos compose só aparecem enquanto têm algum container (rodando ou parado): a pasta do projeto vem dos labels, então um projeto que nunca subiu ou que levou `down` não tem de onde ser lido.
- **Criar container** ("+ Novo container"): um `docker run -d` com poucas opções: imagem (`repo[:tag]` ou `repo@sha256:…`), nome, portas (`hostPort:containerPort[/tcp|udp]`), variáveis de ambiente (`CHAVE=valor`, uma por linha), restart policy (`no`, `on-failure`, `unless-stopped` ou `always`) e um volume nomeado (`nome:/caminho/no/container`). As portas ficam em `127.0.0.1` (só a sua máquina acessa); publicar em `0.0.0.0` é uma caixa à parte, com aviso. Se a imagem faltar, o `run` a baixa antes (até 10 min). Depois, como no Iniciar, a ferramenta confere se o container ficou de pé. O Podman aceita as mesmas flags.
  De propósito, fica de fora tudo que dá ao container acesso ao host e o comando livre: pasta do host (bind mount), `--privileged`, `--cap-add`, `--network host`, `--pid host`, devices e comando ou entrypoint próprio. Para isso, use o terminal.
- **Ações por container:** iniciar, parar, reiniciar, pausar, retomar e remover (com confirmação em 2 passos). Depois de iniciar, a ferramenta confere se o container ficou de pé. Depois de pausar, o aviso oferece "Retomar" (atalho `Z`).
- **Ações em lote:** marque containers pela caixa de cada linha (ou "Selecionar todos os visíveis", que respeita os filtros e a busca) e use a barra que aparece: Iniciar, Parar, Reiniciar e Remover, cada um contando só os selecionados em que a ação faz sentido. Remover pede confirmação em 2 passos e mostra quantos vão ser apagados. As ações rodam no máximo 4 por vez e o aviso junta o resultado ("3 parados, 1 falhou: web: …"), com o erro de cada falha na linha. Depois de parar, o aviso oferece "Iniciar de novo" (atalho `Z`). A seleção atravessa o redesenho e perde sozinha os containers que somem.
- **Logs** com timestamps, acompanhamento ao vivo, botões de copiar e de baixar (.log) e ações no próprio modal. Mostra também a saída do último healthcheck.
- **Filtro nos logs:** mostra só as linhas que contêm o texto (sem diferenciar maiúsculas, sem regex), com o trecho marcado e a contagem de ocorrências. Vale também para o que chega ao vivo. Copiar e Baixar levam o que está na tela, então com o filtro saem só as linhas filtradas. `Esc` no campo limpa o filtro; com o campo vazio, fecha o modal.
- **Mais histórico nos logs:** o modal abre com as últimas 500 linhas, e "Carregar mais" pede 2.000, 10.000 e depois o log inteiro. Ao vivo, vai até 10.000 (o limite de linhas na tela acompanha); para o log inteiro, desligue o ao vivo. Quando o log é menor que o pedido, o botão avisa que já está tudo ali.
- **Configuração** no modal de logs: restart policy, redes, mounts e env, do `docker inspect`. Os valores do env chegam mascarados e só saem do servidor quando você clica em Revelar.
- **Portas:** as HTTP abrem no navegador; as outras (Postgres, Redis…) copiam `localhost:porta`.
- **Terminal no navegador** pelo menu "⋯" ("Abrir terminal"): um `docker exec -it` com bash (ou sh, se a imagem não tiver bash) num terminal [xterm.js](https://xtermjs.org) embutido. Redimensiona junto com a janela, e o `Esc` vai para o programa (vim, less), não fecha o modal. No Windows o Python não tem PTY, então o TTY é aberto dentro do container pelo `script` (util-linux ou busybox: imagens Debian, Ubuntu, busybox…). Em imagem sem `script` (Alpine, por exemplo) o terminal abre sem TTY e avisa: comandos simples funcionam, mas vim, less, Tab e Ctrl+C não.
- **Copiar `docker exec -it <nome> sh`** pelo menu "⋯".
- **Uso de disco** (`docker system df`) de imagens, volumes e build cache, com **limpeza** (`prune`) de cada categoria, confirmada em 2 passos como a remoção. Imagens e build cache saem com `-a` (tudo que está sem uso); volumes sem `-a`, então no Docker 23+ os nomeados ficam.
- **Imagens, volumes e redes um a um**, na mesma seção: imagens com tags, ID, tamanho, idade e "sem tag" (dangling); volumes com driver; redes com driver e escopo, com as padrão (`bridge`, `host`, `none`) marcadas. Cada item diz quais containers o usam (parados também). Cada lista só consulta o docker quando é aberta. **Remover** usa a mesma confirmação em 2 passos, sem `-f`: o que está em uso o docker recusa, e o erro aparece no item com uma explicação ("Em uso: remova o container que usa antes"). As redes padrão não têm o botão, e o servidor recusa removê-las. Uma imagem com mais de uma tag o docker só remove com `-f`, que a página não usa: remova as tags pelo terminal.
- **Teclado:** `/` vai para a busca (com o modal de logs aberto, para o filtro das linhas), `↑` `↓` andam entre os botões Logs, `X` marca ou desmarca a linha em foco, `A` marca ou desmarca todos os visíveis e `Z` aciona o "desfazer". O `Ctrl+F` continua sendo a busca do navegador. Os filtros ficam na URL.
- Tema **claro e escuro** automático, layout de **cards no celular** e acessibilidade AA (contraste, foco, leitores de tela, `prefers-reduced-motion`).

## Requisitos

- Python 3.7+
- Docker, com o seu usuário com acesso ao daemon (`docker ps` funcionando sem `sudo`), ou Podman

Não precisa instalar nada. O CSS já vem embutido no arquivo, então funciona offline.

## Segurança

O servidor só escuta em `127.0.0.1` e foi pensado para uso local em máquina de desenvolvimento.

| Proteção | Contra |
|---|---|
| Escuta só em `127.0.0.1` | Acesso pela rede |
| Token aleatório por execução, exigido no cabeçalho `X-Docker-GUI-Token` | Containers com `network_mode: host`, outros usuários e outros processos na máquina |
| Cabeçalho próprio, sem CORS | Sites maliciosos chamando a API pelo seu navegador (CSRF) |
| Validação do cabeçalho `Host` | DNS rebinding |
| IDs só em hex (nome de volume só com `[a-zA-Z0-9][a-zA-Z0-9_.-]*`), listas fixas de ações e de parâmetros (o histórico dos logs só aceita 500, 2000, 10000 ou tudo) e nenhum shell no host | Injeção de comando |
| Compose: pasta, arquivos e serviços só dos labels dos containers; o nome do serviço vai depois de um `--` | Página (ou script) apontando o `docker compose` para outra pasta, outro arquivo ou uma flag |
| Remoção de rede confere o nome pelo próprio docker e recusa `bridge`, `host`, `none` (e a `podman`) | Derrubar a rede padrão do daemon |
| Criar container: corpo JSON de até 64 KiB, cada campo conferido por regex ou lista fixa, campo desconhecido recusa o pedido, argv montado item a item, nenhum valor começa com `-` e `--` antes da imagem | Injeção de flags (`--privileged`, `-v /:/host`…) e de comando |
| Criar container: só volume nomeado (via `--mount type=volume`), sem bind mount, `--privileged`, `--cap-add`, rede/PID do host, devices nem comando livre | Container criado pela página com acesso ao host (`/` montado, `--privileged`): a GUI não amplia o que o `docker` já permite |
| Criar container: portas publicadas em `127.0.0.1`; `0.0.0.0` só marcando a caixa, com aviso | Serviço de desenvolvimento exposto para a rede (o Docker passa por cima do ufw/firewalld) |
| Criar container: o env sempre vai como `-e CHAVE=valor` (com `=`) | `-e CHAVE` sozinho, que copiaria a variável do ambiente do próprio `docker_gui.py` para o container |
| Terminal: `Origin` conferido (só a própria página) e token na query do WebSocket | Sites maliciosos abrindo um shell no container pelo seu navegador (cross-site WebSocket hijacking) |
| Timeout em toda chamada ao `docker` (15 s para leitura, 120 s para ações e para o log inteiro, 10 min para `run` e `compose`, que podem baixar imagens) | Daemon travado acumulando threads presas |
| Streams (logs ao vivo, eventos da lista) encerram o `docker` quando a aba fecha; no máximo 8 streams de eventos ao mesmo tempo | Abas esquecidas acumulando processos e threads |

O token chega à página pelo `#fragmento` do link: o fragmento não é enviado ao servidor e sai da URL assim que a página carrega. Ele fica no `localStorage`, que é isolado por porta, e não em cookie, que vazaria para outros servidores em `localhost`. Cada execução gera um token novo. Se a página mostrar "sem token", abra o link impresso no terminal.

O WebSocket e o `EventSource` do navegador não mandam cabeçalho próprio, por isso o terminal e os streams (logs ao vivo, de um container ou do projeto, e eventos da lista, só leitura) levam o token na query (`/api/exec/<id>?t=…`, `/api/logs/<id>/stream?t=…`, `/api/compose/logs/stream?…&t=…`, `/api/events/stream?t=…`). As outras rotas só aceitam o cabeçalho. O servidor não registra URLs, e o stream de eventos só avisa que algo mudou: o evento em si não sai do servidor. Fechar o terminal mata o `docker exec`, mas o shell dentro do container nem sempre morre junto ([moby#9098](https://github.com/moby/moby/issues/9098)): um processo que você deixou rodando nele pode continuar até o container parar.

> Quem consegue rodar `docker` na sua máquina já tem poder equivalente ao de root. O token impede que a GUI amplie esse acesso, mas não substitui o cuidado com quem está no grupo `docker`.

## Desenvolvimento

Quem usa baixa só o `docker_gui.py` e não precisa de nada além de Python. Para desenvolver, o front fica em `src/`, escrito em [TypeScript](https://www.typescriptlang.org), e o `build.py` compila e embute tudo no `docker_gui.py`:

| Arquivo | O que tem |
|---|---|
| `docker_gui.py` | Servidor (Python, editado à mão) + bloco gerado no fim, com HTML, JS compilado e CSS |
| `src/page.html` | Estrutura da página |
| `src/format.ts` | Tipos (`Container`, `Port`…) e funções puras que traduzem a saída do `docker` (status, portas, projeto, tamanhos do `stats`, pontos do sparkline…) |
| `src/app.ts` | Renderização, ações e eventos; no fim, a lista das funções que o HTML chama (`onclick="act(...)"`) |
| `src/theme.css` | Entrada do [Tailwind CSS v4](https://tailwindcss.com) com os **tokens semânticos** dos dois temas (`bg-canvas`, `text-muted`, `bg-ok`, `text-bad-fg`, `bg-accent`…) |

As ferramentas de desenvolvimento ficam no `package.json` (TypeScript, [esbuild](https://esbuild.github.io), Playwright), com versões fixas no lockfile. Depois de mudar algo em `src/`, confira os tipos e rode o build. O `tsc` só checa; quem gera o JS é o esbuild, num único script. Se você usou uma classe do Tailwind nova ou mexeu nos tokens, regenere também o CSS:

```bash
npm ci                   # uma vez
npm run typecheck        # tsc
python3 build.py         # HTML e JS
python3 build.py --css   # HTML, JS e CSS
```

Não edite o bloco gerado do `docker_gui.py` à mão: o CI confere se ele bate com `src/`.

## Testes

Os testes do backend usam só a biblioteca padrão. O `docker` é trocado por mock, então não precisa de daemon:

```bash
python3 -m unittest
```

Para rodar também o fluxo completo contra o Docker de verdade (cria e remove um container `busybox`):

```bash
DOCKER_GUI_E2E=1 python3 -m unittest
```

O terminal do Windows (sem PTY no host) também roda em Linux com `DOCKER_GUI_TERMINAL=pipe`. É assim que os testes o cobrem, inclusive contra o Docker de verdade.

As funções de `src/format.ts` têm testes próprios. O Node (22.18+) importa o `.ts` direto, sem build:

```bash
node --test tests/format.test.js
```

Os testes de UI usam o [Playwright](https://playwright.dev) e cobrem o que a página faz na tela: agrupamento e faixa de atenção, filtros e atalhos, ações (incluindo a remoção em 2 passos e o "conferindo se ficou de pé"), criação de container, seleção e ações em lote (falha parcial, limite de 4 por vez), modal de logs (filtro e mais histórico, também ao vivo), terminal, healthcheck, sparklines do stats, estados de erro o que o redesenho preserva (foco, seleção de texto, menus abertos) e a lista ao vivo (eventos, rajadas e a volta ao poll de 2 s). Cada teste sobe o próprio `docker_gui.py` contra um `docker` falso (`tests/e2e/fake-docker/docker`), que lê os containers de um JSON (e, no `docker events`, avisa qualquer mudança nele). Assim dá para montar cenários exatos (healthcheck falhando, loop de reinício, ação que falha ou demora, `stats` que muda a cada leitura) sem precisar de daemon:

```bash
npx playwright install chromium   # uma vez
npm run test:e2e
```

O CI roda tudo isso em cada pull request e em cada push na `main` e na `develop`: lint (`ruff check`), testes em Python 3.7 a 3.14, E2E com Docker real, tipos (`tsc`) e testes do `format.ts`, testes de UI com Playwright, e a conferência de que o `docker_gui.py` está em dia com `src/`, CSS incluído.

## Licença

[MIT](LICENSE)
