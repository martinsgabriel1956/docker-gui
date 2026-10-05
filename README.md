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

A saída do `podman ps` tem outro formato (`Names` em lista, portas como objetos, labels como dicionário…). O servidor converte tudo para o formato do `docker ps`, então a página funciona igual. O "Copiar `docker exec`" usa o mesmo binário e contexto.

## O que faz

- **Lista ao vivo** de todos os containers, atualizada a cada 2s. Só as linhas que mudaram são redesenhadas, e o poll pausa quando a aba fica escondida.
- **CPU e memória** de cada container rodando, do `docker stats`, atualizadas a cada 5s (num poll à parte, porque o stats leva uns 2s para medir).
- **Faixa "Precisa de atenção"** com o que está quebrado: healthcheck falhando, loop de reinício e saída com código diferente de zero. O status vem traduzido, por exemplo "Saiu com código 137 · morto à força ou sem memória (OOM)".
- **Agrupamento por projeto do compose** (`com.docker.compose.project`), com **Iniciar / Reiniciar / Parar tudo** e "Iniciar de novo" para desfazer.
- **`compose up` / `pull` / `down` por projeto**, com a pasta e os arquivos do compose lidos dos labels dos containers (o servidor nunca confia num caminho vindo da página). O `down` pede confirmação em 2 passos: os volumes ficam, mas o projeto some da lista e só volta com `up` pelo terminal.
- **Criar container** ("+ Novo container"): um `docker run -d` com poucas opções: imagem (`repo[:tag]` ou `repo@sha256:…`), nome, portas (`hostPort:containerPort[/tcp|udp]`), variáveis de ambiente (`CHAVE=valor`, uma por linha), restart policy (`no`, `on-failure`, `unless-stopped` ou `always`) e um volume nomeado (`nome:/caminho/no/container`). As portas ficam em `127.0.0.1` (só a sua máquina acessa); publicar em `0.0.0.0` é uma caixa à parte, com aviso. Se a imagem faltar, o `run` a baixa antes (até 10 min). Depois, como no Iniciar, a ferramenta confere se o container ficou de pé. O Podman aceita as mesmas flags.
  De propósito, fica de fora tudo que dá ao container acesso ao host e o comando livre: pasta do host (bind mount), `--privileged`, `--cap-add`, `--network host`, `--pid host`, devices e comando ou entrypoint próprio. Para isso, use o terminal.
