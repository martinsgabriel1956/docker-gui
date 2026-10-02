# Docker GUI

Gerenciador de containers Docker no navegador, num arquivo Python só. Usa apenas a biblioteca padrão e o `docker` CLI que você já tem.

```bash
python3 docker_gui.py
```

O comando abre o navegador em `http://localhost:8765` com um token de acesso. O link também aparece no terminal. Se a 8765 estiver ocupada, ele usa a próxima porta livre (até a 8774). Para escolher a porta, use `--port`:

```bash
python3 docker_gui.py --port 9000
```

## O que faz

- **Lista ao vivo** de todos os containers, atualizada a cada 2s. Só as linhas que mudaram são redesenhadas, e o poll pausa quando a aba fica escondida.
- **Faixa "Precisa de atenção"** com o que está quebrado: healthcheck falhando, loop de reinício e saída com código diferente de zero. O status vem traduzido, por exemplo "Saiu com código 137 · morto à força ou sem memória (OOM)".
- **Agrupamento por projeto do compose** (`com.docker.compose.project`), com **Iniciar / Reiniciar / Parar tudo** e "Iniciar de novo" para desfazer.
- **Ações por container:** iniciar, parar, reiniciar, pausar, retomar e remover (com confirmação em 2 passos). Depois de iniciar, a ferramenta confere se o container ficou de pé. Depois de pausar, o aviso oferece "Retomar" (atalho `Z`).
- **Logs** com acompanhamento ao vivo, botão de copiar e ações no próprio modal. Mostra também a saída do último healthcheck.
- **Portas:** as HTTP abrem no navegador; as outras (Postgres, Redis…) copiam `localhost:porta`.
- **Copiar `docker exec -it <nome> sh`** pelo menu "⋯".
- **Teclado:** `/` vai para a busca, `↑` `↓` andam entre os botões Logs e `Z` aciona o "desfazer". Os filtros ficam na URL.
- Tema **claro e escuro** automático, layout de **cards no celular** e acessibilidade AA (contraste, foco, leitores de tela, `prefers-reduced-motion`).

## Requisitos

- Python 3.7+
- Docker, com o seu usuário com acesso ao daemon (`docker ps` funcionando sem `sudo`)

Não precisa instalar nada. O CSS já vem embutido no arquivo, então funciona offline.

## Segurança

O servidor só escuta em `127.0.0.1` e foi pensado para uso local em máquina de desenvolvimento.

| Proteção | Contra |
|---|---|
| Escuta só em `127.0.0.1` | Acesso pela rede |
| Token aleatório por execução, exigido no cabeçalho `X-Docker-GUI-Token` | Containers com `network_mode: host`, outros usuários e outros processos na máquina |
| Cabeçalho próprio, sem CORS | Sites maliciosos chamando a API pelo seu navegador (CSRF) |
| Validação do cabeçalho `Host` | DNS rebinding |
| IDs só em hex, lista fixa de ações e nenhum shell | Injeção de comando |
| Timeout em toda chamada ao `docker` (15 s para leitura, 120 s para ações) | Daemon travado acumulando threads presas |

O token chega à página pelo `#fragmento` do link: o fragmento não é enviado ao servidor e sai da URL assim que a página carrega. Ele fica no `localStorage`, que é isolado por porta, e não em cookie, que vazaria para outros servidores em `localhost`. Cada execução gera um token novo. Se a página mostrar "sem token", abra o link impresso no terminal.

> Quem consegue rodar `docker` na sua máquina já tem poder equivalente ao de root. O token impede que a GUI amplie esse acesso, mas não substitui o cuidado com quem está no grupo `docker`.

## Desenvolvimento

Quem usa baixa só o `docker_gui.py`. Para desenvolver, o front fica em arquivos próprios em `src/`, e o `build.py` embute tudo no `docker_gui.py`:

| Arquivo | O que tem |
|---|---|
| `docker_gui.py` | Servidor (Python, editado à mão) + bloco gerado no fim, com HTML, JS e CSS |
| `src/page.html` | Estrutura da página |
| `src/format.js` | Funções puras que traduzem a saída do `docker` (status, portas, projeto…) |
| `src/app.js` | Renderização, ações e eventos |
| `src/theme.css` | Entrada do [Tailwind CSS v4](https://tailwindcss.com) com os **tokens semânticos** dos dois temas (`bg-canvas`, `text-muted`, `bg-ok`, `text-bad-fg`, `bg-accent`…) |

Depois de mudar algo em `src/`, rode o build. Se você usou uma classe do Tailwind nova ou mexeu nos tokens, regenere também o CSS (precisa de Node/npm):

```bash
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

As funções de `src/format.js` têm testes próprios, que rodam no Node sem dependências:

```bash
node --test tests/format.test.js
```

O CI roda tudo isso em cada pull request e em cada push na `main` e na `develop`: lint (`ruff check`), testes em Python 3.7 a 3.14, E2E com Docker real, sintaxe e testes do JS, e a conferência de que o `docker_gui.py` está em dia com `src/`, CSS incluído.

## Licença

[MIT](LICENSE)
