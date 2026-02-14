import type { Config } from "@react-router/dev/config";

const isDevelopment = process.env.NODE_ENV !== "production";

export default {
  // Config options...
  // Server-side render by default, to enable SPA mode set this to `false`
  ssr: true,
  // 開発時のみ single-fetch action の Origin を許可する。
  // React Router は Origin ヘッダーと Host を照合して CSRF 判定する。
  // nginx リバースプロキシ経由: localhost:5173
  // プロキシ無し直アクセス: localhost:5174 / 127.0.0.1:5174
  // ※ 127.0.0.1:5173 は nginx 側で localhost:5173 へリダイレクトされるため不要
  ...(isDevelopment
    ? {
        allowedActionOrigins: [
          "localhost:5173",
          "localhost:5174",
          "127.0.0.1:5174",
        ],
      }
    : {}),
} satisfies Config;
