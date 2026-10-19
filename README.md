# Radar de Vagas

> Um agente que conhece o seu repertório, varre os portais de vagas, ranqueia o que encontrou e aprende com cada descarte. Quem decide se aplica é você.
>
> **Tipo:** misto (plugin de agente, scripts e página local) · **Nível:** N3 · **Stack:** Node 20+ sem dependências · **Licença:** MIT

**Versão 0.1.0.** Coleta, radar local, seis skills, triagem, preparo com veracidade, acompanhamento e agendamento implementados. Para instalar, vá direto ao [Começo rápido](#começo-rápido).

## Visão

Procurar emprego virou trabalho de varredura: abrir cinco portais por dia, ler anúncios longos e descobrir no último parágrafo que a vaga exige algo que você não tem. O Radar de Vagas faz essa varredura por você e entrega uma tabela só, com as vagas novas ordenadas por encaixe.

Ele começa com uma entrevista: quem você é, seus casos e entregas, seu currículo, onde quer trabalhar, em que modelo, que idiomas fala e que faixa salarial aceita. A partir daí coleta vagas em vários portais, lê a descrição inteira de cada uma e devolve estrelas, o motivo e os alertas. Quando você descarta uma vaga e escreve o porquê, isso vira memória: a próxima vaga com o mesmo ponto chega avisada.

O que ele **não** é: não se candidata por você, não esconde vaga por conta própria e não manda seus dados para lugar nenhum. Perfil, currículo e histórico ficam numa pasta da sua máquina, fora deste repositório.

## O que faz

- Busca vagas em fontes abertas (Gupy, Sólides, InfoJobs e páginas de carreira de empresas em Greenhouse, Lever, Ashby e InHire) e, se a pessoa quiser, no LinkedIn com a conta dela (em construção: depende do login de uma conta secundária, feito por ela).
- Aplica o filtro que a pessoa configurou (local, modelo e título) sem esconder nada: a vaga cortada continua visível, com o motivo.
- Mostra a página do dia: as vagas da última coleta, ordenadas por estrelas, com os alertas da triagem.
- Prepara a candidatura sem rede: escolhe o modelo de currículo, gera o CV pela ferramenta da pessoa e confere a veracidade de cada frase contra a base de fatos dela.
- Roda o painel de revisão: sete revisores tentam reprovar o currículo montado e devolvem os erros, sem reescrever o CV.
- Pede a aprovação da pessoa para cada frase nova, no terminal ou pelo Telegram dela.
- Registra o retorno de cada candidatura e mostra a taxa por fonte, estrela e modelo de currículo.

## O que não faz

- O radar não envia candidatura: quem envia é sempre a pessoa.
- O radar não loga pela pessoa: o login do LinkedIn, quando usado, é dela, numa janela que ela abre.
- O radar não manda mensagem, convite nem conexão a ninguém.
- Não aprova frase no lugar da pessoa e não publica nada.

## Como funciona

1. Você clona o repositório, roda `npm run setup` e abre no Claude Code ou no Codex.
2. O agente faz a entrevista e grava seu perfil em `~/.radar-de-vagas/`.
3. A coleta roda quando você pedir ou no horário que você agendar (por exemplo, a cada seis horas).
4. A página do radar abre no navegador com as vagas novas, as estrelas e os alertas.
5. Você marca **inscrevi** ou **descartar**, com o motivo. O radar aprende.
6. Para a vaga que vale a pena, o agente monta o currículo ajustado a ela. Quando aparecer entrevista, monta uma página única de preparo. Os dois usam só o que está no seu perfil.

Sem agente instalado, a coleta e a página funcionam só com Node. Você vê as vagas, mas sem estrelas nem alertas.

## Mapa do projeto

As pastas e arquivos principais (não é a lista completa):

```
radar-de-vagas/
├── README.md         # este arquivo
├── PRD.md            # o produto: princípios, escopo, riscos
├── ARCHITECTURE.md   # como as peças se encaixam
├── ROADMAP.md        # fases e tarefas
├── CHANGELOG.md      # o que entrou de fato
├── CONTEXT.md        # vocabulário do projeto
├── CLAUDE.md         # instruções para agentes (AGENTS.md aponta para cá)
├── decisions/        # decisões com o porquê
├── docs/             # referência de uso e contratos internos
├── bin/              # o comando radar.mjs
├── src/              # coleta, fontes, estado, página e preparo
├── scripts/          # guarda de privacidade e exportação
├── test/             # testes (node --test)
├── examples/         # perfil e busca fictícios
└── skills/           # o julgamento do produto, em texto
```

## Começo rápido

Você precisa de **Node.js 20 ou superior** e **Git**. Funciona em Mac, Linux e Windows, e não há dependências para instalar. Para ter estrelas, alertas e entrevista de onboarding, tenha também o Claude Code ou o Codex instalado e com login feito.

**1. Baixe e prepare.** No terminal (Terminal no Mac e no Linux, PowerShell no Windows). Os comandos deste README são os mesmos nos três sistemas, salvo onde está dito; o rótulo `sh` dos blocos é só formatação.

```sh
git clone https://github.com/oliveirarenanfelipe/radar-de-vagas.git
cd radar-de-vagas
npm run setup
```

O `setup` confere o Node, cria sua pasta de dados fora do clone, procura o Claude Code e o Codex na máquina e termina dizendo o próximo passo. Pode rodar de novo sempre que tiver dúvida de onde parou.

**2. Faça o onboarding.** Ainda na pasta do clone, abra o agente (`claude` ou `codex`) e peça:

```text
Faça meu onboarding do Radar de Vagas seguindo skills/onboarding/SKILL.md
```

É uma entrevista, uma pergunta por vez: seu LinkedIn, seu currículo, suas entregas, onde e como quer trabalhar, faixa salarial e o que procurar. No fim o agente grava seu perfil e sua busca e pergunta se você quer agendar a coleta. Você não edita nenhum arquivo.

**3. Colete, julgue e veja.**

```sh
npm run collect
```

A coleta detalha até 150 vagas novas por fonte em cada rodada (`detalhesNovosPorFonte`); as que passam disso ficam para a rodada seguinte, e a coleta avisa quantas. Depois, no agente, peça `Faça a triagem`. Ele lê cada vaga inteira e grava estrelas, motivo e alertas. Para ver o resultado no navegador:

```sh
npm run open
```

Na página, **inscrevi** registra que você enviou a candidatura e **descartar** pede o motivo. O motivo vira memória: a próxima vaga parecida chega avisada. Deixe o terminal aberto enquanto usa a página; **Ctrl+C** encerra.

A partir daí o ciclo é o mesmo: coletar, triar, abrir. Se você ligou o agendamento no onboarding, a coleta e a triagem rodam sozinhas.

### Sem terminal, pelo app de desktop

Se você prefere não digitar comandos, dá para fazer tudo conversando com o agente no app de desktop: a aba **Code** do app do Claude ou o app do **Codex**. O chat comum do Claude e do ChatGPT não serve, porque não roda nada na sua máquina.

O Node.js 20 e o Git continuam precisando estar instalados. Depois disso:

1. Abra o app e peça para ele trabalhar numa pasta sua (por exemplo, Documentos).
2. Peça:

```text
Clone https://github.com/oliveirarenanfelipe/radar-de-vagas, entre na pasta, rode npm run setup e faça meu onboarding seguindo skills/onboarding/SKILL.md
```

3. Nas vezes seguintes, abra a pasta `radar-de-vagas` no app e peça `Colete as vagas, faça a triagem e abra a página do radar`.

O agente roda os mesmos comandos do Começo rápido por você e pede sua aprovação antes de executar. Se o `setup` avisar que não encontrou o Claude Code ou o Codex, pode ignorar: ele procura a versão de terminal, e você já está dentro do agente. Para a triagem agendada rodar sozinha, a versão de terminal do agente precisa estar instalada; sem ela, a agenda só coleta e você pede a triagem pelo app.

Este caminho ainda não foi validado de ponta a ponta. Se você testar, abra uma issue contando como foi.

### Sem agente

Dá para usar só com Node. Você vê as vagas numa tabela, sem estrelas nem alertas. O caminho do arquivo `busca.json` sai com `node bin/radar.mjs paths` (campo `search`); abra num editor de texto, troque os `termos` e as empresas de exemplo pelo que procura, apague o campo `aviso` e rode `npm run collect` e `npm run open`. Os campos estão explicados em [docs/referencia.md](docs/referencia.md).

### Fontes e os dois LinkedIn

- **Gupy, Greenhouse, Lever, Ashby e InHire** vêm prontas na busca de exemplo.
- **Sólides e InfoJobs** vêm desligadas de fábrica. Para ligar, ponha `"solides": true` ou `"infojobs": true` em `fontes` no `busca.json` e, se quiser filtrar por local ou modelo já na consulta, os campos `solidesFiltros` e `infojobsFiltros` (formato em [docs/contrato-de-fonte.md](docs/contrato-de-fonte.md)). O onboarding pergunta isso por você.
- **LinkedIn público** (`fontes.linkedin`): lê as páginas abertas de vagas, sem login. Vem desligado; pode sofrer bloqueio e parar de funcionar.
- **LinkedIn com a sua conta** (Fase 3): em construção e opcional. Vai depender do login de uma conta secundária, feito por você, e de um servidor MCP de terceiro instalado à parte. Nada disso está ligado nesta versão.

### Testes e pasta de dados isolada

Para rodar os testes, na pasta do clone:

```sh
node --test
```

No Linux passam todos. No Windows, 4 testes falham por diferença de plataforma (agendamento e PATH, log de 8 MiB, Ctrl+C e unidades do systemd); o resto passa.

Para experimentar sem tocar nos seus dados, aponte `RADAR_DATA_DIR` para uma pasta vazia antes dos comandos (exemplos para Mac/Linux e PowerShell em [docs/referencia.md](docs/referencia.md)). Todos os comandos passam a ler e gravar só ali.

### Se algo der errado

| Sintoma | O que fazer |
|---|---|
| `npm run setup` reclama da versão | Atualize o Node para a 20 ou superior em [nodejs.org](https://nodejs.org). |
| `setup` não encontra o agente | Instale o Claude Code ou o Codex, abra um terminal novo e rode `npm run setup` de novo. |
| A coleta termina com avisos | Leia os avisos: empresa de exemplo que não existe e fonte fora do ar aparecem ali. As outras fontes seguem valendo. |
| O navegador não abre | Copie o endereço que `npm run open` imprime e cole no navegador. |
| `busca.json` inválido | O `setup` e a coleta dizem qual campo está errado. O arquivo nunca é apagado. |
| Agendamento falha no Linux | Ele usa o systemd de usuário. Em WSL ou contêiner sem systemd, fique no modo manual. |

### O que foi validado

Passo a passo conferido no Mac em cópia limpa, com agendamento real, e no Windows numa instalação limpa (setup, coleta pública e página). **Linux passa todos os testes automáticos; no Windows, 4 testes de agenda, log, Ctrl+C e systemd falham por diferença de plataforma. O agendamento ainda não foi validado em máquina real no Linux nem no Windows.** O caminho pelo app de desktop (aba Code do Claude e app do Codex) também não foi validado. Se você testar, abra uma issue contando.

## Privacidade

Este repositório não contém dado pessoal de ninguém e não pode conter. Os exemplos são fictícios. Antes de contribuir, leia a seção de privacidade em `CLAUDE.md`.

## Skills

O julgamento do produto vive em seis arquivos de `skills/`, lidos pelo Claude Code e pelo Codex: onboarding, triagem com memória, currículo por vaga, painel de revisão do currículo, entrevista e acompanhamento. Basta pedir em português, na pasta do clone:

| Você pede | O agente faz |
|---|---|
| `Faça meu onboarding do Radar de Vagas seguindo skills/onboarding/SKILL.md` | Entrevista, perfil, busca e revisão do currículo e do LinkedIn |
| `Faça a triagem` | Estrelas, motivo e alertas nas vagas novas |
| `Monte o currículo para a vaga <ID>` | Currículo ajustado à vaga, só com fatos do seu perfil |
| `Rode o painel de revisão na vaga <ID>` | Sete revisores tentam reprovar o currículo montado e devolvem os erros, do pior para o melhor; o painel critica, não reescreve |
| `Vou ter entrevista na vaga <ID>` | Página única de preparo |
| `Tive novidade na vaga <ID>` | Atualiza etapa e próximo passo |

O ID aparece na linha da vaga na página, com botão **Copiar ID**.

O painel de revisão é adaptado de `/hiring-panel`, de Alex Chen (MIT, [github.com/alexyc9381/hiring-panel-skill](https://github.com/alexyc9381/hiring-panel-skill)); o que mudou e a licença estão em [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

Made with /hiring-panel by Alex Chen (@nocodealex) · chen.media

No Claude Code, quem preferir comandos com barra pode instalar o plugin (opcional):

```sh
claude plugin marketplace add ./
claude plugin install radar-de-vagas@radar-de-vagas-local
```

Com ele, as skills viram `/radar-de-vagas:onboarding`, `/radar-de-vagas:triagem` e assim por diante.

Agendamento, campos do `busca.json`, comandos e pasta de dados estão em [docs/referencia.md](docs/referencia.md).

## Créditos

- Radar de Vagas, de Dhiego Spinillo (MIT), github.com/dspinillo/radar-de-vagas: este projeto nasceu como fork dele; a licença e o copyright original estão em `LICENSE`.
- Painel de revisão adaptado de `/hiring-panel`, de Alex Chen (MIT). Linha de crédito: Made with /hiring-panel by Alex Chen (@nocodealex) · chen.media
- LinkedIn com a conta da pessoa (em construção): usa o servidor MCP linkedin-scraper-mcp, ferramenta externa de terceiro (Apache-2.0, github.com/stickerdaniel/linkedin-mcp-server), instalada à parte; nenhum código dele está neste repositório.
Detalhes em [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
