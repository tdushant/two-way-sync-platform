import { Module } from '@nestjs/common';
import { Ids, RandomIds } from '../records/ids';
import { PrismaService } from './prisma.service';

@Module({
  providers: [PrismaService, { provide: Ids, useClass: RandomIds }],
  exports: [PrismaService, Ids],
})
export class PrismaModule {}
