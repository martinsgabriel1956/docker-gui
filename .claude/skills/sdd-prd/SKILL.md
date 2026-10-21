---
name: sdd-prd
description: Cria ou atualiza o PRD de uma feature dentro de um fluxo de Spec Driven Development — o quê, por quê, e como medir sucesso, sem implementação. Primeiro passo do pipeline SDD (sdd-prd → sdd-techspec → sdd-tasks → sdd-review). Use quando o usuário pedir para especificar, planejar ou documentar requisitos de uma feature antes de decidir como construí-la.
---

# sdd-prd

Produz o documento de produto de uma feature: o problema, pra quem, o resultado esperado e como saber que deu certo. Nunca decide como construir — isso é trabalho do `sdd-techspec`, que vem depois.

<critical>NÃO gere o PRD sem antes fazer perguntas de esclarecimento, uma de cada vez, preferindo o AskUserQuestion</critical>
<critical>NÃO inclua nada de implementação — biblioteca, endpoint, schema, linguagem. Isso é do techspec</critical>
<critical>Esta skill não sabe nada sobre nenhum projeto específico. Todo fato de projeto vem do que você ler no repositório atual, nunca de suposição</critical>

## Onde tudo mora

```
specs/README.md                    índice: uma linha por feature
specs/prd-[feature]/prd.md         este documento — permanente, vivo
specs/prd-[feature]/techspec.md    decisões técnicas — permanente, vivo
specs/prd-[feature]/tasks.md       tasks — efêmero, criado pelo sdd-tasks
```

`[feature]` é kebab-case, curto, derivado do nome da feature.

## Passo 0 — olhar o que já existe

Antes de perguntar qualquer coisa, leia `specs/README.md` se ele existir. Se alguma feature listada for relacionada à que está sendo pedida agora, abra o `prd.md` dela e leia inteiro antes de continuar.

Isso evita duas coisas: perguntar de novo algo que uma feature vizinha já decidiu, e criar um PRD que contradiz uma decisão de produto já tomada sem perceber. Se a feature nova de fato muda o que uma feature antiga decidiu, isso vira trabalho do Passo 4 — não se resolve ignorando o que já existe.

Se `specs/README.md` não existir, este é o primeiro PRD do repositório. Crie o arquivo vazio com um cabeçalho simples.

## Passo 1 — esclarecer

Pergunte, uma pergunta por vez:

- Qual problema isso resolve, e pra quem
- Qual o objetivo mensurável — como saber que funcionou
- O fluxo principal do usuário
- O que fica explicitamente fora do escopo
- Alguma restrição de negócio, prazo, ou integração que já é fato

Se a resposta a uma pergunta já está em algum documento do projeto (README, outros PRDs, documentação de produto), explore o repositório em vez de perguntar. Pergunte só o que não está escrito em lugar nenhum.

## Passo 2 — plano e rascunho

Antes de escrever o documento final, diga em poucas linhas como as seções vão se conectar e o que ainda precisa de pesquisa (se a feature depende de alguma regra de negócio externa — tributária, legal, de mercado — pesquise antes de assumir).

Escreva o PRD focado no **quê** e no **porquê**, nunca no **como**. Requisitos funcionais numerados. Documento principal com no máximo ~2.000 palavras.

**Idioma:** o mesmo dos outros documentos deste repositório. Se `specs/README.md` ou qualquer PRD existente já estabelece o idioma, siga sem perguntar. Se este é o primeiro PRD do repositório e não há nenhum outro documento pra inferir, pergunte.

### Template

```markdown
# PRD: [nome da feature]

## Visão geral

[o problema, pra quem, por que vale a pena]

## Objetivos

[o que sucesso parece, métricas a acompanhar, objetivo de negócio]

## Histórias de usuário

- Como [tipo de usuário], eu quero [ação] para [benefício]
- Cubra o fluxo principal e os casos de borda relevantes

## Funcionalidades principais

Para cada uma: o que faz, por que importa, requisitos funcionais numerados.

## Experiência do usuário

[jornada, fluxos principais, considerações de UI/UX e acessibilidade]

## Restrições técnicas de alto nível

[só restrições, nunca decisão — integração obrigatória, exigência de
compliance, meta de performance, sensibilidade de dado. A decisão de
como atender isso é do techspec]

## Fora de escopo

[o que fica de fora de propósito, e o que é consideração de futuro]

## Histórico

**[data]**. Documento criado.
```

## Passo 3 — salvar

Crie `specs/prd-[feature]/` e salve `prd.md`. Adicione ou atualize uma linha em `specs/README.md`:

```markdown
- [nome da feature](prd-[feature-slug]/prd.md) — uma frase do que é, status: em prd / em techspec / em tasks / implementado
```

## Passo 4 — o PRD é vivo, e isso vale pra ele e pra qualquer outro

<critical>Toda vez que uma decisão de produto desta feature mudar — durante o techspec, durante as tasks, durante o review, ou numa conversa solta — volte aqui e atualize o prd.md. Nunca deixe ele desatualizado.</critical>

A atualização segue o mesmo formato de todo documento vivo: edita a seção afetada no lugar, e adiciona uma entrada datada em Histórico explicando o que mudou e por quê. Nunca reescreve em silêncio.

**Se a decisão de produto de uma feature diferente e já implementada precisar mudar por causa do que está sendo construído agora**, isso não é detalhe a anotar depois. Pare, avise explicitamente que uma feature antiga vai ser afetada, e atualize o `prd.md` dela também, com sua própria entrada de Histórico — não silenciosamente, e não só o documento da feature atual.

## Checklist de qualidade

- [ ] `specs/README.md` foi lido antes de perguntar qualquer coisa
- [ ] Perguntas de esclarecimento feitas e respondidas
- [ ] Nenhuma decisão de implementação no documento
- [ ] Requisitos funcionais numerados
- [ ] Arquivo salvo em `specs/prd-[feature]/prd.md`
- [ ] `specs/README.md` atualizado com a entrada da feature
- [ ] Se alguma feature antiga foi afetada, o `prd.md` dela também foi atualizado
