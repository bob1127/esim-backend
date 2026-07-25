import {
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3"
import { Upload } from "@aws-sdk/lib-storage"
import { getSignedUrl } from "@aws-sdk/s3-request-presigner"
import {
  AbstractFileProviderService,
  MedusaError,
} from "@medusajs/framework/utils"
import path from "path"
import { PassThrough, Readable } from "stream"
import { ulid } from "ulid"

const DEFAULT_UPLOAD_EXPIRATION_DURATION_SECONDS = 60 * 60

const MIME_EXT: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/jpg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "image/gif": ".gif",
}

/** R2 object key 避免中文／空白（與本機 /static 檔名問題相同） */
function buildSafeFileKey(
  prefix: string,
  filename: string,
  mimeType?: string
): string {
  const ext = path.extname(filename).toLowerCase()
  const safeExt =
    /^\.[a-z0-9]{1,8}$/.test(ext) ? ext : MIME_EXT[mimeType || ""] || ".jpg"
  return `${prefix}${ulid()}${safeExt}`
}

function publicFileUrl(baseUrl: string, fileKey: string): string {
  return `${baseUrl}/${fileKey.split("/").map(encodeURIComponent).join("/")}`
}

type R2S3Options = {
  file_url: string
  access_key_id?: string
  secret_access_key?: string
  authentication_method?: "access-key" | "default"
  region: string
  bucket: string
  prefix?: string
  endpoint?: string
  cache_control?: string
  download_file_duration?: number
  additional_client_config?: Record<string, unknown>
}

/**
 * Cloudflare R2（S3 相容）。
 * 官方 @medusajs/file-s3 會送 ACL；R2 不接受 ACL，故用此 provider。
 */
export class R2S3FileService extends AbstractFileProviderService {
  static identifier = "r2-s3"

  protected config_: {
    fileUrl: string
    accessKeyId?: string
    secretAccessKey?: string
    authenticationMethod: string
    region: string
    bucket: string
    prefix: string
    endpoint?: string
    cacheControl: string
    downloadFileDuration: number
    additionalClientConfig: Record<string, unknown>
  }

  protected client_: S3Client
  protected logger_: { error: (e: unknown) => void }

