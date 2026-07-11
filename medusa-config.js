const { loadEnv, defineConfig } = require("@medusajs/framework/utils")

loadEnv(process.env.NODE_ENV || "development", process.cwd())

const isProduction = process.env.NODE_ENV === "production"
const adminEnabled = !isProduction || process.env.MEDUSA_ADMIN_ENABLE === "true"

// 公開網址：用 Vercel 代理網域（給 Admin / Store API 用）
const publicBackendUrl =
  process.env.MEDUSA_BACKEND_URL || "http://localhost:9000"

const storeCors =
  process.env.STORE_CORS ||
  "http://localhost:3000,https://jeko-e-sim.vercel.app"

const adminCors =
  process.env.ADMIN_CORS ||
  `http://localhost:9000,http://localhost:7001,${publicBackendUrl}`

const authCors =
  process.env.AUTH_CORS ||
  `http://localhost:3000,https://jeko-e-sim.vercel.app,${publicBackendUrl}`

module.exports = defineConfig({
  projectConfig: {
    databaseUrl: process.env.DATABASE_URL,
    redisUrl: process.env.REDIS_URL,
    ...(process.env.DATABASE_URL?.includes("supabase")
      ? {
          databaseDriverOptions: {
            ssl: { rejectUnauthorized: false },
          },
        }
      : {}),
    http: {
      storeCors,
      adminCors,
      authCors,
      jwtSecret: process.env.JWT_SECRET || "supersecret",
      cookieSecret: process.env.COOKIE_SECRET || "supersecret",
    },
  },
  admin: {
    disable: !adminEnabled,
    path: "/app",
    backendUrl: publicBackendUrl,
    maxUploadFileSize: 15 * 1024 * 1024,
  },
  modules: [
    {
      resolve: "./src/modules/push",
    },
    {
      key: "file",
      resolve: "@medusajs/medusa/file",
      options: {
        providers: [
          {
            resolve: "@medusajs/medusa/file-local",
            id: "local",
            options: {
              backend_url: `${publicBackendUrl}/static`,
            },
          },
        ],
      },
    },
  ],
})
