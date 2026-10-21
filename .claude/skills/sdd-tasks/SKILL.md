---
name: sdd-tasks
description: A partir de um techspec aprovado, cria todas as tasks de uma vez (steps e código proposto), espera aprovação do lote inteiro, e então implementa tudo em sequência na mesma sessão. Terceiro passo do pipeline SDD (sdd-prd → sdd-techspec → sdd-tasks → sdd-review). Use depois que o techspec está aprovado.
---

# sdd-tasks

Três fases dentro de uma invocação: cria todas as tasks com código proposto, para e espera sua aprovação do lote inteiro, e só então implementa tudo — nesta mesma sessão, sem subagente, porque esta sessão é quem tem o contexto completo do PRD e do techspec.

<critical>Nenhuma linha de código é escrita no repositório antes da Fase 2 terminar com sua aprovação explícita</critical>
<critical>A Fase 3 nunca para pra perguntar durante a execução. Desvio é absorvido e registrado, não motivo de parada</critical>
<critical>tasks.md é efêmero. Esta skill nunca o apaga — isso é trabalho do sdd-review, como última ação dele</critical>

## Pré-requisito

`specs/prd-[feature]/techspec.md` precisa existir e estar aprovado.

## Fase 1 — criar todas as tasks

### Antes de propor qualquer código

Leia, nesta ordem: `techspec.md` e `prd.md` inteiros; `CLAUDE.md`; qualquer diretório de regras do projeto (`docs/ai-rules/`, `.claude/rules/`, ou equivalente); a documentação de padrão de código do projeto, se existir. O código proposto em cada task precisa nascer coerente com o que o projeto já faz — não é uma sugestão genérica de como qualquer projeto resolveria aquilo.

### Para cada task

Ordene por dependência (backend antes de frontend, o que bloqueia antes do que é bloqueado). Cada task é um entregável independentemente completável, com:

- **Escopo**: uma linha
- **Contexto**: por que esta task existe, com referência à seção do PRD/techspec — 3 a 5 linhas, nunca o documento inteiro reescrito aqui
- **Skills a carregar**: das skills disponíveis neste ambiente, quais se aplicam a esta task especificamente (uma task de componente de UI usa uma skill de UI, se existir; uma task de gráfico usa a de visualização de dado; e assim por diante). Liste pelo nome, pra você poder discordar na revisão
- **Regras a respeitar**: a regra específica de `CLAUDE.md`/rules que se aplica a esta task, não a lista inteira
- **Steps**: em prosa quando é mecânico (rodar uma migration, instalar uma dependência); em código quando a forma é uma escolha real (assinatura, estrutura, onde a lógica mora). Não duplique boilerplate que o passo anterior já deixou óbvio
- **Plano de teste**: o que precisa passar pra essa task estar correta

Escreva tudo — todas as tasks, com código — num único `specs/prd-[feature]/tasks.md`, numa lista ordenada.

## Fase 2 — o gate

<critical>PARE aqui. Não prossiga para a Fase 3 sem aprovação explícita sua sobre o lote inteiro.</critical>

Apresente o `tasks.md` pronto e peça revisão. Se você pedir mudança em qualquer task, edite o arquivo e apresente de novo. Só avance quando você aprovar o lote como um todo.

## Fase 3 — executar

Implementa as tasks em ordem, nesta mesma sessão, sem abrir subagente — a sessão que discutiu PRD e techspec é quem tem mais contexto pra implementar corretamente, e um subagente comum nasceria sem nada disso.

Para cada task: carregue as skills identificadas para ela, implemente o que foi aprovado, rode o plano de teste da task, e faça **um commit por task**, seguindo a convenção de commit deste repositório (uma skill de commit própria, se existir, ou o padrão que `CLAUDE.md` documentar).

### Tolerância a desvio

<critical>A execução nunca para pra perguntar. Todo desvio é absorvido e a próxima task roda em seguida.</critical>

**Adaptação mecânica** — nome de arquivo mudou, assinatura de um helper ficou levemente diferente, nada que mude comportamento ou decisão. Ajusta e segue, sem anotar nada de especial.

**Desvio de decisão** — a biblioteca aprovada não serve, o endpoint precisa de campo que a task não previa, a interface em si precisou mudar. Implementa a melhor solução dentro do espírito da decisão do techspec, e **se alguma task seguinte no lote assumia o design antigo, ajusta ela também** antes de executá-la — não executa código que você já sabe que ficou incoerente.

Nenhum desvio ganha marca especial no commit. O commit segue a convenção normal do repositório, sem exceção.

### Ao final do lote

Poste um resumo curto na conversa: quais tasks tiveram desvio de decisão, uma linha cada. Isso é só um aviso pra você lembrar de rodar o `sdd-review` — não é o registro permanente. O registro permanente é reconstruído pelo próprio `sdd-review`, comparando o código aprovado em `tasks.md` contra o código real, então nada se perde mesmo que esta conversa termine antes do review rodar.

**Não apague `tasks.md`.** Ele precisa sobreviver até o `sdd-review` rodar.

## Checklist de qualidade

- [ ] Techspec e PRD lidos por completo antes de propor qualquer task
- [ ] CLAUDE.md e regras do projeto lidos antes de propor código
- [ ] Todas as tasks criadas de uma vez, ordenadas por dependência
- [ ] Skills relevantes identificadas por task
- [ ] Fase 2 parou e esperou aprovação explícita do lote inteiro
- [ ] Execução não parou em nenhum desvio
- [ ] Um commit por task, na convenção do repositório, sem marca especial
- [ ] Resumo de desvios postado ao final
- [ ] `tasks.md` não foi apagado
