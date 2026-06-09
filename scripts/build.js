/**
 * Vercel: 只輸出 public/ → dist/（代理用，不跑 Medusa）
 * Railway / 本機: medusa build
 */
const { execSync } = require("child_process")
const fs = require("fs")
const path = require("path")

if (process.env.VERCEL === "1") {
  const dist = path.join(process.cwd(), "dist")
  const pub = path.join(process.cwd(), "public")
  fs.mkdirSync(dist, { recursive: true })
  if (fs.existsSync(pub)) {
    for (const f of fs.readdirSync(pub)) {
      fs.copyFileSync(path.join(pub, f), path.join(dist, f))
    }
  }
  console.log("Vercel proxy build: copied public/ → dist/")
} else {
  execSync("npx medusa build", { stdio: "inherit" })
  const staticSrc = path.join(process.cwd(), "static")
  const staticDest = path.join(process.cwd(), ".medusa/server/static")
  if (fs.existsSync(staticSrc)) {
    fs.cpSync(staticSrc, staticDest, { recursive: true, force: true })
    console.log("Copied static/ → .medusa/server/static/")
  }
}
