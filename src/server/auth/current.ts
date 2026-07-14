import { cookies } from "next/headers";
import { getSession, SESSION_COOKIE_NAME } from "./session";

export async function currentSession() {
  const cookieStore = await cookies();
  return getSession(cookieStore.get(SESSION_COOKIE_NAME)?.value);
}
