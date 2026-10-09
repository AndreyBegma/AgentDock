import { Logger, Module } from '@nestjs/common';
import { ENCRYPTION_KEY_ENV, SecretCipher } from './secret-cipher';

/**
 * Provides the `SecretCipher` built from `APP_ENCRYPTION_KEY`. A missing or
 * malformed key is not fatal for the API — only the features that store a
 * secret refuse to work — but it is said once at start-up, without the value.
 */
@Module({
  providers: [
    {
      provide: SecretCipher,
      useFactory: (): SecretCipher => {
        const cipher = SecretCipher.fromEnv();
        if (cipher.problem === 'malformed') {
          new Logger('SecretCipher').warn(
            `${ENCRYPTION_KEY_ENV} is not base64 of 32 bytes; features that store secrets are disabled`,
          );
        }
        return cipher;
      },
    },
  ],
  exports: [SecretCipher],
})
export class CryptoModule {}
