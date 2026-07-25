const { loadEnv, defineConfig } = require("@medusajs/framework/utils")

loadEnv(process.env.NODE_ENV || "development", process.cwd())

const isProduction = process.env.NODE_ENV === "production"
const adminEnabled = !isProduction || process.env.MEDUSA_ADMIN_ENABLE === "true"

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

const useR2 =
  Boolean(process.env.S3_BUCKET?.trim()) &&
  Boolean(process.env.S3_ENDPOINT?.trim()) &&
  Boolean(process.env.S3_FILE_URL?.trim()) &&
  Boolean(process.env.S3_ACCESS_KEY_ID?.trim()) &&
  Boolean(process.env.S3_SECRET_ACCESS_KEY?.trim())

const fileProvider = useR2
  ? {
      resolve: "./src/providers/r2-s3",
      id: "r2-s3",
      options: {
        file_url: process.env.S3_FILE_URL,
        access_key_id: process.env.S3_ACCESS_KEY_ID,
        secret_access_key: process.env.S3_SECRET_ACCESS_KEY,
        region: process.env.S3_REGION || "auto",
        bucket: process.env.S3_BUCKET,
        endpoint: process.env.S3_ENDPOINT,
        prefix: process.env.S3_PREFIX || "",
        additional_client_config: {
          forcePathStyle: true,
        },
      },
    }
  : {
      resolve: "@medusajs/medusa/file-local",
      id: "local",
      options: {
        backend_url: `${publicBackendUrl}/static`,
      },
    }

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
        providers: [fileProvider],
      },
    },
    {
      key: "payment",
      resolve: "@medusajs/medusa/payment",
      options: {
        providers: [
          {
            resolve: "./src/modules/newebpay",
            id: "newebpay",
            options: {},
          },
        ],
      },
    },
  ],
})
