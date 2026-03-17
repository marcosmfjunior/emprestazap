# Plano: Fluxo PIX-First Custodial — EmprestáZap

## Visão geral

O novo fluxo é 100% PIX para o usuário final. Ninguém precisa ter cripto,
MATIC ou entender blockchain. A plataforma age como custodiante: converte
PIX ↔ BRZ e executa as transações on-chain por conta dos usuários.

---

## Fluxo completo

```
LENDER                    PLATAFORMA                    TOMADOR
  │                           │                             │
  │ 1. Cria proposta           │                             │
  │ (valor, taxa, prazo,       │                             │
  │  email do tomador)         │                             │
  │──────────────────────────►│                             │
  │                           │ Cria Loan no DB             │
  │                           │ status: PENDING_PAYMENT     │
  │◄──────────────────────────│                             │
  │ Recebe QR Code PIX         │                             │
  │                           │                             │
  │ 2. Paga via PIX            │                             │
  │──────────────────────────►│ (Transfero webhook)         │
  │                           │ PIX confirmado              │
  │                           │ BRZ creditado na            │
  │                           │ PLATFORM_LENDER_WALLET      │
  │                           │                             │
  │                           │ 3. On-chain:                │
  │                           │ LENDER_WALLET.approve()     │
  │                           │ factory.createLoan()  →  FUNDED on-chain
  │                           │ BORROWER_WALLET.drawdown()→ ACTIVE on-chain
  │                           │                             │
  │                           │ 4. Envia email              │
  │                           │──────────────────────────►  │
  │                           │                             │ 5. Acessa app
  │                           │                             │ Vê "R$X disponível"
  │                           │                             │ Clica "Retirar"
  │                           │                             │ Informa chave PIX
  │                           │◄──────────────────────────  │
  │                           │ 6. Transfero withdraw       │
  │                           │ BRZ da BORROWER_WALLET      │
  │                           │ → PIX para tomador          │
  │                           │──────────────────────────►  │
  │                           │                             │ Recebe BRL no PIX
  │
  │ ── (após vencimento) ──
  │                           │                             │
  │                           │◄──────────────────────────  │
  │                           │ 7. Tomador paga via PIX     │
  │                           │ (QR gerado pela plataforma) │
  │                           │                             │
  │                           │ BRZ creditado na            │
  │                           │ BORROWER_WALLET             │
  │                           │ repay() on-chain →          │
  │                           │ LENDER_WALLET recebe BRZ    │
  │                           │                             │
  │ 8. Plataforma notifica     │                             │
  │◄──────────────────────────│                             │
  │ "Você tem R$X disponível" │                             │
  │ Clica "Sacar"              │                             │
  │──────────────────────────►│                             │
  │                           │ Transfero withdraw          │
  │                           │ BRZ da LENDER_WALLET        │
  │◄──────────────────────────│                             │
  │ Recebe BRL no PIX          │                             │
```

---

## Decisão arquitetural: 2 carteiras da plataforma

O contrato `BulletLoan` exige que lender ≠ borrower.
A plataforma usa duas wallets controladas pelo backend:

| Wallet | Env var | Função on-chain |
|--------|---------|----------------|
| PLATFORM_LENDER_WALLET | PLATFORM_LENDER_PRIVATE_KEY | Chama createLoan via factory, recebe repagamento |
| PLATFORM_BORROWER_WALLET | PLATFORM_BORROWER_PRIVATE_KEY | Chama drawdown(), recebe principal, paga repay() |

Ambas as chaves ficam APENAS no Railway (env vars). Nunca no frontend.

---

## BACKEND — Mudanças necessárias

### 1. Prisma Schema (nova migration)

