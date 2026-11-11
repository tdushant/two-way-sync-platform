import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { AccountsController } from './accounts.controller';
import { AccountsService } from './accounts.service';
import { ChangesController } from './changes.controller';
import { ChangesService } from './changes.service';
import { ContactsController } from './contacts.controller';
import { ContactsService } from './contacts.service';

@Module({
  imports: [PrismaModule],
  controllers: [AccountsController, ContactsController, ChangesController],
  providers: [AccountsService, ContactsService, ChangesService],
})
export class RecordsModule {}
