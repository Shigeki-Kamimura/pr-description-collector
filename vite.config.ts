import { existsSync, readFileSync } from "node:fs";
import { reactRouter } from "@react-router/dev/vite";
import { defineConfig, loadEnv } from "vite";
import tsconfigPaths from "vite-tsconfig-paths";

// 環境変数の真偽値を判定する
function isTrue(value: string | undefined): boolean {
  if (!value) return false;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

// ポート番号を解析する
function parsePort(value: string | undefined): number {
  const parsed = Number.parseInt(value ?? "", 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return 5173;
  return parsed;
}

// Vite設定
export default defineConfig(({ mode }) => {
  // 環境変数読み込み
  const env = loadEnv(mode, process.cwd(), "");
  // HTTPS設定
  const devHttpsEnabled = isTrue(env.DEV_HTTPS);
  // サーバー設定
  const host = env.DEV_SERVER_HOST || "localhost";
  // ポート設定
  const port = parsePort(env.DEV_SERVER_PORT);
  let https: { key: Buffer; cert: Buffer } | undefined;

  // HTTPS開発モード設定
  if (devHttpsEnabled) {
    // キーと証明書のパスを取得
    const keyPath = env.DEV_HTTPS_KEY_PATH;
    const certPath = env.DEV_HTTPS_CERT_PATH;
    // キーと証明書の存在を確認して読み込み
    if (!keyPath || !certPath) {
      throw new Error(
        "DEV_HTTPS=true の場合は DEV_HTTPS_KEY_PATH と DEV_HTTPS_CERT_PATH の設定が必要です。",
      );
    }
    // ファイルの存在確認
    if (!existsSync(keyPath) || !existsSync(certPath)) {
      throw new Error(`HTTPS証明書ファイルが見つかりません: key=${keyPath}, cert=${certPath}`);
    }
    // キーと証明書を読み込み
    https = {
      key: readFileSync(keyPath),
      cert: readFileSync(certPath),
    };
  }

  // Vite設定を返す
  return {
    plugins: [reactRouter(), tsconfigPaths()],
    server: {
      host,
      port,
      strictPort: true,
      https,
    },
  };
});
