import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { NONCE_HEADER } from '../../security-headers';
import { MiniAppSignIn } from './mini-app-sign-in';

export const metadata: Metadata = { title: 'Telegram' };

/**
 * #580: the Telegram Mini App's entry. Public — Telegram's signed `initData`
 * is the credential — and outside the app shell until it has signed in.
 */
export default async function TelegramMiniAppPage() {
  const nonce = (await headers()).get(NONCE_HEADER) ?? undefined;
  return <MiniAppSignIn nonce={nonce} />;
}
