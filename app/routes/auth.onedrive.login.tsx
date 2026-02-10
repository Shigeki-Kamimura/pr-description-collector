/** 
 * OneDrive OAuthログイン用のルートローダー
*/

import { redirect } from "react-router";
import { buildAuthorizeUrl, onedriveOAuthStateCookie } from "../services/onedrive-auth.server";

export async function loader() {
  const state = crypto.randomUUID();
  const headers = new Headers();
  headers.append("Set-Cookie", await onedriveOAuthStateCookie.serialize(state));
  return redirect(buildAuthorizeUrl(state), { headers });
}
