import { INestApplication, ValidationPipe } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { WsAdapter } from '@nestjs/platform-ws';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { rawBodyMiddleware } from './webhooks/common/raw-body';

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

  // The runner gateway (`/runner`) shares the API's port: plain `ws`, no socket.io.
  app.useWebSocketAdapter(new WsAdapter(app));

  app.use(helmet());
  app.use(cookieParser());
  // Before Nest's body parsers (registered at `init`): signed webhook routes
  // keep their exact bytes and are parsed only after verification (spec 26 D8).
  app.use(rawBodyMiddleware());
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
