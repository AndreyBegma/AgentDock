'use client';

import { Badge } from '@andrewbehma/glass-ui/badge';
import { Banner } from '@andrewbehma/glass-ui/banner';
import { Button } from '@andrewbehma/glass-ui/button';
import { Card } from '@andrewbehma/glass-ui/card';
import { CodeBlock } from '@andrewbehma/glass-ui/code-block';
import { Field, Input } from '@andrewbehma/glass-ui/field';
import { SectionHeader } from '@andrewbehma/glass-ui/section-header';
import { Skeleton } from '@andrewbehma/glass-ui/skeleton';
import { toast } from '@andrewbehma/glass-ui/toast';
import type {
  RecoveryCodesResponse,
  TwoFactorConfirmRequest,
  TwoFactorEnableRequest,
  TwoFactorSetupRequest,
  TwoFactorSetupResponse,
  TwoFactorStatus,
} from '@nautelle/shared';
import { useRouter } from 'next/navigation';
import { type FormEvent, useState } from 'react';
import { AsyncSection } from '../../components/prerequisites/async-section';
import { api, describeError } from '../../lib/api';
import { type Section, useSection } from '../../lib/section/use-section';

const CODE_HINT =
  'The six digits from your authenticator app, or one of your recovery codes.';

/**
 * C-189: TOTP two-factor sign-in for the signed-in account — set up, confirm
 * with a first code, new recovery codes and turning it off.
 */
export function TwoFactorCard() {
  const status = useSection(
    () => api<TwoFactorStatus>('/auth/me/two-factor'),
    [],
  );
  // Shown once, right after they are made; the server keeps only hashes.
  const [recoveryCodes, setRecoveryCodes] = useState<string[]>();

  return (
    <Card pad="lg">
      <SectionHeader
        className="mb-4"
        title="Two-factor sign-in"
        description="After your password, sign-in also asks for a code from an authenticator app on your phone."
      />
      {recoveryCodes ? (
        <RecoveryCodes
          codes={recoveryCodes}
          onDone={() => setRecoveryCodes(undefined)}
        />
      ) : (
        <AsyncSection
          section={status}
          unavailable={{
            title: 'Two-factor sign-in could not be loaded',
            stillWorks: 'Signing in works as before.',
          }}
          empty={null}
          skeleton={<Skeleton className="h-24 w-full" />}
        >
          {(data) =>
            data.enabled ? (
              <Enabled
                status={data}
                section={status}
                onCodes={setRecoveryCodes}
              />
            ) : (
              <Setup
                required={data.required}
                section={status}
                onCodes={setRecoveryCodes}
              />
            )
          }
        </AsyncSection>
      )}
    </Card>
  );
}

function RecoveryCodes({
  codes,
  onDone,
}: {
  codes: string[];
  onDone: () => void;
}) {
  return (
    <div className="flex flex-col gap-4">
      <Banner tone="warn" title="Save these recovery codes now">
        Each one signs you in once if you lose your phone. They are not shown
        again.
      </Banner>
      <CodeBlock code={codes.join('\n')} className="max-w-sm" />
      <div>
        <Button variant="solid" onClick={onDone}>
          I have saved them
        </Button>
      </div>
    </div>
  );
}

