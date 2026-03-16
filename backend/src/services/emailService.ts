/**
 * Email service: sends transactional emails via Resend API.
 * Falls back to console.log in dev if RESEND_API_KEY is not set.
 */

import { env } from "../config/env";

interface EmailParams {
  to: string;
  subject: string;
  html: string;
}

async function sendEmail(params: EmailParams): Promise<void> {
  if (!env.RESEND_API_KEY) {
    console.log(`📧 [DEV EMAIL] To: ${params.to} | Subject: ${params.subject}`);
    console.log(params.html);
    return;
  }

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
    },
    body: JSON.stringify({
      from: env.EMAIL_FROM,
      to: [params.to],
      subject: params.subject,
      html: params.html,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    console.error(`Email send failed (${res.status}):`, text);
  }
}

export async function notifyBorrowerLoanReady(
  borrowerEmail: string,
  amountBrl: number,
  loanId: string,
): Promise<void> {
  await sendEmail({
    to: borrowerEmail,
    subject: "Você tem dinheiro disponível para saque — EmprestáZap",
    html: `
      <h2>Olá!</h2>
      <p>Você tem <strong>R$ ${amountBrl.toFixed(2)}</strong> disponíveis para saque no EmprestáZap.</p>
      <p>Acesse a plataforma para sacar via PIX:</p>
      <p><a href="${env.APP_URL}/loan/${loanId}" style="background:#25D366;color:white;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:bold;">
        Acessar e Sacar
      </a></p>
      <p style="color:#666;font-size:12px;">EmprestáZap — Empréstimos P2P</p>
    `,
  });
}

export async function notifyLenderRepaymentReceived(
  lenderEmail: string,
  amountBrl: number,
  loanId: string,
): Promise<void> {
  await sendEmail({
    to: lenderEmail,
    subject: "Pagamento recebido — EmprestáZap",
    html: `
      <h2>Boa notícia!</h2>
      <p>O empréstimo foi pago. Você tem <strong>R$ ${amountBrl.toFixed(2)}</strong> disponíveis para saque.</p>
      <p><a href="${env.APP_URL}/loan/${loanId}" style="background:#25D366;color:white;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:bold;">
        Acessar e Sacar
      </a></p>
      <p style="color:#666;font-size:12px;">EmprestáZap — Empréstimos P2P</p>
    `,
  });
}
