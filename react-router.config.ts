import type { Config } from "@react-router/dev/config";

export default {
  // Config options...
  // Server-side render by default, to enable SPA mode set this to `false`
  ssr: true,
  // Nginx(5173)経由の開発時、single-fetch action の Origin チェックを通す
  allowedActionOrigins: [
    "localhost:5173",
    "127.0.0.1:5173",
    "localhost:5174",
    "127.0.0.1:5174",
  ],
} satisfies Config;