function Setup({
  required,
  section,
  onCodes,
}: {
  required: boolean;
  section: Section<TwoFactorStatus>;
  onCodes: (codes: string[]) => void;
}) {
  const router = useRouter();
  const [password, setPassword] = useState('');
  const [offer, setOffer] = useState<TwoFactorSetupResponse>();
  const [code, setCode] = useState('');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  const begin = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      const body: TwoFactorSetupRequest = { password };
      setOffer(
        await api<TwoFactorSetupResponse>('/auth/me/two-factor/setup', {
          method: 'POST',
          body,
        }),
      );
      setPassword('');
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };

  const confirm = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      const body: TwoFactorEnableRequest = { code };
      const { recoveryCodes } = await api<RecoveryCodesResponse>(
        '/auth/me/two-factor/enable',
        { method: 'POST', body },
      );
      onCodes(recoveryCodes);
      section.retry();
      // The layouts read the policy gate on the server.
      router.refresh();
      toast.success(
        'Two-factor sign-in is on. Your other sessions were signed out.',
      );
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      {required ? (
        <Banner tone="warn" title="Required for administrators">
          This server requires two-factor sign-in of every administrator. Set it
          up to use the rest of Nautelle.
        </Banner>
      ) : (
        <div>
          <Badge tone="neutral" label="Off" />
        </div>
      )}
      {offer ? (
        <form onSubmit={confirm} className="flex max-w-md flex-col gap-4">
          <p className="text-sm text-ink-2">
            Add this key to your authenticator app, or{' '}
            <a href={offer.otpauthUrl} className="text-accent-ink underline">
              open it in the app
            </a>{' '}
            on this device. Then enter the code it shows.
          </p>
          <CodeBlock code={offer.secret} />
          <Field label="Code" htmlFor="totp-enable-code" error={error}>
            <Input
              id="totp-enable-code"
              inputMode="numeric"
              autoComplete="one-time-code"
              required
              maxLength={64}
              value={code}
              onChange={(e) => setCode(e.target.value)}
            />
          </Field>
          <div>
            <Button type="submit" variant="solid" disabled={busy}>
              Turn on
            </Button>
          </div>
        </form>
      ) : (
        <form onSubmit={begin} className="flex max-w-sm flex-col gap-4">
          <Field label="Password" htmlFor="totp-setup-password" error={error}>
            <Input
              id="totp-setup-password"
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </Field>
          <div>
            <Button type="submit" variant="solid" disabled={busy}>
              Set up
            </Button>
          </div>
        </form>
      )}
    </div>
  );
}

function Enabled({
  status,
  section,
  onCodes,
}: {
  status: TwoFactorStatus;
  section: Section<TwoFactorStatus>;
  onCodes: (codes: string[]) => void;
}) {
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  const run = async (action: 'disable' | 'recovery-codes') => {
    setBusy(true);
    setError(undefined);
    try {
      const body: TwoFactorConfirmRequest = { password, code };
      if (action === 'disable') {
        await api(`/auth/me/two-factor/disable`, { method: 'POST', body });
        toast.success('Two-factor sign-in is off.');
      } else {
        const { recoveryCodes } = await api<RecoveryCodesResponse>(
          '/auth/me/two-factor/recovery-codes',
          { method: 'POST', body },
        );
        onCodes(recoveryCodes);
      }
      setPassword('');
      setCode('');
      section.retry();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2 text-sm text-ink-2">
        <Badge tone="ok" label="On" />
        <span>
          {status.recoveryCodesLeft} recovery code
          {status.recoveryCodesLeft === 1 ? '' : 's'} left
        </span>
      </div>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void run('recovery-codes');
        }}
        className="flex max-w-sm flex-col gap-4"
      >
        <Field label="Password" htmlFor="totp-confirm-password">
          <Input
            id="totp-confirm-password"
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </Field>
        <Field
          label="Code"
          htmlFor="totp-confirm-code"
          hint={CODE_HINT}
          error={error}
        >
          <Input
            id="totp-confirm-code"
            autoComplete="one-time-code"
            required
            maxLength={64}
            value={code}
            onChange={(e) => setCode(e.target.value)}
          />
        </Field>
        <div className="flex flex-wrap gap-2">
          <Button type="submit" variant="glass" disabled={busy}>
            New recovery codes
          </Button>
          <Button
            type="button"
            variant="danger"
            disabled={busy || status.required}
            title={
              status.required
                ? 'This server requires two-factor sign-in of administrators'
                : undefined
            }
            onClick={(event) => {
              const form = event.currentTarget.form;
              if (form && !form.reportValidity()) return;
              void run('disable');
            }}
          >
            Turn off
          </Button>
        </div>
      </form>
    </div>
  );
}