```prisma
enum LoanStatus {
  PENDING_PAYMENT  // ← NOVO: proposta criada, aguardando PIX do lender
  CREATED          // mantido para compatibilidade / flow cripto puro
  FUNDED           // PIX confirmado, on-chain funded
  ACTIVE           // drawdown executado, tomador deve sacar
  DISBURSED        // ← NOVO: tomador sacou via PIX
  REPAID
  DEFAULTED
  CANCELLED
}

model Loan {
  // campos existentes mantidos...
  borrowerEmail     String?   // ← NOVO: email do tomador informado pelo lender
  lenderEmail       String?   // ← NOVO: email do lender (para notificações)
  pixDepositId      String?   // ← NOVO: ID da transação Transfero (depósito lender)
  pixRepayId        String?   // ← NOVO: ID da transação Transfero (repagamento)
  disbursedAt       DateTime? // ← NOVO: quando tomador sacou
  principalBrl      Float?    // ← NOVO: valor em BRL no momento da criação
}

model User {
  id            String   @id @default(uuid())
  privyId       String   @unique
  email         String?  @unique
  walletAddress String?  @unique
  pixKey        String?  // chave PIX para receber saques
  createdAt     DateTime @default(now())
  updatedAt     DateTime @updatedAt
}
```

### 2. Novos arquivos de serviço

#### `src/config/platformWallet.ts`
- Carrega PLATFORM_LENDER_PRIVATE_KEY e PLATFORM_BORROWER_PRIVATE_KEY
- Exporta `lenderWallet` e `borrowerWallet` (ethers.Wallet conectados ao provider)
- Funções: `fundLoan(loanId)`, `drawdownLoan(loanAddress)`, `repayLoan(loanAddress)`

#### `src/services/loanFlowService.ts`
- Orquestra o ciclo completo após PIX confirmado:
  1. `createLoan()` via factory (lenderWallet)
  2. `drawdown()` (borrowerWallet)
  3. Atualiza DB
  4. Envia email ao tomador

#### `src/services/emailService.ts`
- Usa nodemailer (SMTP) ou Resend API
- Templates:
  - "Você tem R$X disponível para sacar"
  - "Seu empréstimo foi pago"
  - "Você tem R$X para sacar (repagamento recebido)"

#### `src/services/userService.ts`
- CRUD de usuários (cria/busca por privyId ou email)
- Vincula email → walletAddress após primeiro login

### 3. Novas rotas

#### `POST /api/loans` (auth obrigatório)
- Body: `{ borrowerEmail, principalBrl, annualRateBps, termMonths }`
- Cria Loan no DB com status `PENDING_PAYMENT`
- Chama Transfero para gerar QR PIX no valor de `principalBrl`
- Retorna: `{ loanId, pixQrCode, pixCopyPaste, expiresAt }`

#### `POST /api/ramp/webhook` (sem auth, valida HMAC da Transfero)
- Recebe confirmação de pagamento PIX
- Identifica se é depósito (lender funding) ou repagamento (borrower repaying)
- Dispara `loanFlowService.processDeposit(transactionId)` ou `processRepayment(transactionId)`

#### `POST /api/loans/:id/disburse` (auth — apenas tomador do empréstimo)
- Body: `{ pixKey }`
- Chama Transfero withdraw (BRZ da borrowerWallet → PIX para tomador)
- Atualiza Loan.status = DISBURSED

#### `POST /api/loans/:id/repay-init` (auth — apenas tomador)
- Gera QR PIX para o tomador pagar `totalOwed` em BRL
- Salva pixRepayId no Loan
- Retorna: `{ pixQrCode, pixCopyPaste, expiresAt, amountBrl }`

#### `GET /api/users/me` (auth)
- Retorna perfil do usuário logado (cria se não existir)

#### `PUT /api/users/me` (auth)
- Body: `{ pixKey }` — salva chave PIX do usuário

### 4. Atualizar `env.ts`
```typescript
PLATFORM_LENDER_PRIVATE_KEY: process.env.PLATFORM_LENDER_PRIVATE_KEY!
PLATFORM_BORROWER_PRIVATE_KEY: process.env.PLATFORM_BORROWER_PRIVATE_KEY!
TRANSFERO_WEBHOOK_SECRET: process.env.TRANSFERO_WEBHOOK_SECRET ?? ""
EMAIL_FROM: process.env.EMAIL_FROM ?? ""
SMTP_URL: process.env.SMTP_URL ?? ""  // ou RESEND_API_KEY
```

