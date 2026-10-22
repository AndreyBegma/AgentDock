# ADR-0081: TOTP two-factor sign-in with hashed recovery codes, optionally required of admins

Status: accepted · Date: 2026-10-22 ·
Card: C-189 (security audit decision D-05) ·
Spec: [`docs/specs/card-189-security-medium-add-totp-two-factor-auth.md`](../specs/card-189-security-medium-add-totp-two-factor-auth.md) ·
Amends: [ADR-0008](0008-local-accounts-with-admin-approved-registration.md) (2FA was deferred)

## Context

An account was protected by its password alone. ADR-0048 (D-05) answered guessing with a growing wait per (email, IP) and no hard lock, and left a second factor to a later card. An admin can start agents on the owner's machines, so a leaked admin password is the most expensive one to lose.

## Decision

1. **TOTP, RFC 6238 defaults.** HMAC-SHA1, 30-second steps, six digits — the only parameters every authenticator app supports. A code from one step either side of the server's is accepted for clock drift. The secret is 20 random bytes, shown once as base32 and as an `otpauth://` URL.
2. **The secret is sealed.** `users.totpSecret` (and the unconfirmed `totpPendingSecret`) are encrypted with `APP_ENCRYPTION_KEY` through `SecretCipher`, like the other stored secrets. Without the key, setup and sign-in with a code answer 503 `two_factor_unavailable`; accounts without two-factor sign-in are unaffected.
3. **Enrolment is two steps.** `POST /auth/me/two-factor/setup` takes the password and offers a new secret; it is not in force until `POST /auth/me/two-factor/enable` receives a code from it. Enabling signs the account's other sessions out, as a password change does.
4. **No replay.** `users.totpLastStep` records the step of the last accepted code; only a later step counts. The update is conditional, so two requests racing with the same code cannot both pass.
5. **Recovery codes.** Enabling returns ten codes, shown once. Each carries 80 random bits (`XXXX-XXXX-XXXX-XXXX`, base32) and is stored only as SHA-256 of its normalised form in `user_recovery_codes`. With 80 bits a fast hash cannot be reversed by search, so no slow hash is needed. A code is spent by a conditional update of `usedAt`, so it works exactly once. New codes (password and code) replace the whole set.
6. **One login request.** `POST /auth/login` takes an optional `code`. The password is checked first, under the ADR-0048 wait; an enrolled account without a code gets 401 `two_factor_required`, and the web form then asks for the code and sends all three. A wrong code counts as a failure for the same (email, IP) wait and is audited as a denied login with reason `two_factor_invalid`. The failure counter is cleared only after both factors pass, so a right password cannot reset the wait between code guesses. No half-signed-in session exists.
7. **Turning it off needs the password and a code** (`POST /auth/me/two-factor/disable`), both under the same wait.
8. **Optionally required of admins.** The instance setting `auth.two_factor.required_for_admins` (off by default, `PUT /admin/settings/two-factor`) makes `SessionGuard` answer 403 `two_factor_setup_required` to an admin without two-factor sign-in on every route outside `/auth`. The admin can still sign in, so they can enrol; `GET /auth/me` carries `twoFactorSetupRequired` and the web layouts send them to Account. While it is on, an admin cannot turn their own off.
9. **Admin reset.** `DELETE /admin/users/:id/two-factor` turns off another user's two-factor sign-in, for someone who lost both the phone and the codes; it is audited as `user.two_factor_reset`. An admin cannot reset their own.
10. **Telegram Mini App sign-in stays as it is.** It proves a linked Telegram chat, not a password, and opens a session of its own ([ADR-0055](0055-a-telegram-mini-app-signs-in-with-its-init-data.md)); it does not ask for a code. The admin requirement of item 8 still applies to that session.
11. **Out of scope:** remember-this-device, WebAuthn, and a QR code in the web app — glass-ui has no QR component yet, so Account shows the key and the `otpauth://` link.

## Consequences

- A stolen password alone no longer signs in to an enrolled account.
- Losing the phone and the recovery codes needs an admin; losing them as the only admin needs the database (clear the `totp*` columns of `users`).
- `APP_ENCRYPTION_KEY` becomes a dependency of sign-in for enrolled accounts: rotating or losing it locks them out of the second factor until an admin resets them.
- Every audited action list gains `auth.two_factor_enable`, `auth.two_factor_disable`, `auth.two_factor_recovery_codes`, `user.two_factor_reset` and `settings.two_factor`.