  constructor(
    { logger }: { logger: { error: (e: unknown) => void } },
    options: R2S3Options
  ) {
    super()
    const authenticationMethod = options.authentication_method ?? "access-key"

    if (
      authenticationMethod === "access-key" &&
      (!options.access_key_id || !options.secret_access_key)
    ) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        "S3_ACCESS_KEY_ID 與 S3_SECRET_ACCESS_KEY 為必填（Cloudflare R2 → Manage R2 API Tokens）"
      )
    }

    if (!options.file_url || !options.bucket || !options.endpoint) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        "S3_FILE_URL、S3_BUCKET、S3_ENDPOINT 為必填"
      )
    }

    this.config_ = {
      fileUrl: options.file_url.replace(/\/$/, ""),
      accessKeyId: options.access_key_id,
      secretAccessKey: options.secret_access_key,
      authenticationMethod,
      region: options.region || "auto",
      bucket: options.bucket,
      prefix: options.prefix ?? "",
      endpoint: options.endpoint,
      cacheControl: options.cache_control ?? "public, max-age=31536000",
      downloadFileDuration: options.download_file_duration ?? 60 * 60,
      additionalClientConfig: options.additional_client_config ?? {},
    }
    this.logger_ = logger
    this.client_ = this.getClient()
  }

  getClient() {
    const credentials =
      this.config_.authenticationMethod === "access-key"
        ? {
            accessKeyId: this.config_.accessKeyId!,
            secretAccessKey: this.config_.secretAccessKey!,
          }
        : undefined

    return new S3Client({
      credentials,
      region: this.config_.region,
      endpoint: this.config_.endpoint,
      ...this.config_.additionalClientConfig,
    })
  }

  async upload(file: {
    filename?: string
    content: string
    mimeType?: string
  }) {
    if (!file?.filename) {
      throw new MedusaError(MedusaError.Types.INVALID_DATA, "No filename provided")
    }

    const fileKey = buildSafeFileKey(
      this.config_.prefix,
      file.filename,
      file.mimeType
    )

    let content: Buffer
    try {
      const decoded = Buffer.from(file.content, "base64")
      content =
        decoded.toString("base64") === file.content
          ? decoded
          : Buffer.from(file.content, "utf8")
    } catch {
      content = Buffer.from(file.content, "binary")
    }

    const command = new PutObjectCommand({
      Bucket: this.config_.bucket,
      Body: content,
      Key: fileKey,
      ContentType: file.mimeType,
      CacheControl: this.config_.cacheControl,
      Metadata: {
        "original-filename": encodeURIComponent(file.filename),
      },
    })

    try {
      await this.client_.send(command)
    } catch (e) {
      this.logger_.error(e)
      throw e
    }

    return {
      url: publicFileUrl(this.config_.fileUrl, fileKey),
      key: fileKey,
    }
  }

  async getUploadStream(fileData: { filename?: string; mimeType?: string }) {
    if (!fileData.filename) {
      throw new MedusaError(MedusaError.Types.INVALID_DATA, "No filename provided")
    }

    const fileKey = buildSafeFileKey(
      this.config_.prefix,
      fileData.filename,
      fileData.mimeType
    )
    const pass = new PassThrough()

    const upload = new Upload({
      client: this.client_,
      params: {
        Bucket: this.config_.bucket,
        Key: fileKey,
        Body: pass,
        ContentType: fileData.mimeType,
        CacheControl: this.config_.cacheControl,
        Metadata: {
          "original-filename": encodeURIComponent(fileData.filename),
        },
      },
    })

    const promise = upload.done().then(() => ({
      url: publicFileUrl(this.config_.fileUrl, fileKey),
      key: fileKey,
    }))

    return {
      writeStream: pass,
      promise,
      url: publicFileUrl(this.config_.fileUrl, fileKey),
      fileKey,
    }
  }

  async delete(files: { fileKey: string } | { fileKey: string }[]) {
    try {
      if (Array.isArray(files)) {
        await this.client_.send(
          new DeleteObjectsCommand({
            Bucket: this.config_.bucket,
            Delete: {
              Objects: files.map((file) => ({ Key: file.fileKey })),
              Quiet: true,
            },
          })
        )
      } else {
        await this.client_.send(
          new DeleteObjectCommand({
            Bucket: this.config_.bucket,
            Key: files.fileKey,
          })
        )
      }
    } catch (e) {
      this.logger_.error(e)
    }
  }

  async getPresignedDownloadUrl(fileData: { fileKey: string }) {
    const command = new GetObjectCommand({
      Bucket: this.config_.bucket,
      Key: fileData.fileKey,
    })
    return getSignedUrl(this.client_, command, {
      expiresIn: this.config_.downloadFileDuration,
    })
  }

  async getPresignedUploadUrl(fileData: {
    filename?: string
    mimeType?: string
    expiresIn?: number
  }) {
    if (!fileData?.filename) {
      throw new MedusaError(MedusaError.Types.INVALID_DATA, "No filename provided")
    }

    const fileKey = buildSafeFileKey(
      this.config_.prefix,
      fileData.filename,
      fileData.mimeType
    )
    const command = new PutObjectCommand({
      Bucket: this.config_.bucket,
      ContentType: fileData.mimeType,
      Key: fileKey,
    })

    const signedUrl = await getSignedUrl(this.client_, command, {
      expiresIn:
        fileData.expiresIn ?? DEFAULT_UPLOAD_EXPIRATION_DURATION_SECONDS,
    })

    return { url: signedUrl, key: fileKey }
  }

  async getDownloadStream(file: { fileKey?: string }) {
    if (!file?.fileKey) {
      throw new MedusaError(MedusaError.Types.INVALID_DATA, "No fileKey provided")
    }
    const response = await this.client_.send(
      new GetObjectCommand({
        Key: file.fileKey,
        Bucket: this.config_.bucket,
      })
    )
    return response.Body as Readable
  }

  async getAsBuffer(file: { fileKey?: string }) {
    if (!file?.fileKey) {
      throw new MedusaError(MedusaError.Types.INVALID_DATA, "No fileKey provided")
    }
    const response = await this.client_.send(
      new GetObjectCommand({
        Key: file.fileKey,
        Bucket: this.config_.bucket,
      })
    )
    return Buffer.from(await response.Body!.transformToByteArray())
  }
}

export default R2S3FileService
