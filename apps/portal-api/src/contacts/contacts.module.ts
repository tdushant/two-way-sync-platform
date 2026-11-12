import { Module } from '@nestjs/common';
import { HistoryModule } from '../history/history.module';
import { PrismaModule } from '../prisma/prisma.module';
import { ContactsController } from './contacts.controller';
import { ContactsService } from './contacts.service';

@Module({
  imports: [PrismaModule, HistoryModule],
  controllers: [ContactsController],
  providers: [ContactsService],
})
export class ContactsModule {}
