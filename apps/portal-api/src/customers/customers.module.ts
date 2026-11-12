import { Module } from '@nestjs/common';
import { HistoryModule } from '../history/history.module';
import { PrismaModule } from '../prisma/prisma.module';
import { CustomersController } from './customers.controller';
import { CustomersService } from './customers.service';

@Module({
  imports: [PrismaModule, HistoryModule],
  controllers: [CustomersController],
  providers: [CustomersService],
})
export class CustomersModule {}
