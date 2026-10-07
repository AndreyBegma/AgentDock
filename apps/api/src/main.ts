import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { configureApp } from './configure-app';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  configureApp(app);

  const port = process.env.PORT ?? 8180;
  await app.listen(port);
  console.log(`API running on http://localhost:${port}`);
}

bootstrap();
