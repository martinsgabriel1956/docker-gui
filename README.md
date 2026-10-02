# Docker GUI

Gerenciador de containers Docker no navegador, num arquivo Python só. Usa apenas a biblioteca padrão e o `docker` CLI que você já tem.

```bash
python3 docker_gui.py
```

O comando abre o navegador em `http://localhost:8765` com um token de acesso. O link também aparece no terminal.

## O que faz

- **Lista ao vivo** de todos os containers, atualizada a cada 2s. Só as linhas que mudaram são redesenhadas, e o poll pausa quando a aba fica escondida.
- **Faixa "Precisa de atenção"** com o que está quebrado: healthcheck falhando, loop de reinício e saída com código diferente de zero. O status vem traduzido, por exemplo "Saiu com código 137 · morto à força ou sem memória (OOM)".
- **Agrupamento por projeto do compose** (`com.docker.compose.project`), com **Iniciar / Reiniciar / Parar tudo** e "Iniciar de novo" para desfazer.
- **Ações por container:** iniciar, parar, reiniciar, retomar e remover (com confirmação em 2 passos). Depois de iniciar, a ferramenta confere se o container ficou de pé.
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

O token chega à página pelo `#fragmento` do link: o fragmento não é enviado ao servidor e sai da URL assim que a página carrega. Ele fica no `localStorage`, que é isolado por porta, e não em cookie, que vazaria para outros servidores em `localhost`. Cada execução gera um token novo. Se a página mostrar "sem token", abra o link impresso no terminal.

> Quem consegue rodar `docker` na sua máquina já tem poder equivalente ao de root. O token impede que a GUI amplie esse acesso, mas não substitui o cuidado com quem está no grupo `docker`.

## Mudando o visual

O HTML usa classes do [Tailwind CSS v4](https://tailwindcss.com) com **tokens semânticos** (`bg-canvas`, `text-muted`, `bg-ok`, `text-bad-fg`, `bg-accent`…). Os valores dos dois temas ficam em `TW_INPUT`, no topo do arquivo.

Se você mudar classes no `PAGE` ou os tokens, regenere o CSS embutido (precisa de Node/npm):

```bash
python3 docker_gui.py --css
```

## Licença

[MIT](LICENSE)
