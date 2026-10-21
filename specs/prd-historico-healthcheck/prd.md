# PRD: Histórico do healthcheck

## Visão geral

Quando um container fica "healthcheck falhando", a pergunta é por quê. Hoje o modal de logs mostra só a saída do último probe ("Último healthcheck: código 1 · …"). Um probe sozinho engana: o último pode ter passado num healthcheck que falha a cada dois, ou ter dado timeout uma vez num que costuma responder.

O docker guarda as últimas 5 execuções do healthcheck de cada container, com início, fim, código e saída. Elas já estão no `docker inspect` que a página lê para o último probe. A feature mostra as 5, para que a pessoa veja o padrão (falha sempre? oscila? está ficando lento?) sem abrir o terminal.

## Objetivos

- Responder "o healthcheck falha sempre, às vezes ou só ficou lento?" a partir do modal de logs, sem terminal.
- Nenhuma consulta nova ao daemon além da que já é feita para o último probe.
- Mesmo comportamento na web e no desktop, com Docker e Podman.

## Histórias de usuário

- Como dev com um container "healthcheck falhando", eu quero ver as últimas execuções do probe, com quando rodaram, quanto demoraram, o código e a saída, para saber se é uma falha constante ou intermitente.
- Como dev, eu quero ver a duração de cada probe, para perceber quando o problema é o probe chegando perto do timeout.
- **Borda:** container recém-criado, com menos de 5 probes. Mostra os que rodaram.
- **Borda:** nenhum probe rodou ainda. Mantém a mensagem de hoje ("Nenhum probe rodou ainda").
- **Borda:** container sem healthcheck. A seção não aparece, como hoje.
- **Borda:** saída de probe longa (um HTML de erro inteiro). Aparece resumida, com como ver o resto.

## Funcionalidades principais

### 1. As últimas execuções

1. **RF1.1** O modal de logs mostra até as 5 últimas execuções do healthcheck que o docker guarda, da mais nova para a mais velha.
2. **RF1.2** Cada execução mostra: quando começou (`HH:MM:SS`, como o resto do modal), a duração, o código de saída e a saída do probe.
3. **RF1.3** Cada execução tem o resultado traduzido: passou (código 0), falhou (código 1) ou não rodou como esperado (outro código, inclusive o timeout do docker), em português e em inglês.
4. **RF1.4** Um resumo em cima diz o padrão, no estilo do resumo do Histórico ("3 de 5 falharam").
5. **RF1.5** A saída de cada probe aparece limitada a poucas linhas; a pessoa pode expandir para ver inteira.
6. **RF1.6** Dá para copiar a saída de um probe.

### 2. Atualização

1. **RF2.1** As execuções são lidas quando o modal abre e quando a pessoa pede para atualizar, como o último probe é hoje.
2. **RF2.2** Com o ao vivo ligado, uma mudança de saúde do container (que já chega pelos eventos) atualiza as execuções.

## Experiência do usuário

- No mesmo lugar do "Último healthcheck" de hoje, que passa a ser a primeira linha da lista. A lista substitui a linha, sem criar outra seção.
- Visual no estilo do Histórico e dos Processos do modal: tabela compacta, com o resultado em cor (passou, falhou) e também em texto, porque cor sozinha não basta (WCAG 2.2 AA).
- Leitor de tela: cada execução lida como uma linha da tabela, com o resultado em texto.

## Restrições técnicas de alto nível

- **As duas versões** (web e desktop) recebem a feature.
- **Podman** guarda o histórico do healthcheck em outro formato; a página precisa mostrar o mesmo.
- **Sem consulta nova**: as execuções vêm da mesma leitura que já traz o último probe.
- **Saídas de probe são texto não confiável** (vêm do container) e são exibidas como texto, nunca interpretadas.

## Fora de escopo

- **Histórico além das 5 execuções** que o docker guarda (gravar os probes ao longo do tempo).
- **Gráfico** de duração dos probes.
- **Rodar o healthcheck agora** pela página.
- **Mudar o healthcheck** (intervalo, timeout, comando).

## Histórico

**2026-10-21**. Documento criado.