- **Ações por container:** iniciar, parar, reiniciar, pausar, retomar e remover (com confirmação em 2 passos). Depois de iniciar, a ferramenta confere se o container ficou de pé. Depois de pausar, o aviso oferece "Retomar" (atalho `Z`).
- **Logs** com timestamps, acompanhamento ao vivo, botões de copiar e de baixar (.log) e ações no próprio modal. Mostra também a saída do último healthcheck.
- **Configuração** no modal de logs: restart policy, redes, mounts e env, do `docker inspect`. Os valores do env chegam mascarados e só saem do servidor quando você clica em Revelar.
- **Portas:** as HTTP abrem no navegador; as outras (Postgres, Redis…) copiam `localhost:porta`.
- **Terminal no navegador** pelo menu "⋯" ("Abrir terminal"): um `docker exec -it` com bash (ou sh, se a imagem não tiver bash) num terminal [xterm.js](https://xtermjs.org) embutido. Redimensiona junto com a janela, e o `Esc` vai para o programa (vim, less), não fecha o modal. Só em Linux e macOS.
- **Copiar `docker exec -it <nome> sh`** pelo menu "⋯".
- **Uso de disco** (`docker system df`) de imagens, volumes e build cache, com **limpeza** (`prune`) de cada categoria, confirmada em 2 passos como a remoção. Imagens e build cache saem com `-a` (tudo que está sem uso); volumes sem `-a`, então no Docker 23+ os nomeados ficam.
- **Teclado:** `/` vai para a busca, `↑` `↓` andam entre os botões Logs e `Z` aciona o "desfazer". Os filtros ficam na URL.
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
| IDs só em hex, lista fixa de ações e nenhum shell no host | Injeção de comando |
| Criar container: corpo JSON de até 64 KiB, cada campo conferido por regex ou lista fixa, campo desconhecido recusa o pedido, argv montado item a item, nenhum valor começa com `-` e `--` antes da imagem | Injeção de flags (`--privileged`, `-v /:/host`…) e de comando |
| Criar container: só volume nomeado (via `--mount type=volume`), sem bind mount, `--privileged`, `--cap-add`, rede/PID do host, devices nem comando livre | Container criado pela página com acesso ao host (`/` montado, `--privileged`): a GUI não amplia o que o `docker` já permite |
| Criar container: portas publicadas em `127.0.0.1`; `0.0.0.0` só marcando a caixa, com aviso | Serviço de desenvolvimento exposto para a rede (o Docker passa por cima do ufw/firewalld) |
| Criar container: o env sempre vai como `-e CHAVE=valor` (com `=`) | `-e CHAVE` sozinho, que copiaria a variável do ambiente do próprio `docker_gui.py` para o container |
| Terminal: `Origin` conferido (só a própria página) e token na query do WebSocket | Sites maliciosos abrindo um shell no container pelo seu navegador (cross-site WebSocket hijacking) |
| Timeout em toda chamada ao `docker` (15 s para leitura, 120 s para ações, 10 min para `run` e `compose`, que podem baixar imagens) | Daemon travado acumulando threads presas |

O token chega à página pelo `#fragmento` do link: o fragmento não é enviado ao servidor e sai da URL assim que a página carrega. Ele fica no `localStorage`, que é isolado por porta, e não em cookie, que vazaria para outros servidores em `localhost`. Cada execução gera um token novo. Se a página mostrar "sem token", abra o link impresso no terminal.

O WebSocket do navegador não manda cabeçalho próprio, por isso o terminal leva o token na query (`/api/exec/<id>?t=…`). O servidor não registra URLs. Fechar o terminal mata o `docker exec`, mas o shell dentro do container nem sempre morre junto ([moby#9098](https://github.com/moby/moby/issues/9098)): um processo que você deixou rodando nele pode continuar até o container parar.

> Quem consegue rodar `docker` na sua máquina já tem poder equivalente ao de root. O token impede que a GUI amplie esse acesso, mas não substitui o cuidado com quem está no grupo `docker`.

## Desenvolvimento

Quem usa baixa só o `docker_gui.py` e não precisa de nada além de Python. Para desenvolver, o front fica em `src/`, escrito em [TypeScript](https://www.typescriptlang.org), e o `build.py` compila e embute tudo no `docker_gui.py`:

| Arquivo | O que tem |
|---|---|
| `docker_gui.py` | Servidor (Python, editado à mão) + bloco gerado no fim, com HTML, JS compilado e CSS |
| `src/page.html` | Estrutura da página |
| `src/format.ts` | Tipos (`Container`, `Port`…) e funções puras que traduzem a saída do `docker` (status, portas, projeto…) |
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

As funções de `src/format.ts` têm testes próprios. O Node (22.18+) importa o `.ts` direto, sem build:

```bash
node --test tests/format.test.js
```

Os testes de UI usam o [Playwright](https://playwright.dev) e cobrem o que a página faz na tela: agrupamento e faixa de atenção, filtros e atalhos, ações (incluindo a remoção em 2 passos e o "conferindo se ficou de pé"), criação de container, modal de logs, terminal, healthcheck, estados de erro e o que o redesenho a cada 2 s preserva (foco, seleção de texto, menus abertos). Cada teste sobe o próprio `docker_gui.py` contra um `docker` falso (`tests/e2e/fake-docker/docker`), que lê os containers de um JSON. Assim dá para montar cenários exatos (healthcheck falhando, loop de reinício, ação que falha ou demora) sem precisar de daemon:

```bash
npx playwright install chromium   # uma vez
npm run test:e2e
```

O CI roda tudo isso em cada pull request e em cada push na `main` e na `develop`: lint (`ruff check`), testes em Python 3.7 a 3.14, E2E com Docker real, tipos (`tsc`) e testes do `format.ts`, testes de UI com Playwright, e a conferência de que o `docker_gui.py` está em dia com `src/`, CSS incluído.

## Licença

[MIT](LICENSE)
