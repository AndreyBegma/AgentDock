import { INestApplication, ValidationPipe } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';

/** Parses `TRUST_PROXY` into Express's `trust proxy` value. */
export const trustProxySetting = (
  value: string | undefined,
): boolean | number | string => {
  if (value === undefined || value === '') return 'loopback';
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (/^\d+$/.test(value)) return Number(value);
  return value;
};

/** Middleware and pipes shared by `main.ts` and the e2e tests. */
export const configureApp = (app: INestApplication): void => {
  (app as NestExpressApplication).set(
    'trust proxy',
    trustProxySetting(process.env.TRUST_PROXY),
  );

  app.use(helmet());
  app.use(cookieParser());
  app.enableCors({
    origin: process.env.WEB_URL ?? 'http://localhost:3517',
    credentials: true,
  });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: true,
    }),
  );
};
