---
name: sdd-techspec
description: Traduz um PRD aprovado em decisões técnicas — arquitetura, integrações, interfaces principais — sem código de implementação. Segundo passo do pipeline SDD (sdd-prd → sdd-techspec → sdd-tasks → sdd-review). Use depois que um PRD existe e antes de qualquer código ser escrito.
---

# sdd-techspec

Traduz requisitos em decisão técnica: que abordagem, que biblioteca, que interface, que trade-off foi aceito e por quê. Não é onde o código nasce — isso é trabalho do `sdd-tasks`, que vem depois e lê este documento como contrato.

<critical>NÃO gere o techspec sem primeiro explorar o projeto e fazer perguntas de esclarecimento</critical>
<critical>NÃO escreva código além de assinatura de interface (no máximo ~20 linhas por exemplo). O objetivo é a decisão, não a implementação</critical>
<critical>NÃO repita requisito funcional do PRD. Foque em como, o PRD já é dono do quê e do porquê</critical>

## Pré-requisito

`specs/prd-[feature]/prd.md` precisa existir e estar aprovado. Se não existir, pare e diga que o `sdd-prd` precisa rodar primeiro.

## Passo 0 — aprender as preferências de arquitetura já tomadas

Leia `specs/README.md`. Para cada feature relacionada listada ali, abra o `techspec.md` dela inteiro antes de propor qualquer coisa nova.

O objetivo é não redecidir o que este projeto já decidiu. Se a feature anterior escolheu RabbitMQ em vez de Kafka, a razão está registrada na seção de Decisões Principais daquele techspec — reaproveite a decisão, a não ser que haja um motivo concreto pra divergir desta vez, e se divergir, escreva o motivo explicitamente no documento novo.

Isso é mais confiável que inferir convenção só olhando código: o código mostra o que foi feito, o techspec anterior mostra por que foi feito daquele jeito e o que foi descartado.

## Passo 1 — analisar o PRD

Leia o PRD inteiro. Extraia requisito, restrição, métrica de sucesso.

## Passo 2 — explorar o projeto

Mapeie arquivos, módulos e pontos de integração envolvidos. Isso é fonte pra pontos de integração concretos (que arquivo, que função, que endpoint existe hoje) — não é a fonte principal de convenção de arquitetura, que vem do Passo 0.

## Passo 3 — esclarecer tecnicamente

Pergunte, focado em:

- Onde essa lógica mora no domínio existente
- Fluxo de dado, entrada e saída
- Dependência externa: serviço, API, modo de falha, timeout, idempotência
- Interface principal e modelo de dado
- Cenário de teste crítico
- Reuso: existe biblioteca ou componente que já resolve parte disso, e vale a licença

Use pesquisa externa (documentação de biblioteca, regra de negócio) só quando a pergunta realmente depender de informação atual que você não tem — não é obrigatório pesquisar em toda techspec.

## Passo 4 — conformidade com o padrão do projeto

Leia o que o projeto documenta sobre si mesmo, sem assumir nenhuma convenção específica de antemão: `CLAUDE.md`, qualquer diretório de regras que exista (`docs/ai-rules/`, `.claude/rules/`, ou equivalente), e a documentação de arquitetura do projeto se houver. Liste qualquer desvio proposto, com justificativa e a alternativa conformante ao lado.

## Passo 5 — gerar o documento

### Template

```markdown
# Techspec: [nome da feature]

## Resumo executivo

[1-2 parágrafos: abordagem e decisão arquitetural principal]

## Arquitetura

### Visão de componentes

[componentes novos ou modificados, responsabilidade de cada um,
relação entre eles, visão geral do fluxo de dado]

## Design de implementação

### Interfaces principais

[assinatura de interface, até ~20 linhas por exemplo — não implementação]

### Modelos de dado

[entidades de domínio, tipos de request/response, schema se aplicável]

### Endpoints de API

[método, path, descrição breve, referência de formato — se aplicável]

## Pontos de integração

[serviço externo, autenticação, tratamento de erro — só se houver]

## Estratégia de teste

Unitário: componentes principais, o que precisa de mock (só serviço externo).
Integração: componentes testados juntos, dado necessário.
E2E: se necessário, com a ferramenta que o projeto já usa.

## Sequenciamento

Ordem de construção e por quê. Dependência bloqueante, se houver.

## Observabilidade

Métrica a expor, log principal, integração com o que o projeto já usa
para monitorar — não invente ferramenta nova se o projeto já tem uma.

## Considerações técnicas

### Decisões principais

[abordagem escolhida e por quê, trade-off considerado, alternativa
rejeitada e o motivo — esta é a seção que sobrevive à implementação]

### Riscos conhecidos

[desafio potencial, mitigação, o que ainda precisa de investigação]

### Conformidade com regras do projeto

[regras de CLAUDE.md / diretório de regras que se aplicam aqui]

### Conformidade com skills disponíveis

[skills do projeto que esta feature deveria usar na implementação]

### Arquivos relevantes

[arquivos e módulos que esta feature toca]

## Histórico

**[data]**. Documento criado.
```

## Passo 6 — salvar

Salve em `specs/prd-[feature]/techspec.md`. Atualize a linha da feature em `specs/README.md` (status: em techspec / em tasks).

## Passo 7 — o techspec é vivo, e isso vale pra ele e pra qualquer outro

<critical>Toda vez que uma decisão técnica desta feature mudar — durante as tasks, durante a execução, durante o review — volte aqui e atualize o techspec.md. Nunca deixe ele descrever uma arquitetura que o código já não tem mais.</critical>

Atualização edita a seção afetada no lugar e adiciona entrada datada em Histórico com o que mudou e por quê. Isso normalmente acontece automaticamente como parte do fechamento do `sdd-review`, mas vale também se você mudar de ideia no meio desta própria conversa.

**Se implementar esta feature revelar que a decisão técnica de uma feature antiga já não se sustenta**, pare, avise explicitamente, e atualize o `techspec.md` dela também, com entrada de Histórico própria.

## Checklist de qualidade

- [ ] PRD lido por completo
- [ ] `specs/README.md` e techspecs relacionados lidos antes de propor
- [ ] Análise do projeto feita
- [ ] Esclarecimentos técnicos principais respondidos
- [ ] Documento gerado usando o template, sem código além de assinatura
- [ ] Regras do projeto conferidas e desvios justificados
- [ ] Arquivo salvo em `specs/prd-[feature]/techspec.md`
- [ ] `specs/README.md` atualizado
