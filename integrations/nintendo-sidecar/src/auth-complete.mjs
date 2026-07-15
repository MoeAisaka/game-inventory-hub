import path from "node:path";
import { completeNintendoAuthorization } from "./auth.mjs";

async function readStdin() {
  let input = "";

  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) {
    input += chunk;
  }

  return input;
}

const root = process.env.NINTENDO_ROOT_DIR ?? process.cwd();
const dataPath = process.env.NINTENDO_DATA_PATH ?? path.join(root, ".runtime", "nintendo", "nxapi");
const callback = await readStdin();

try {
  const result = await completeNintendoAuthorization({
    dataPath,
    callback,
    zncProxyUrl: process.env.NXAPI_ZNC_PROXY_URL,
  });
  console.log(JSON.stringify({
    ok: true,
    account: {
      externalUserId: result.externalUserId,
      screenName: result.screenName,
      nickname: result.nickname,
      nsoName: result.nsoName,
    },
  }));
} catch (error) {
  const code = typeof error?.code === "string" ? error.code : "NINTENDO_AUTH_COMPLETE_FAILED";
  const message = code.startsWith("NINTENDO_")
    ? error.message
    : "Nintendo 授权交换失败；请重新开始授权";
  console.error(JSON.stringify({ ok: false, error: { code, message } }));
  process.exitCode = 1;
}