### 5. Adicionar Railway env vars
```
PLATFORM_LENDER_PRIVATE_KEY=0x...
PLATFORM_BORROWER_PRIVATE_KEY=0x...
TRANSFERO_WEBHOOK_SECRET=...
RESEND_API_KEY=...  (ou SMTP_URL)
EMAIL_FROM=no-reply@emprestazap.com.br
```

---

## FRONTEND — Mudanças necessárias (prompts para Lovable)

### Páginas a modificar

#### CreateLoan (lender cria proposta)
- Adicionar campo: "E-mail do tomador" (obrigatório)
- Remover campo de wallet address
- Remover qualquer chamada wagmi (writeContract)
- Após submit: `POST /api/loans` → exibir QR Code PIX
- Mostrar tela: "Aguardando pagamento" com QR + botão copiar código
- Polling `GET /api/loans/:id` a cada 5s para detectar quando status muda para FUNDED

#### Dashboard (lender vê seus empréstimos)
- Adicionar status "Aguardando pagamento" com badge amarelo
- Mostrar botão "Ver QR Code" para loans PENDING_PAYMENT
- Buscar dados do backend: `GET /api/loans?lender=...` (sem wagmi reads)
- Remover dados mockados

#### Tela do Tomador (nova — ou adaptar LoanDetail)
- Tomador faz login com email → vê loan disponível
- Status "Disponível para saque" com badge verde
- Botão "Retirar" → modal para informar chave PIX → `POST /api/loans/:id/disburse`
- Após saque: status "Ativo" → mostra prazo e valor a pagar
- Botão "Pagar" → chama `POST /api/loans/:id/repay-init` → exibe QR PIX

#### Wallet
- Remover lógica de saldo BRZ direto na chain (não precisamos mais)
- Mostrar apenas: "Meus empréstimos como lender / como tomador"

#### Remoções
- Remover chamadas `useWriteContract` para createLoan, fund, repay
- Remover necessidade de MATIC (usuário não precisa de gas)
- Manter Privy apenas para autenticação (email login)

---

## Ordem de implementação

### Fase 1 — Backend (3-4 dias)
1. Migration Prisma (PENDING_PAYMENT, DISBURSED, tabela User)
2. platformWallet.ts (2 wallets, funções fund/drawdown/repay)
3. loanFlowService.ts (orquestrador)
4. `POST /api/loans` (cria proposta + gera QR PIX)
5. `POST /api/ramp/webhook` (confirma PIX + aciona flow)
6. `POST /api/loans/:id/disburse` (tomador saca)
7. `POST /api/loans/:id/repay-init` (tomador inicia repagamento)
8. emailService.ts (notificações)
9. userService.ts (CRUD usuários)
10. Deploy Railway + novas env vars

### Fase 2 — Frontend (2-3 dias, via Lovable)
1. Atualizar CreateLoan (campo email + QR PIX)
2. Dashboard do lender (status PENDING_PAYMENT, polling)
3. Tela do tomador (saque via PIX)
4. Tela de repagamento (QR PIX)
5. Remover dependências de wagmi para escritas

### Fase 3 — Testes (1-2 dias)
1. Teste end-to-end com Transfero sandbox
2. Deploy e smoke test em produção

---

## O que NÃO muda
- Smart contracts já deployados (sem redeploy)
- Indexer (continua monitorando eventos on-chain)
- Auth com Privy (continua igual)
- `GET /api/loans` e `GET /api/loans/:address` (leitura continua igual)
- PostgreSQL + Railway (infraestrutura igual)

---

## Observação sobre o contrato BulletLoan

`drawdown()` permite qualquer endereço (exceto lender) chamar e se tornar o borrower.
A `PLATFORM_BORROWER_WALLET` chama drawdown → recebe BRZ → converte via Transfero.
`repay()` só pode ser chamada pelo borrower (onlyBorrower).
Como PLATFORM_BORROWER_WALLET É o borrower on-chain, ela também chama repay() após receber PIX do tomador.
**Nenhuma mudança no contrato é necessária.**
