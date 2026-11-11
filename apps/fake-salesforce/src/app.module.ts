import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { validateFakeSalesforceEnv } from './env';
import { HealthModule } from './health/health.module';
import { logging } from './logging';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['.env', '../../.env'],
      ignoreEnvFile: process.env.NODE_ENV === 'test',
      validate: validateFakeSalesforceEnv,
    }),
    logging,
    HealthModule,
  ],
})
export class AppModule {}
