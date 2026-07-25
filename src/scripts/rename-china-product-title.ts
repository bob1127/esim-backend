import { ExecArgs } from "@medusajs/framework/types";
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils";

/** 更新中國商品外層標題（主標） */
export default async function renameChinaProductTitle({ container }: ExecArgs) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER);
  const productModule = container.resolve(Modules.PRODUCT);

  const handle = "china-unlimited-esim";
  const newTitle = "中國大陸 eSIM – 支援 TikTok 與 ChatGPT";

  const products = await productModule.listProducts({ handle }, { take: 1 });
  if (!products.length) {
    throw new Error(`找不到商品 handle=${handle}`);
  }

  const updated = await productModule.updateProducts(products[0].id, {
    title: newTitle,
    subtitle: "漫遊線路・CMCC+・5G 極速・支援熱點",
  });

  logger.info(`已更新：${updated.id} → ${updated.title}`);
}
