import { Request, Response, NextFunction } from "express";
import { PrivyClient } from "@privy-io/server-auth";
import { env } from "../config/env";

// Extend Express Request to carry the authenticated user info
declare global {
  namespace Express {
    interface Request {
      walletAddress?: string;
      privyUserId?: string;
      privyEmail?: string;
      privyClaims?: Record<string, unknown>;
    }
  }
}

let _privy: PrivyClient | null = null;

function getPrivy(): PrivyClient {
  if (!_privy) {
    if (!env.PRIVY_APP_ID || !env.PRIVY_APP_SECRET) {
      throw new Error("PRIVY_APP_ID and PRIVY_APP_SECRET must be set");
    }
    _privy = new PrivyClient(env.PRIVY_APP_ID, env.PRIVY_APP_SECRET);
  }
  return _privy;
}

/**
 * Middleware that validates a Privy JWT from the Authorization header.
 * Extracts the user's embedded wallet address and attaches it to req.walletAddress.
 */
export async function authMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) {
    res.status(401).json({ error: "Missing or malformed Authorization header" });
    return;
  }

  const token = authHeader.replace("Bearer ", "").trim();

  try {
    const privy = getPrivy();
    const claims = await privy.verifyAuthToken(token);

    // verifyAuthToken returns only { userId, appId, issuer, ... }.
    // We need to fetch the full user profile to get the wallet address.
    const user = await privy.getUser(claims.userId);
    const walletAddress = user.wallet?.address;
    const email = user.email?.address;

    req.walletAddress = walletAddress;
    req.privyUserId = claims.userId;
    req.privyEmail = email;
    req.privyClaims = claims as unknown as Record<string, unknown>;
    next();
  } catch {
    res.status(401).json({ error: "Invalid or expired auth token" });
  }
}

/**
 * Asserts that req.walletAddress matches the :address route param.
 * Prevents users from querying or acting on behalf of others.
 */
export function requireSelfOrAdmin(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const rawParam = req.params.walletAddress;
  const targetAddress = Array.isArray(rawParam)
    ? rawParam[0]?.toLowerCase()
    : rawParam?.toLowerCase();
  const callerAddress = req.walletAddress?.toLowerCase();

  if (!callerAddress || callerAddress !== targetAddress) {
    res.status(403).json({ error: "Forbidden: cannot act on behalf of another user" });
    return;
  }
  next();
}
