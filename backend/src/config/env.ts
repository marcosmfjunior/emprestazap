import "dotenv/config";

function require_env(key: string): string {
  const val = process.env[key];
  if (!val) throw new Error(`Missing required env var: ${key}`);
  return val;
}

export const env = {
  // Blockchain
  ALCHEMY_API_KEY: process.env.ALCHEMY_API_KEY ?? "",
  ALCHEMY_WEBSOCKET_URL: process.env.ALCHEMY_WEBSOCKET_URL ?? "",
  POLYGON_RPC_URL: process.env.POLYGON_RPC_URL ?? "https://polygon-rpc.com",
  LOAN_FACTORY_ADDRESS: process.env.LOAN_FACTORY_ADDRESS ?? "",
  BRZ_TOKEN_ADDRESS:
    process.env.BRZ_TOKEN_ADDRESS ??
    "0x491a4eB4f1FC3BfF8E1d2FC856a6A46663aD556f",

  // Database
  DATABASE_URL: process.env.DATABASE_URL ?? "",

  // Auth
  PRIVY_APP_ID: process.env.PRIVY_APP_ID ?? "",
  PRIVY_APP_SECRET: process.env.PRIVY_APP_SECRET ?? "",

  // On/Off-ramp
  TRANSFERO_API_KEY: process.env.TRANSFERO_API_KEY ?? "",
  TRANSFERO_API_URL:
    process.env.TRANSFERO_API_URL ?? "https://api.transfero.com/v1",

  // App
  PORT: parseInt(process.env.PORT ?? "3000", 10),
  NODE_ENV: process.env.NODE_ENV ?? "development",
  DEPLOY_BLOCK: process.env.DEPLOY_BLOCK ?? "",
  CORS_ORIGIN: process.env.CORS_ORIGIN ?? "",

  get isDev() {
    return this.NODE_ENV === "development";
  },
};
