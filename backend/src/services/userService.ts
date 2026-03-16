/**
 * User service: manages user records linked to Privy auth.
 */

import { prisma } from "../config/database";

export async function findOrCreateUser(privyId: string, email?: string) {
  const existing = await prisma.user.findUnique({ where: { privyId } });
  if (existing) {
    // Update email if it changed
    if (email && existing.email !== email) {
      return prisma.user.update({
        where: { privyId },
        data: { email },
      });
    }
    return existing;
  }

  return prisma.user.create({
    data: { privyId, email },
  });
}

export async function findUserByEmail(email: string) {
  return prisma.user.findUnique({ where: { email } });
}

export async function findUserByPrivyId(privyId: string) {
  return prisma.user.findUnique({ where: { privyId } });
}

export async function updatePixKey(privyId: string, pixKey: string) {
  return prisma.user.update({
    where: { privyId },
    data: { pixKey },
  });
}

export async function updateWalletAddress(privyId: string, walletAddress: string) {
  return prisma.user.update({
    where: { privyId },
    data: { walletAddress },
  });
}
