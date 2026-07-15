import path from "node:path";
import { startNintendoAuthorization } from "./auth.mjs";

const root = process.env.NINTENDO_ROOT_DIR ?? process.cwd();
const dataPath = process.env.NINTENDO_DATA_PATH ?? path.join(root, ".runtime", "nintendo", "nxapi");

const result = await startNintendoAuthorization({ dataPath });
console.log(`授权批次：${result.batchId}`);
console.log("请在 30 分钟内打开以下 Nintendo 登录地址：");
console.log(result.authoriseUrl);
console.log("");
console.log("完成登录后，请复制以 npf71b963c1b7b6d119://auth 开头的完整链接。不要复制浏览器地址栏中的 authorize 地址。");
