import { reactRouter } from "@react-router/dev/vite";
import { defineConfig, loadEnv } from "vite";
import tsconfigPaths from "vite-tsconfig-paths";

// ポート番号を解析する
function parsePort(value: string | undefined): number {
  const parsed = Number.parseInt(value ?? "", 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return 5174;
  return parsed;
}

// Vite設定
export default defineConfig(({ mode }) => {
  // 環境変数読み込み
  const env = loadEnv(mode, process.cwd(), "");
  // サーバー設定
  const host = env.DEV_SERVER_HOST || "localhost";
  // ポート設定
  const port = parsePort(env.DEV_SERVER_PORT);

  // Vite設定を返す
  return {
    plugins: [reactRouter(), tsconfigPaths()],
    server: {
      host,
      port,
      strictPort: true,
    },
  };
});
