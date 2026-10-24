import { Logger } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { ensureSecretKeys, SecretKeysError } from './common/crypto/secret-keys';
import { configureApp } from './configure-app';

async function bootstrap() {
  // `.env` is in process.env once AppModule's ConfigModule has loaded it; the
  // keys go in after it and before any module reads them (C-366).
  await ConfigModule.envVariablesLoaded;
  const logger = new Logger('SecretKeys');
  try {
    ensureSecretKeys(process.env, (message) => logger.log(message));
  } catch (error) {
    if (!(error instanceof SecretKeysError)) throw error;
    logger.error(error.message);
    process.exit(1);
  }

  const app = await NestFactory.create(AppModule);
  configureApp(app);

  const port = process.env.PORT ?? 8180;
  await app.listen(port);
  console.log(`API running on http://localhost:${port}`);
}

bootstrap();
